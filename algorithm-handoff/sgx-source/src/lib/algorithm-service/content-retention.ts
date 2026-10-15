import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RETENTION_MS = 40 * 86_400_000;
const CONTENT_FILENAME = /^content_[a-f0-9-]+\.json$/u;
type ContentEntry = { schemaVersion: 'internal-content-v0.1'; id: string;
  sessionEpoch: string; evidenceRefs: string[]; kind: string;
  createdAt: string; expiresAt: string; value: unknown };

export type InternalContentRetentionInput = Pick<ContentEntry, 'sessionEpoch' | 'evidenceRefs' | 'kind' | 'value'> & {
  /** Trusted server metadata; never deserialize these deadlines from an HTTP body. */
  sourceExpiresAt: Readonly<Record<string, string>>;
};

export interface InternalContentDeletionReceipt {
  id: string;
  kind: string;
  reason: 'SOURCE_WITHDRAWN' | 'RETENTION_40_DAY_EXPIRY';
  deletedAt: string;
  evidenceRefHashes: string[];
}

function validKind(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/u.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validRefs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(ref => typeof ref === 'string' && ref.trim().length > 0);
}

/** Internal content is separate from the no-content attempt/budget ledger. */
export function createInternalContentRetention(directory: string, now = () => Date.now()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptsDirectory = join(directory, 'receipts');
  mkdirSync(receiptsDirectory, { recursive: true, mode: 0o700 });
  const entries = new Map<string, ContentEntry>();
  const deletionReceipts = new Map<string, InternalContentDeletionReceipt>();
  const pathFor = (id: string) => join(directory, `${id}.json`);
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
      throw new Error('invalid_internal_retention_clock');
    }
    return value;
  };
  const atomicWrite = (path: string, value: unknown) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const scrub = (entry: ContentEntry, reason: InternalContentDeletionReceipt['reason']) => {
    rmSync(pathFor(entry.id), { force: true });
    entries.delete(entry.id);
    const receipt: InternalContentDeletionReceipt = {
      id: entry.id, kind: entry.kind, reason, deletedAt: new Date(clock()).toISOString(),
      evidenceRefHashes: [...new Set(entry.evidenceRefs)]
        .map(ref => createHash('sha256').update(ref).digest('hex')).sort(),
    };
    atomicWrite(join(receiptsDirectory, `${entry.id}.json`), receipt);
    deletionReceipts.set(entry.id, receipt);
    return structuredClone(receipt);
  };
  for (const file of readdirSync(receiptsDirectory)) {
    if (!CONTENT_FILENAME.test(file)) continue;
    const receipt = JSON.parse(readFileSync(join(receiptsDirectory, file), 'utf8')) as InternalContentDeletionReceipt;
    const fields = ['deletedAt', 'evidenceRefHashes', 'id', 'kind', 'reason'];
    if (Object.keys(receipt).sort().join(',') !== fields.join(',')
      || `${receipt.id}.json` !== file || !validKind(receipt.kind)
      || !['SOURCE_WITHDRAWN', 'RETENTION_40_DAY_EXPIRY'].includes(receipt.reason)
      || !validTimestamp(receipt.deletedAt) || !Array.isArray(receipt.evidenceRefHashes)
      || receipt.evidenceRefHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) {
      throw new Error('invalid_internal_content_receipt');
    }
    deletionReceipts.set(receipt.id, receipt);
  }
  // A restart must not silently forget the expiry of content already on disk.
  for (const file of readdirSync(directory)) {
    if (!CONTENT_FILENAME.test(file)) continue;
    const entry = JSON.parse(readFileSync(join(directory, file), 'utf8')) as ContentEntry;
    if (entry.schemaVersion !== 'internal-content-v0.1' || `${entry.id}.json` !== file
      || typeof entry.sessionEpoch !== 'string' || !entry.sessionEpoch.trim()
      || !validKind(entry.kind) || !validRefs(entry.evidenceRefs)
      || !validTimestamp(entry.createdAt) || !validTimestamp(entry.expiresAt)
      || Date.parse(entry.expiresAt) > Date.parse(entry.createdAt) + RETENTION_MS) {
      throw new Error('invalid_internal_content_index');
    }
    if (Date.parse(entry.expiresAt) <= clock()) scrub(entry, 'RETENTION_40_DAY_EXPIRY');
    else entries.set(entry.id, entry);
  }
  return {
    retain(input: InternalContentRetentionInput): { id: string; expiresAt: string } | null {
      if (!input || typeof input.sessionEpoch !== 'string' || !input.sessionEpoch.trim()
        || !validRefs(input.evidenceRefs) || !validKind(input.kind)) throw new Error('content_source_required');
      const refs = [...new Set(input.evidenceRefs)];
      if (!input.sourceExpiresAt || typeof input.sourceExpiresAt !== 'object'
        || Array.isArray(input.sourceExpiresAt)) throw new Error('content_source_expiry_required');
      const sourceExpiries = refs.map(ref => {
        if (!Object.hasOwn(input.sourceExpiresAt, ref) || !validTimestamp(input.sourceExpiresAt[ref])) {
          throw new Error('content_source_expiry_required');
        }
        return Date.parse(input.sourceExpiresAt[ref]);
      });
      const created = clock();
      const expiresAt = Math.min(created + RETENTION_MS, ...sourceExpiries);
      if (expiresAt <= created) return null;
      const entry: ContentEntry = { schemaVersion: 'internal-content-v0.1',
        sessionEpoch: input.sessionEpoch, evidenceRefs: refs, kind: input.kind, value: structuredClone(input.value),
        id: `content_${randomUUID()}`, createdAt: new Date(created).toISOString(),
        expiresAt: new Date(expiresAt).toISOString() };
      const path = pathFor(entry.id);
      atomicWrite(path, entry);
      entries.set(entry.id, entry);
      return { id: entry.id, expiresAt: entry.expiresAt };
    },
    withdraw(evidenceRefs: readonly string[]) {
      return [...entries.values()].filter(entry => entry.evidenceRefs.some(ref => evidenceRefs.includes(ref)))
        .map(entry => scrub(entry, 'SOURCE_WITHDRAWN'));
    },
    sweep() {
      const cutoff = clock();
      return [...entries.values()].filter(entry => Date.parse(entry.expiresAt) <= cutoff)
        .map(entry => scrub(entry, 'RETENTION_40_DAY_EXPIRY'));
    },
    count() { return entries.size; },
    receipts() { return structuredClone([...deletionReceipts.values()]); },
  };
}
