import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAlgorithmCostLedger, fingerprintClientIp } from '../../../src/lib/algorithm-service/cost-ledger.ts';

test('同一 IP 的不同会话和轮次会聚合为明细表与 IP 汇总', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-cost-ledger-'));
  const ledger = createAlgorithmCostLedger({ directory });
  const ip = fingerprintClientIp('203.0.113.7');
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'session-a', sessionEpoch: 'epoch-a', round: 1 },
    { module: 'text', requestId: 'text-1', reservedCny: 0.12, occurredAt: '2026-10-14T00:00:00.000Z' });
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'session-a', sessionEpoch: 'epoch-a', round: 1 },
    { module: 'tts', requestId: 'tts-1', reservedCny: 0.6, occurredAt: '2026-10-14T00:00:01.000Z' });
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'session-a', sessionEpoch: 'epoch-a', round: 2 },
    { module: 'text', requestId: 'text-2', reservedCny: 0.12, occurredAt: '2026-10-14T00:01:00.000Z' });
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'session-b', sessionEpoch: 'epoch-b', round: 1 },
    { module: 'asr', requestId: 'asr-1', reservedCny: 0.6, occurredAt: '2026-10-14T00:02:00.000Z' });

  const table = ledger.table();
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0], {
    ipFingerprint: ip, sessionLabel: table.rows[0].sessionLabel, round: 1,
    modules: ['text', 'tts'], attemptCount: 2, reservedCny: 0.72,
    actualCostCny: null, billingState: 'PENDING_INVOICE',
    firstAt: '2026-10-14T00:00:00.000Z', lastAt: '2026-10-14T00:00:01.000Z',
  });
  assert.equal(table.ipTotals[0]?.sessionCount, 2);
  assert.equal(table.ipTotals[0]?.roundCount, 3);
  assert.equal(table.ipTotals[0]?.attemptCount, 4);
  assert.equal(table.ipTotals[0]?.reservedCny, 1.44);
  assert.equal(table.actualCostAvailable, false);
  assert.equal(table.unattributedEntryCount, 0);
  assert.equal(readFileSync(join(directory, 'cost-ledger.jsonl'), 'utf8').includes('203.0.113.7'), false);
});

test('ledger 重启后保留已有明细，但只读取自己的 schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-cost-ledger-reload-'));
  const first = createAlgorithmCostLedger({ directory });
  first.record(undefined, { module: 'text', requestId: 'legacy-like', reservedCny: 0.12 });
  const second = createAlgorithmCostLedger({ directory });
  const table = second.table();
  assert.equal(table.rows.length, 1);
  assert.equal(table.unattributedEntryCount, 1);
  assert.equal(table.rows[0]?.ipFingerprint, 'unattributed-internal');
});

test('设备工作区成本表只包含绑定会话，不泄露同一 IP 的其他会话或历史汇总', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-cost-workspace-'));
  const ledger = createAlgorithmCostLedger({ directory });
  const ip = fingerprintClientIp('203.0.113.9');
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'workspace-a-session',
    sessionEpoch: 'epoch-a', round: 1 },
  { module: 'text', requestId: 'workspace-a-text', reservedCny: 0.12 });
  ledger.record({ ipFingerprint: ip, ipSource: 'forwarded', sessionHandle: 'workspace-b-session',
    sessionEpoch: 'epoch-b', round: 1 },
  { module: 'tts', requestId: 'workspace-b-tts', reservedCny: 0.6 });

  const table = ledger.tableForSessions(['workspace-a-session']);
  assert.equal(table.rows.length, 1);
  assert.deepEqual(table.rows[0]?.modules, ['text']);
  assert.equal(table.entries.length, 1);
  assert.equal(table.entries[0]?.requestId, 'workspace-a-text');
  assert.equal(table.legacyAggregate?.reservationCount, 0);
  assert.match(table.note, /只显示当前设备工作区/u);
});
