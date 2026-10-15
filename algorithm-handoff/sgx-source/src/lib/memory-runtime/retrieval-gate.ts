import type {
  GatedReferenceHit,
  ReferenceIndexHit,
  ReferenceRecord,
  ReferenceRetrievalRequest,
} from './contracts.ts';
import {
  assertValidReferenceRetrievalRequest,
  InMemoryReferenceStore,
} from './reference-store.ts';

/**
 * Re-checks every index hit against the live reference state. Vector/search
 * indexes are treated as stale hints and never as an authorization source.
 */
export function gateReferenceIndexHits<T extends ReferenceIndexHit>(
  store: InMemoryReferenceStore,
  hits: T[],
  request: ReferenceRetrievalRequest,
): Array<GatedReferenceHit<T>> {
  assertValidReferenceRetrievalRequest(request);
  const accepted: Array<GatedReferenceHit<T>> = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    if (seen.has(hit.recordId) || !store.isRecordUsable(hit.recordId, request)) continue;
    const stored = store.get(hit.recordId);
    if (!stored || stored.status === 'DELETED') continue;
    seen.add(hit.recordId);
    accepted.push({ hit: structuredClone(hit), record: stored as ReferenceRecord });
  }

  return accepted;
}
