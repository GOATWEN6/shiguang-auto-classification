import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRetentionSweepDiagnostics,
  runRetentionSweepSafely,
  sanitizeRetentionSweepError,
} from '../../../src/lib/algorithm-service/retention-diagnostics.ts';

test('sweep failures are caught and reduced to an allowlisted diagnostic', () => {
  const reported: unknown[] = [];
  const raw = new Error('secret path /private/customer/audio?token=do-not-log');
  Object.assign(raw, { code: 'EACCES', stack: 'secret stack and request content' });

  const completed = runRetentionSweepSafely('content_sweep', () => { throw raw; }, value => reported.push(value),
    () => Date.parse('2026-10-11T00:00:00.000Z'));

  assert.equal(completed, false);
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0], {
    schemaVersion: 'retention-sweep-diagnostic-v0.1',
    occurredAt: '2026-10-11T00:00:00.000Z',
    operation: 'content_sweep',
    errorCode: 'EACCES',
    retryable: false,
  });
  assert.equal(JSON.stringify(reported).includes('secret'), false);
  assert.equal(JSON.stringify(reported).includes('/private'), false);
});

test('unknown and hostile thrown values never copy arbitrary codes or messages', () => {
  const hostile = { code: 'api_key=should-not-appear', message: 'raw user transcript', stack: 'private stack' };
  const diagnostic = sanitizeRetentionSweepError('diagnostic_sweep', hostile,
    () => Date.parse('2026-10-11T00:00:00.000Z'));
  assert.equal(diagnostic.errorCode, 'unknown');
  assert.equal(diagnostic.retryable, false);
  assert.equal(JSON.stringify(diagnostic).includes('api_key'), false);
  assert.equal(JSON.stringify(diagnostic).includes('transcript'), false);

  const throwingProxy = new Proxy({}, { has() { throw new Error('property probe failed'); } });
  assert.doesNotThrow(() => sanitizeRetentionSweepError('content_sweep', throwingProxy));

  // Internal retention failures use a symbolic Error message rather than a
  // Node errno property; preserve that bounded diagnostic without exposing
  // arbitrary message text.
  assert.equal(sanitizeRetentionSweepError('diagnostic_sweep',
    new Error('diagnostic_retention_lock_unavailable')).errorCode,
  'diagnostic_retention_lock_unavailable');
});

test('diagnostic reporter persists only the fixed no-content schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-retention-diagnostics-'));
  try {
    const reporter = createRetentionSweepDiagnostics(root,
      () => Date.parse('2026-10-11T00:00:00.000Z'));
    const diagnostic = reporter.record({
      schemaVersion: 'retention-sweep-diagnostic-v0.1',
      occurredAt: '2026-10-11T00:00:00.000Z',
      operation: 'diagnostic_sweep', errorCode: 'EIO', retryable: false,
    });
    assert.equal(diagnostic.errorCode, 'EIO');
    const line = readFileSync(reporter.path, 'utf8').trim();
    assert.deepEqual(JSON.parse(line), diagnostic);
    assert.equal(line.includes('text'), false);
    assert.equal(line.includes('evidence'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unwritable diagnostics directory cannot escape through the reporter', () => {
  const root = mkdtempSync(join(tmpdir(), 'sgx-retention-diagnostics-'));
  const blocked = join(root, 'blocked');
  try {
    writeFileSync(blocked, 'not a directory');
    const reporter = createRetentionSweepDiagnostics(join(blocked, 'child'));
    assert.doesNotThrow(() => reporter.record({
      schemaVersion: 'retention-sweep-diagnostic-v0.1',
      occurredAt: '2026-10-11T00:00:00.000Z',
      operation: 'content_sweep', errorCode: 'EACCES', retryable: false,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
