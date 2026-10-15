import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const DAYS_40 = 40 * 86_400_000;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Entry = { path: string; sha256: string; expiresAt: string; evidenceRefHashes: string[] };
type Index = { schemaVersion: 'diagnostic-retention-v0.1'; entries: Entry[]; withdrawnRefHashes: string[] };
const metadataFiles = new Set(['summary.json', 'ledger.json', 'budget.json', 'attempts.jsonl', 'reservations.jsonl',
  'evaluation-review.json', 'preflight.json', 'diagnostic-retention-index.json', 'diagnostic-deletion-receipts.jsonl']);
const refKeys = new Set(['evidenceId', 'evidenceRef', 'evidenceRefs', 'sourceEvidenceRefs', 'inputRef',
  'previousCompletedUserEvidenceRef', 'previousCompletedEvidenceRef']);
const contentKeys = new Set(['text', 'input', 'transcript', 'transcriptText', 'expectedText', 'normalizedClaim',
  'base64Audio', 'pcm16Base64', 'output', 'content', 'sourceSpans', 'quote', 'query',
  'value', 'questions', 'currentInput', 'allowedMemory', 'suggestedText', 'frozenPolicyText']);
function hasContent(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && Object.entries(value)
    .some(([key, child]) => contentKeys.has(key) || hasContent(child)));
}
function withoutContent(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutContent);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !contentKeys.has(key))
    .map(([key, child]) => [key, withoutContent(child)]));
}
function sourceRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return refs;
  for (const [key, child] of Object.entries(value)) {
    if (refKeys.has(key)) {
      for (const ref of Array.isArray(child) ? child : [child]) if (typeof ref === 'string' && ref.startsWith('evidence')) refs.add(ref);
    } else sourceRefs(child, refs);
  }
  return refs;
}

/** Local diagnostic copies are disposable; no-content result/budget summaries remain. */
export function createDiagnosticRetention(root: string, deadlineFor: (ref: string) => string | null,
  now = () => Date.now()) {
  const directory = join(root, 'http-current');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexPath = join(directory, 'diagnostic-retention-index.json');
  const receiptPath = join(directory, 'diagnostic-deletion-receipts.jsonl');
  const lockPath = join(directory, 'diagnostic-retention.lock');
  // Sweeps are maintenance work and may be skipped when another runtime is
  // already scanning the same directory. A withdrawal is a user-visible
  // privacy operation, so it waits briefly and then fails explicitly rather
  // than silently dropping the request.
  const LOCK_RETRY_MS = 10;
  const WITHDRAW_LOCK_WAIT_MS = 2_000;
  const emptyIndex = (): Index => ({ schemaVersion: 'diagnostic-retention-v0.1', entries: [], withdrawnRefHashes: [] });
  const safePath = (path: string) => {
    if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error('invalid_diagnostic_retention_path');
    return join(root, path);
  };
  const validateIndex = (value: unknown): Index => {
    if (!value || typeof value !== 'object') throw new Error('invalid_diagnostic_retention_index');
    const index = value as Partial<Index>;
    if (index.schemaVersion !== 'diagnostic-retention-v0.1' || !Array.isArray(index.entries)
      || !Array.isArray(index.withdrawnRefHashes)
      || index.withdrawnRefHashes.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/u.test(ref))) {
      throw new Error('invalid_diagnostic_retention_index');
    }
    for (const entry of index.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        throw new Error('invalid_diagnostic_retention_entry');
      }
      safePath(entry.path);
      if (!/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isFinite(Date.parse(entry.expiresAt))
        || !Array.isArray(entry.evidenceRefHashes)
        || entry.evidenceRefHashes.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/u.test(ref))) {
        throw new Error('invalid_diagnostic_retention_entry');
      }
    }
    return { schemaVersion: 'diagnostic-retention-v0.1', entries: index.entries, withdrawnRefHashes: index.withdrawnRefHashes };
  };
  const readIndex = (): Index => existsSync(indexPath)
    ? validateIndex(JSON.parse(readFileSync(indexPath, 'utf8'))) : emptyIndex();
  const initial = readIndex();
  const entries = new Map(initial.entries.map(entry => [entry.path, entry]));
  const withdrawn = new Set(initial.withdrawnRefHashes);
  const reload = () => {
    const latest = readIndex();
    entries.clear();
    for (const entry of latest.entries) entries.set(entry.path, entry);
    withdrawn.clear();
    for (const ref of latest.withdrawnRefHashes) withdrawn.add(ref);
  };
  const atomicWrite = (path: string, value: string) => {
    // A shared fixed `${path}.tmp` lets another runtime rename the file out
    // from under this writer. A per-write temp name keeps each rename
    // independent while retaining atomic replacement of the final file.
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, value, { mode: 0o600 });
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };
  const persist = () => {
    atomicWrite(indexPath, JSON.stringify({ schemaVersion: 'diagnostic-retention-v0.1',
      entries: [...entries.values()], withdrawnRefHashes: [...withdrawn] }));
  };
  /**
   * Serialize read/scan/delete/write as one critical section. Each store
   * instance may have been created from an older snapshot, so reload while the
   * lock is held before applying its changes. A failed acquisition is fail
   * closed: the caller can retry without overwriting another writer's index.
   */
  const sleep = (milliseconds: number) => {
    if (milliseconds <= 0) return;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
  };
  const acquireLock = (waitMs: number): number | null => {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (true) {
      try { return openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        // Only an existing lock means that another retention worker currently
        // owns the critical section. Permission, path, descriptor and other
        // filesystem failures must remain visible to the caller; treating
        // them as contention would silently skip maintenance or misreport a
        // privacy withdrawal as a lock timeout.
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) return null;
        sleep(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
      }
    }
  };
  const withLock = <T>(operation: () => T, options: { waitMs: number; skipIfBusy?: boolean }): T | null => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = acquireLock(options.waitMs);
    if (descriptor === null) {
      if (options.skipIfBusy) return null;
      throw new Error('diagnostic_retention_lock_unavailable');
    }
    try {
      reload();
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
  };
  const scan = (directoryPath: string) => {
    for (const item of readdirSync(directoryPath, { withFileTypes: true })) {
      const path = join(directoryPath, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (path === join(directory, 'content') || item.name === 'evaluation-only') continue;
        scan(path); continue;
      }
      if (!item.isFile() || !/\.(?:json|jsonl|mp3|pcm|wav)$/u.test(item.name)
        || ['budget.json', 'diagnostic-retention-index.json', 'diagnostic-deletion-receipts.jsonl'].includes(item.name)) continue;
      const bytes = readFileSync(path); const digest = hash(bytes); const rel = relative(root, path);
      const previous = entries.get(rel);
      if (previous?.sha256 === digest) continue;
      let refs = new Set<string>();
      let parsedValues: unknown[] | null = null;
      if (/\.jsonl?$/u.test(item.name)) {
        const text = bytes.toString('utf8');
        try {
          parsedValues = item.name.endsWith('.jsonl') ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(text)];
          for (const value of parsedValues) {
            sourceRefs(value, refs);
          }
        } catch { /* An incomplete diagnostic write is still bounded by its file deadline. */ }
      }
      if (metadataFiles.has(item.name) && parsedValues && !parsedValues.some(hasContent)) continue;
      if (/\.(?:mp3|pcm|wav)$/u.test(item.name)) {
        for (const sibling of ['result.json', 'turn.json']) {
          const resultPath = join(directoryPath, sibling);
          if (existsSync(resultPath)) {
            try { sourceRefs(JSON.parse(readFileSync(resultPath, 'utf8')), refs); } catch { /* partial write */ }
          }
        }
      }
      const stat = statSync(path);
      const originalCreated = Math.min(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs, stat.mtimeMs);
      const deadlines = [...refs].map(ref => deadlineFor(ref)).filter((value): value is string => Boolean(value));
      const expiresAt = Math.min(originalCreated + DAYS_40,
        previous ? Date.parse(previous.expiresAt) : Infinity, ...deadlines.map(value => Date.parse(value)));
      entries.set(rel, { path: rel, sha256: digest, expiresAt: new Date(expiresAt).toISOString(),
        evidenceRefHashes: [...new Set([...(previous?.evidenceRefHashes ?? []), ...[...refs].map(hash)])] });
    }
  };
  const sweepLocked = () => {
    scan(root);
    const receipts = [];
    for (const entry of entries.values()) {
      const reason = entry.evidenceRefHashes.some(ref => withdrawn.has(ref)) ? 'SOURCE_WITHDRAWN'
        : Date.parse(entry.expiresAt) <= now() ? 'RETENTION_40_DAY_EXPIRY' : null;
      if (!reason) continue;
      const path = safePath(entry.path);
      // Never delete an external edit against a stale index: rescan on the next pass.
      if (existsSync(path) && hash(readFileSync(path)) !== entry.sha256) continue;
      if (existsSync(path) && metadataFiles.has(entry.path.split(/[\\/]/u).at(-1)!)) {
        const text = readFileSync(path, 'utf8');
        let sanitized: string;
        try {
          sanitized = path.endsWith('.jsonl')
            ? text.trim().split('\n').filter(Boolean)
              .map(line => JSON.stringify(withoutContent(JSON.parse(line)))).join('\n') + '\n'
            : JSON.stringify(withoutContent(JSON.parse(text)), null, 2);
        } catch {
          // Preserve an incomplete metadata ledger for a later pass. Never
          // reset accounting or report a deletion that did not occur.
          continue;
        }
        if (sanitized) {
          atomicWrite(path, sanitized);
        }
      } else rmSync(path, { force: true });
      entries.delete(entry.path);
      const receipt = { path: entry.path, sha256: entry.sha256, reason, deletedAt: new Date(now()).toISOString(),
        evidenceRefHashes: entry.evidenceRefHashes };
      appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 }); receipts.push(receipt);
    }
    persist(); return receipts;
  };
  return {
    // A sweep is periodic maintenance. If another runtime owns the lock, the
    // next interval will retry; it must never turn an HTTP request into 500.
    sweep() { return withLock(sweepLocked, { waitMs: 0, skipIfBusy: true }) ?? []; },
    withdraw(refs: readonly string[]) {
      return withLock(() => {
        for (const ref of refs) withdrawn.add(hash(ref));
        return sweepLocked();
      }, { waitMs: WITHDRAW_LOCK_WAIT_MS });
    },
    count() { reload(); return entries.size; },
  };
}
