import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInternalContentRetention } from '../../../src/lib/algorithm-service/content-retention.ts';

const START = Date.parse('2026-10-09T04:00:00.000Z');
const DAY_MS = 86400_000;
const iso = (value: number) => new Date(value).toISOString();
const contentFiles = (directory: string) => readdirSync(directory)
  .filter(file => /^content_.*\.json$/u.test(file));

test('source withdrawal physically removes matching content while retaining unrelated content and no-content receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  try {
    const store = createInternalContentRetention(directory, () => START);
    const first = store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A'], kind: 'model:story', value: '原文甲',
      sourceExpiresAt: { 'evidence:A': iso(START + 40 * DAY_MS) } });
    store.retain({ sessionEpoch: 'B', evidenceRefs: ['evidence:B'], kind: 'tts', value: '原文乙',
      sourceExpiresAt: { 'evidence:B': iso(START + 40 * DAY_MS) } });
    assert.ok(first);
    const receipt = store.withdraw(['evidence:A']);
    assert.equal(receipt.length, 1);
    assert.equal(store.count(), 1);
    assert.equal(contentFiles(directory).length, 1);
    assert.equal(readFileSync(join(directory, contentFiles(directory)[0]), 'utf8').includes('原文甲'), false);
    const persisted = JSON.parse(readFileSync(join(directory, 'receipts', `${first.id}.json`), 'utf8'));
    assert.deepEqual(persisted, receipt[0]);
    assert.deepEqual(Object.keys(persisted).sort(), ['deletedAt', 'evidenceRefHashes', 'id', 'kind', 'reason']);
    assert.equal(JSON.stringify(persisted).includes('原文'), false);
    assert.equal(JSON.stringify(persisted).includes('evidence:A'), false);
    const restored = createInternalContentRetention(directory, () => START);
    assert.deepEqual(restored.receipts(), receipt);
    assert.equal(restored.count(), 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart immediately removes expired local content and durably reloads its no-content receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  let now = START;
  try {
    const store = createInternalContentRetention(directory, () => now);
    store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A'], kind: 'turn', value: { text: '来源' },
      sourceExpiresAt: { 'evidence:A': iso(START + 40 * DAY_MS) } });
    now += 40 * DAY_MS;
    const restored = createInternalContentRetention(directory, () => now);
    assert.equal(restored.count(), 0);
    assert.equal(contentFiles(directory).length, 0);
    assert.equal(restored.receipts().length, 1);
    assert.equal(restored.receipts()[0].reason, 'RETENTION_40_DAY_EXPIRY');
    assert.equal(restored.sweep().length, 0);
    const again = createInternalContentRetention(directory, () => now);
    assert.deepEqual(again.receipts(), restored.receipts());
    assert.equal(again.count(), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('derived output inherits the earliest source deadline and regeneration cannot reset that deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  let now = START;
  try {
    const store = createInternalContentRetention(directory, () => now);
    const earliest = iso(START + 12 * DAY_MS);
    const sourceExpiresAt = { 'evidence:A': iso(START + 25 * DAY_MS), 'evidence:B': earliest };
    const first = store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A', 'evidence:B'],
      kind: 'model:story', value: '依据两段原文的故事', sourceExpiresAt });
    assert.equal(first?.expiresAt, earliest);
    now += 10 * DAY_MS;
    const regenerated = store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A', 'evidence:B'],
      kind: 'tts', value: '依据故事合成的音频', sourceExpiresAt });
    assert.equal(regenerated?.expiresAt, earliest);
    now += 2 * DAY_MS;
    const receipts = store.sweep();
    assert.equal(receipts.length, 2);
    assert.equal(store.count(), 0);
    assert.equal(contentFiles(directory).length, 0);
    const restored = createInternalContentRetention(directory, () => now);
    assert.deepEqual(restored.receipts().sort((a, b) => a.id.localeCompare(b.id)),
      receipts.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(restored.sweep().length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the current 40-day window still caps outputs when all source deadlines are later', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  try {
    const store = createInternalContentRetention(directory, () => START);
    const result = store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A'], kind: 'profile', value: {},
      sourceExpiresAt: { 'evidence:A': iso(START + 60 * DAY_MS) } });
    assert.equal(result?.expiresAt, iso(START + 40 * DAY_MS));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an expired source refuses a new write even when another source remains active', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  try {
    const store = createInternalContentRetention(directory, () => START);
    const result = store.retain({ sessionEpoch: 'A', evidenceRefs: ['evidence:A', 'evidence:B'],
      kind: 'model:story', value: '不得重新保存的故事',
      sourceExpiresAt: { 'evidence:A': iso(START), 'evidence:B': iso(START + 5 * DAY_MS) } });
    assert.equal(result, null);
    assert.equal(store.count(), 0);
    assert.equal(contentFiles(directory).length, 0);
    assert.deepEqual(store.receipts(), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing or malformed server source deadlines fail closed without persisting content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-content-'));
  try {
    const store = createInternalContentRetention(directory, () => START);
    const input = { sessionEpoch: 'A', evidenceRefs: ['evidence:A', 'evidence:B'], kind: 'turn', value: '原文' };
    assert.throws(() => store.retain({ ...input, sourceExpiresAt: { 'evidence:A': iso(START + DAY_MS) } }),
      /content_source_expiry_required/);
    assert.throws(() => store.retain({ ...input,
      sourceExpiresAt: { 'evidence:A': iso(START + DAY_MS), 'evidence:B': 'not-a-time' } }),
    /content_source_expiry_required/);
    assert.equal(store.count(), 0);
    assert.equal(contentFiles(directory).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
