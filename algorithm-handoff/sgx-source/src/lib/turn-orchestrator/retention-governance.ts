import { createHash } from 'node:crypto';

import type { InMemoryReferenceStore, InvalidationAudit } from '../memory-runtime/index.ts';

export interface RetentionGovernanceRequest {
  actionId: string;
  actorId: string;
  occurredAt: string;
  reasonCode: string;
  evidenceRefs: readonly string[];
}

export interface RetentionGovernanceResult {
  status: 'APPLIED';
  evidenceRefHashes: string[];
  withdrawnRecordIds: string[];
  invalidatedArtifactRefs: string[];
}

export interface RetentionGovernanceAdapter {
  withdraw(request: RetentionGovernanceRequest): Promise<RetentionGovernanceResult>;
}

export interface CreateReferenceStoreRetentionGovernanceAdapterOptions {
  referenceStore: InMemoryReferenceStore;
  invalidateArtifacts?: (
    evidenceRefs: readonly string[],
    audit: InvalidationAudit,
  ) => Promise<readonly string[]> | readonly string[];
}

function hashRef(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createReferenceStoreRetentionGovernanceAdapter(
  options: CreateReferenceStoreRetentionGovernanceAdapterOptions,
): RetentionGovernanceAdapter {
  if (!options?.referenceStore) throw new TypeError('referenceStore is required');
  return {
    async withdraw(request) {
      if (!request || typeof request !== 'object') throw new TypeError('request is required');
      if (!Array.isArray(request.evidenceRefs) || request.evidenceRefs.length === 0) {
        throw new TypeError('evidenceRefs must be non-empty');
      }
      const refs = [...new Set(request.evidenceRefs)];
      const audit: InvalidationAudit = {
        actionId: request.actionId,
        actorId: request.actorId,
        actorRole: 'authorized_actor',
        occurredAt: request.occurredAt,
        reasonCode: request.reasonCode,
      };
      const withdrawnRecordIds = [...new Set(refs.flatMap(ref => (
        options.referenceStore.withdrawEvidence(ref, audit)
      )))].sort();
      for (const recordId of withdrawnRecordIds) {
        options.referenceStore.deleteVersion(recordId, {
          ...audit, actionId: `${request.actionId}:delete-version:${hashRef(recordId)}`,
        });
      }
      const invalidatedArtifactRefs = options.invalidateArtifacts
        ? [...new Set(await options.invalidateArtifacts(refs, audit))].sort()
        : [];
      return {
        status: 'APPLIED',
        evidenceRefHashes: refs.map(hashRef).sort(),
        withdrawnRecordIds,
        invalidatedArtifactRefs,
      };
    },
  };
}
