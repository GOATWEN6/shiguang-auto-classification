import type { CancellationCleanupStatus } from './contracts.ts';

export const DEFAULT_CANCELLATION_CLEANUP_TIMEOUT_MS = 1_250;

export type CancellationAwareOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled'; cleanupStatus: Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'> };

export function cancellationCleanupTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CANCELLATION_CLEANUP_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > 30_000) {
    throw new TypeError('cancellationCleanupTimeoutMs must be an integer between 1 and 30000');
  }
  return value;
}

async function joinAfterCancellation<T>(
  settled: Promise<{ kind: 'value'; value: T } | { kind: 'error'; error: unknown }>,
  timeoutMs: number,
): Promise<CancellationAwareOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(resolve => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const joined = settled.then(() => true as const);
  const didJoin = await Promise.race([joined, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  return {
    kind: 'cancelled',
    cleanupStatus: didJoin ? 'JOINED' : 'TIMED_OUT',
  };
}

/**
 * Cancellation wins the business result, but an already-started task receives
 * a bounded opportunity to acknowledge cleanup before its owner lease is
 * finalized. Rejections remain observed even after the cleanup timeout.
 */
export async function settleWithCancellationCleanup<T>(
  task: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CancellationAwareOutcome<T>> {
  const settled = task.then<
    { kind: 'value'; value: T },
    { kind: 'error'; error: unknown }
  >(
    value => ({ kind: 'value', value }),
    error => ({ kind: 'error', error }),
  );
  if (signal.aborted) return joinAfterCancellation(settled, timeoutMs);

  let removeListener = () => {};
  const cancelled = new Promise<{ kind: 'cancelled' }>(resolve => {
    const onAbort = () => resolve({ kind: 'cancelled' });
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  const first = await Promise.race([settled, cancelled]);
  removeListener();
  if (first.kind !== 'cancelled') return first;
  return joinAfterCancellation(settled, timeoutMs);
}
