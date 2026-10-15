import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INTERNAL_TEST_BUDGET_POLICY = {
  version: 'owner-budget-2026-10-14-v0.3',
  programHardCapCny: 400,
  ownerReportExposureCny: 120,
} as const;

interface BudgetSnapshot {
  schemaVersion: 'internal-http-budget-v0.2';
  batchCapCny: number;
  reservedCny: number;
  actualCostCny: null;
  billingState: 'PENDING';
  priorExposureCny: number;
  canonicalWriteCount: 0;
  budgetPolicyVersion: typeof INTERNAL_TEST_BUDGET_POLICY.version;
  programHardCapCny: number;
  ownerReportExposureCny: number;
}

/** One local fictional batch. A file lock serializes read/reserve across instances. */
export function createInternalTestBudget(options: {
  directory: string; batchCapCny: number; priorExposureCny: number;
}) {
  const { directory, batchCapCny, priorExposureCny } = options;
  const file = join(directory, 'budget.json');
  const lock = join(directory, 'budget.lock');
  const { programHardCapCny, ownerReportExposureCny } = INTERNAL_TEST_BUDGET_POLICY;
  const authorized = Number.isFinite(batchCapCny) && batchCapCny > 0 && batchCapCny <= programHardCapCny
    && Number.isFinite(priorExposureCny) && priorExposureCny >= 0
    && priorExposureCny + batchCapCny <= programHardCapCny;
  const initial: BudgetSnapshot = { schemaVersion: 'internal-http-budget-v0.2', batchCapCny,
    reservedCny: 0, actualCostCny: null, billingState: 'PENDING', priorExposureCny,
    canonicalWriteCount: 0, budgetPolicyVersion: INTERNAL_TEST_BUDGET_POLICY.version,
    programHardCapCny, ownerReportExposureCny };
  function snapshot(): BudgetSnapshot {
    if (!authorized) throw new Error('budget_review_required');
    if (!existsSync(file)) return { ...initial };
    let value: BudgetSnapshot;
    try { value = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('budget_snapshot_invalid'); }
    if (!value || value.schemaVersion !== initial.schemaVersion
      || value.batchCapCny !== batchCapCny || value.priorExposureCny !== priorExposureCny
      || !Number.isFinite(value.reservedCny) || value.reservedCny < 0 || value.reservedCny > batchCapCny
      || value.actualCostCny !== null || value.billingState !== 'PENDING' || value.canonicalWriteCount !== 0
      || value.budgetPolicyVersion !== initial.budgetPolicyVersion
      || value.programHardCapCny !== programHardCapCny || value.ownerReportExposureCny !== ownerReportExposureCny) {
      throw new Error('budget_snapshot_invalid');
    }
    return value;
  }
  function reserve(module: string, _requestId: string): number {
    if (!authorized) throw new Error('budget_review_required');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let descriptor: number;
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('budget_lock_unavailable'); }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const value = snapshot();
      const amount = module === 'asr' || module === 'tts' ? 0.6 : 0.12;
      const next = Number((value.reservedCny + amount).toFixed(6));
      if (next > batchCapCny) throw new Error('batch_budget_exhausted');
      if (Number((priorExposureCny + next).toFixed(6)) > programHardCapCny) throw new Error('program_budget_exhausted');
      writeFileSync(temporary, JSON.stringify({ ...value, reservedCny: next }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      return amount;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      closeSync(descriptor);
      unlinkSync(lock);
    }
  }
  return { authorized, snapshot, reserve, status() {
    const value = snapshot();
    const cumulativeReservedCny = Number((value.priorExposureCny + value.reservedCny).toFixed(6));
    return { ...value, cumulativeReservedCny,
      remainingProgramCny: Number((programHardCapCny - cumulativeReservedCny).toFixed(6)),
      ownerReportRequired: cumulativeReservedCny >= ownerReportExposureCny };
  } };
}
