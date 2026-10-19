import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInternalTestBudget } from '../../../src/lib/algorithm-service/internal-test-budget.ts';

test('corrupt budget snapshot cannot reserve or be treated as zero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-budget-'));
  try {
    writeFileSync(join(directory, 'budget.json'), '{}');
    const budget = createInternalTestBudget({ directory, batchCapCny: 4, priorExposureCny: 40 });
    assert.throws(() => budget.snapshot(), /budget_snapshot_invalid/);
    assert.throws(() => budget.reserve('daily_chat', 'bad-snapshot'), /budget_snapshot_invalid/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('independent instances reserve against the latest persisted budget and an exclusive lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-budget-'));
  try {
    const options = { directory, batchCapCny: 0.6, priorExposureCny: 44 };
    const a = createInternalTestBudget(options);
    const b = createInternalTestBudget(options);
    assert.equal(a.snapshot().reservedCny, 0);
    assert.equal(b.snapshot().reservedCny, 0);
    assert.equal(a.reserve('tts', 'first'), 0.6);
    assert.throws(() => b.reserve('asr', 'second'), /batch_budget_exhausted/);
    assert.equal(b.snapshot().reservedCny, 0.6);
    writeFileSync(join(directory, 'budget.lock'), '');
    assert.throws(() => a.reserve('daily_chat', 'locked'), /budget_lock_unavailable/);
    assert.equal(a.snapshot().reservedCny, 0.6);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('owner 800/120 policy preserves cumulative exposure and does not block for unknown billing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-budget-'));
  try {
    const budget = createInternalTestBudget({ directory, batchCapCny: 114.48, priorExposureCny: 35.52 });
    const initial = budget.snapshot();
    writeFileSync(join(directory, 'budget.json'), JSON.stringify({ ...initial, reservedCny: 4.32 }));
    assert.equal(budget.status().cumulativeReservedCny, 39.84);
    assert.equal(budget.status().remainingProgramCny, 760.16);
    assert.equal(budget.status().actualCostCny, null);
    assert.equal(budget.status().billingState, 'PENDING');
    assert.equal(budget.reserve('daily_chat', 'next'), 0.12);
    assert.equal(budget.status().cumulativeReservedCny, 39.96);
    assert.equal(budget.status().ownerReportRequired, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('120 is a report point, 800 remains the cumulative hard cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-budget-'));
  try {
    const budget = createInternalTestBudget({ directory, batchCapCny: 680.6, priorExposureCny: 119.4 });
    assert.equal(budget.status().ownerReportRequired, false);
    budget.reserve('tts', 'cross-report');
    assert.equal(budget.status().cumulativeReservedCny, 120);
    assert.equal(budget.status().ownerReportRequired, true);
    const atCap = budget.snapshot();
    writeFileSync(join(directory, 'budget.json'), JSON.stringify({ ...atCap, reservedCny: 680.6 }));
    assert.equal(budget.status().cumulativeReservedCny, 800);
    assert.throws(() => budget.reserve('daily_chat', 'over-cap'), /batch_budget_exhausted/);
    assert.equal(budget.status().cumulativeReservedCny, 800);
    assert.equal(createInternalTestBudget({ directory, batchCapCny: 680.61, priorExposureCny: 119.4 }).authorized, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an old or policy-mismatched ledger requires explicit migration and cannot reset itself', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-budget-'));
  try {
    const budget = createInternalTestBudget({ directory, batchCapCny: 114.48, priorExposureCny: 35.52 });
    writeFileSync(join(directory, 'budget.json'), JSON.stringify({ ...budget.snapshot(),
      schemaVersion: 'internal-http-budget-v0.1', reservedCny: 4.32 }));
    assert.throws(() => budget.reserve('tts', 'old'), /budget_snapshot_invalid/);
    writeFileSync(join(directory, 'budget.json'), JSON.stringify({
      schemaVersion: 'internal-http-budget-v0.2', batchCapCny: 114.48,
      priorExposureCny: 0, reservedCny: 4.32, actualCostCny: null, billingState: 'PENDING', canonicalWriteCount: 0 }));
    assert.throws(() => budget.snapshot(), /budget_snapshot_invalid/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
