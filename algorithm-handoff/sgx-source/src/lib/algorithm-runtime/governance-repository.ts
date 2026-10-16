import type { GenerationCancellationState } from './cancellation-registry';
import type { DataLifecycleState } from './data-lifecycle';
import type { BudgetControllerState, ModelCallLedgerState } from './model-call-ledger';

export interface AlgorithmGovernanceState {
  schemaVersion: 'algorithm-governance-v0.1';
  savedAt: string;
  budget: BudgetControllerState;
  modelCalls: ModelCallLedgerState;
  cancellation: GenerationCancellationState;
  dataLifecycle: DataLifecycleState;
}

export interface VersionedGovernanceState {
  revision: number;
  state: AlgorithmGovernanceState;
}

/**
 * Paid execution requires a single authoritative implementation whose
 * compare-and-swap operation persists the whole governance snapshot atomically.
 */
export interface AlgorithmGovernanceRepository {
  durability: 'memory' | 'durable';
  load(runId: string): Promise<VersionedGovernanceState | null>;
  compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    state: AlgorithmGovernanceState
  ): Promise<VersionedGovernanceState>;
}

export function assertRepositoryReadyForPaidExecution(
  repository: Pick<AlgorithmGovernanceRepository, 'durability'>
): void {
  if (repository.durability !== 'durable') {
    throw new Error('paid execution requires a durable governance repository');
  }
}
