import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, openSync, closeSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticRetention } from '../../../src/lib/algorithm-service/diagnostic-retention.ts';

test('withdrawal covers old and late diagnostic copies, preserves no-content summaries and unrelated sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    mkdirSync(join(root, 'test-run'));
    const expiry = new Date(Date.now() + 100_000).toISOString();
    writeFileSync(join(root, 'test-run', 'result.json'), JSON.stringify({ evidenceId: 'evidence:A', text: '原文甲' }));
    writeFileSync(join(root, 'test-run', 'other.json'), JSON.stringify({ evidenceId: 'evidence:B', text: '原文乙' }));
    writeFileSync(join(root, 'test-run', 'summary.json'), JSON.stringify({ executed: 2, failed: 0 }));
    const store = createDiagnosticRetention(root, () => expiry);
    assert.equal(store.withdraw(['evidence:A']).length, 1);
    assert.equal(existsSync(join(root, 'test-run', 'result.json')), false);
    assert.equal(existsSync(join(root, 'test-run', 'other.json')), true);
    writeFileSync(join(root, 'test-run', 'late.json'), JSON.stringify({ response: { evidenceRefs: ['evidence:A'] }, text: '迟到副本' }));
    const restored = createDiagnosticRetention(root, () => expiry);
    assert.equal(restored.sweep().length, 1);
    assert.equal(existsSync(join(root, 'test-run', 'summary.json')), true);
    const receipts = readFileSync(join(root, 'http-current', 'diagnostic-deletion-receipts.jsonl'), 'utf8');
    assert.equal(/原文|迟到副本|evidence:A/u.test(receipts), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source deadline expires content/audio while metadata remains, even when restarted', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  let now = Date.now();
  try {
    writeFileSync(join(root, 'result.json'), JSON.stringify({ evidenceId: 'evidence:A', text: '原文' }));
    writeFileSync(join(root, 'audio.pcm'), new Uint8Array([0, 1]));
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ passed: false }));
    const store = createDiagnosticRetention(root, () => new Date(now + 1000).toISOString(), () => now);
    store.sweep(); now += 40 * 86_400_000;
    const restored = createDiagnosticRetention(root, () => null, () => now);
    assert.equal(restored.sweep().length, 2);
    assert.equal(existsSync(join(root, 'summary.json')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mixed metadata JSONL checks every row and removes content without losing attempt statuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    const path = join(root, 'attempts.jsonl');
    writeFileSync(path, [
      JSON.stringify({ requestId: 'one', status: 'success' }),
      JSON.stringify({ requestId: 'two', status: 'failed', evidenceRefs: ['evidence:A'], output: { text: '原文' } }),
    ].join('\n') + '\n');
    const store = createDiagnosticRetention(root, () => new Date(Date.now() + 100_000).toISOString());
    assert.equal(store.withdraw(['evidence:A']).length, 1);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.status), ['success', 'failed']);
    assert.equal(rows[1].output, undefined);
    assert.equal(readFileSync(path, 'utf8').includes('原文'), false);
    assert.deepEqual(store.sweep(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('derived field values and question lists are content even without a text key', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    const path = join(root, 'summary.json');
    writeFileSync(path, JSON.stringify({ completed: 1, evidenceRefs: ['evidence:A'],
      profile: { fields: [{ value: '喜欢越剧' }] }, questions: ['什么时候开始的？'] }));
    const store = createDiagnosticRetention(root, () => new Date(Date.now() + 100_000).toISOString());
    assert.equal(store.withdraw(['evidence:A']).length, 1);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(value.completed, 1);
    assert.equal(value.profile.fields[0].value, undefined);
    assert.equal(value.questions, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incomplete metadata never crashes a sweep or resets the authoritative budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  let now = Date.now();
  try {
    writeFileSync(join(root, 'budget.json'), '{"reservedCny":79');
    writeFileSync(join(root, 'ledger.json'), '{"status":');
    const store = createDiagnosticRetention(root, () => null, () => now);
    store.sweep(); now += 41 * 86_400_000;
    assert.deepEqual(store.sweep(), []);
    assert.equal(readFileSync(join(root, 'budget.json'), 'utf8'), '{"reservedCny":79');
    assert.equal(readFileSync(join(root, 'ledger.json'), 'utf8'), '{"status":');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('independent retention writers do not compete on one fixed temporary filename', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    writeFileSync(join(root, 'result.json'), JSON.stringify({ evidenceId: 'evidence:A', text: '原文' }));
    const expiry = new Date(Date.now() + 100_000).toISOString();
    const stores = Array.from({ length: 12 }, () => createDiagnosticRetention(root, () => expiry));
    for (const store of stores) assert.doesNotThrow(() => store.sweep());
    const index = JSON.parse(readFileSync(join(root, 'http-current', 'diagnostic-retention-index.json'), 'utf8'));
    assert.equal(index.schemaVersion, 'diagnostic-retention-v0.1');
    assert.ok(Array.isArray(index.entries));
    assert.deepEqual(readdirSync(join(root, 'http-current')).filter(name => name.endsWith('.tmp')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a concurrent maintenance lock never turns runtime initialization into an HTTP failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  let descriptor: number | undefined;
  try {
    const expiry = new Date(Date.now() + 100_000).toISOString();
    const store = createDiagnosticRetention(root, () => expiry);
    const lockPath = join(root, 'http-current', 'diagnostic-retention.lock');
    descriptor = openSync(lockPath, 'wx', 0o600);
    assert.doesNotThrow(() => store.sweep());
    assert.equal(existsSync(lockPath), true);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-contention filesystem errors while acquiring the lock are not swallowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    const store = createDiagnosticRetention(root, () => new Date(Date.now() + 100_000).toISOString());
    const directory = join(root, 'http-current');
    // Leave the retention directory present but remove its write permission.
    // This makes openSync(..., 'wx') fail with EACCES rather than EEXIST,
    // exercising the distinction without mocking a Node built-in.
    chmodSync(directory, 0o500);
    assert.throws(() => store.sweep(), (error: unknown) =>
      (error as NodeJS.ErrnoException)?.code === 'EACCES');
    assert.throws(() => store.withdraw(['evidence:A']), (error: unknown) =>
      (error as NodeJS.ErrnoException)?.code === 'EACCES');
    chmodSync(directory, 0o700);
  } finally {
    // Restore permissions even if an assertion fails so the temporary tree is
    // always removable by the current user.
    try { chmodSync(join(root, 'http-current'), 0o700); } catch { /* already removed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale store instances retain both withdrawals and entries after interleaved writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-diag-'));
  try {
    const writeEvidence = (name: string, ref: string, text: string) =>
      writeFileSync(join(root, name), JSON.stringify({ evidenceId: ref, text }));
    writeEvidence('a.json', 'evidence:A', '原文甲');
    writeEvidence('b.json', 'evidence:B', '原文乙');
    writeEvidence('keep.json', 'evidence:KEEP', '保留内容');
    const expiry = new Date(Date.now() + 100_000).toISOString();
    // Both instances intentionally start from the same empty/stale snapshot.
    const first = createDiagnosticRetention(root, () => expiry);
    const second = createDiagnosticRetention(root, () => expiry);

    assert.equal(first.withdraw(['evidence:A']).length, 1);
    // A late copy and a new entry arrive after the first writer has persisted.
    writeEvidence('late-a.json', 'evidence:A', '迟到副本');
    writeEvidence('new.json', 'evidence:NEW', '新增内容');
    assert.equal(second.withdraw(['evidence:B']).length, 2);

    assert.equal(existsSync(join(root, 'a.json')), false);
    assert.equal(existsSync(join(root, 'b.json')), false);
    assert.equal(existsSync(join(root, 'late-a.json')), false);
    assert.equal(existsSync(join(root, 'keep.json')), true);
    assert.equal(existsSync(join(root, 'new.json')), true);
    const index = JSON.parse(readFileSync(join(root, 'http-current', 'diagnostic-retention-index.json'), 'utf8'));
    assert.equal(index.withdrawnRefHashes.length, 2);
    assert.equal(index.entries.some((entry: { path: string }) => entry.path === 'keep.json'), true);
    assert.equal(index.entries.some((entry: { path: string }) => entry.path === 'new.json'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
