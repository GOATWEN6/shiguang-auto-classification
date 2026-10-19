export type LifecycleStatus = 'ACTIVE' | 'INVALIDATED' | 'DELETION_PENDING';

export type SourceDataKind =
  | 'source_audio'
  | 'source_text'
  | 'source_image'
  | 'source_document';

export type DerivedDataKind =
  | 'transcript'
  | 'provider_output'
  | 'memory_candidate'
  | 'story_draft'
  | 'profile_draft'
  | 'embedding'
  | 'cache'
  | 'index'
  | 'export';

export type DataObjectKind = SourceDataKind | DerivedDataKind;

export type DeletionSurface =
  | 'runtime_store'
  | 'object_store'
  | 'database'
  | 'cache'
  | 'vector_index'
  | 'export_store'
  | 'provider';

export type InvalidationReason =
  | 'participant_withdrawal'
  | 'authorization_revoked'
  | 'no_save'
  | 'source_deleted'
  | 'retention_expired';

export interface DataLifecyclePolicy {
  retentionDays: number;
  withdrawalDeletionSlaHours: number;
}

export interface DataLifecycleRecord {
  objectId: string;
  kind: DataObjectKind;
  sourceObjectIds: readonly string[];
  requiredDeletionSurfaces: readonly DeletionSurface[];
  createdAt: string;
  capturedAt: string;
  expiresAt: string;
  status: LifecycleStatus;
  invalidatedAt?: string;
  invalidationReason?: InvalidationReason;
  deletionDueAt?: string;
}

export interface DeletionReceipt {
  verificationId: string;
  surface: DeletionSurface;
  status: 'DELETED' | 'NOT_FOUND';
  completedAt: string;
}

export interface ContentFreeDeletionAudit {
  objectId: string;
  requestedAt: string;
  completedAt: string;
  expiresAt: string;
  scope: DataObjectKind;
  resultCode: 'DELETED_WITHIN_SLA' | 'DELETED_AFTER_SLA';
}

export interface DataLifecycleState {
  schemaVersion: 'data-lifecycle-v0.1';
  policyFingerprint: string;
  records: DataLifecycleRecord[];
  deletionAudits: ContentFreeDeletionAudit[];
}

const SOURCE_KINDS = new Set<SourceDataKind>([
  'source_audio',
  'source_text',
  'source_image',
  'source_document',
]);
const DERIVED_KINDS = new Set<DerivedDataKind>([
  'transcript',
  'provider_output',
  'memory_candidate',
  'story_draft',
  'profile_draft',
  'embedding',
  'cache',
  'index',
  'export',
]);
const INVALIDATION_REASONS = new Set<InvalidationReason>([
  'participant_withdrawal',
  'authorization_revoked',
  'no_save',
  'source_deleted',
  'retention_expired',
]);
const DELETION_SURFACES = new Set<DeletionSurface>([
  'runtime_store',
  'object_store',
  'database',
  'cache',
  'vector_index',
  'export_store',
  'provider',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be an ISO 8601 UTC timestamp with milliseconds`);
  }
  return parsed;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function cloneRecord(record: DataLifecycleRecord): DataLifecycleRecord {
  return {
    ...record,
    sourceObjectIds: [...record.sourceObjectIds],
    requiredDeletionSurfaces: [...record.requiredDeletionSurfaces],
  };
}

function lifecyclePolicyFingerprint(policy: DataLifecyclePolicy): string {
  return JSON.stringify({
    retentionDays: policy.retentionDays,
    withdrawalDeletionSlaHours: policy.withdrawalDeletionSlaHours,
  });
}

export class DataLifecycleRegistry {
  private readonly records = new Map<string, DataLifecycleRecord>();
  private readonly deletionAudits = new Map<string, ContentFreeDeletionAudit>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly policy: DataLifecyclePolicy;

  constructor(policy: DataLifecyclePolicy) {
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) {
      throw new Error('retentionDays must be a positive integer');
    }
    if (
      !Number.isFinite(policy.withdrawalDeletionSlaHours)
      || policy.withdrawalDeletionSlaHours <= 0
    ) {
      throw new Error('withdrawalDeletionSlaHours must be greater than zero');
    }
    this.policy = { ...policy };
  }

  static restore(policy: DataLifecyclePolicy, state: DataLifecycleState): DataLifecycleRegistry {
    if (state.schemaVersion !== 'data-lifecycle-v0.1') {
      throw new Error('unsupported data lifecycle state');
    }
    if (state.policyFingerprint !== lifecyclePolicyFingerprint(policy)) {
      throw new Error('data lifecycle policy mismatch while restoring state');
    }
    const registry = new DataLifecycleRegistry(policy);
    for (const record of state.records) {
      registry.assertOpaqueObjectId(record.objectId);
      registry.assertSurfaces(record.requiredDeletionSurfaces);
      for (const sourceObjectId of record.sourceObjectIds) {
        registry.assertOpaqueObjectId(sourceObjectId);
      }
      const sourceKind = SOURCE_KINDS.has(record.kind as SourceDataKind);
      const derivedKind = DERIVED_KINDS.has(record.kind as DerivedDataKind);
      if (!sourceKind && !derivedKind) throw new Error('invalid restored data kind');
      if (sourceKind && record.sourceObjectIds.length !== 0) {
        throw new Error('restored source data cannot have sourceObjectIds');
      }
      if (derivedKind && record.sourceObjectIds.length === 0) {
        throw new Error('restored derived data requires sourceObjectIds');
      }
      timestamp(record.createdAt, 'createdAt');
      timestamp(record.capturedAt, 'capturedAt');
      timestamp(record.expiresAt, 'expiresAt');
      if (timestamp(record.createdAt, 'createdAt') < timestamp(record.capturedAt, 'capturedAt')) {
        throw new Error('restored createdAt cannot precede capturedAt');
      }
      if (timestamp(record.expiresAt, 'expiresAt') <= timestamp(record.createdAt, 'createdAt')) {
        throw new Error('restored expiresAt must be later than createdAt');
      }
      if (sourceKind) {
        if (record.createdAt !== record.capturedAt) {
          throw new Error('restored source createdAt must equal capturedAt');
        }
        const expectedExpiry = iso(
          timestamp(record.capturedAt, 'capturedAt') + policy.retentionDays * DAY_MS
        );
        if (record.expiresAt !== expectedExpiry) {
          throw new Error('restored source expiry does not match retention policy');
        }
      }
      if (record.invalidatedAt) timestamp(record.invalidatedAt, 'invalidatedAt');
      if (record.deletionDueAt) timestamp(record.deletionDueAt, 'deletionDueAt');
      if (record.status !== 'ACTIVE' && record.status !== 'INVALIDATED' && record.status !== 'DELETION_PENDING') {
        throw new Error('invalid restored lifecycle status');
      }
      if (record.status !== 'ACTIVE') {
        if (
          !record.invalidatedAt
          || !record.deletionDueAt
          || !record.invalidationReason
          || !INVALIDATION_REASONS.has(record.invalidationReason)
        ) {
          throw new Error('invalid restored invalidation metadata');
        }
        const invalidatedMs = timestamp(record.invalidatedAt, 'invalidatedAt');
        const expectedDeletionDueMs = record.invalidationReason === 'retention_expired'
          ? timestamp(record.expiresAt, 'expiresAt')
          : Math.min(
            invalidatedMs + policy.withdrawalDeletionSlaHours * HOUR_MS,
            timestamp(record.expiresAt, 'expiresAt')
          );
        if (record.deletionDueAt !== iso(expectedDeletionDueMs)) {
          throw new Error('restored deletion deadline does not match lifecycle policy');
        }
        if (
          record.invalidationReason === 'retention_expired'
          && record.invalidatedAt !== record.expiresAt
        ) {
          throw new Error('restored retention invalidation must begin at source expiry');
        }
      } else if (
        record.invalidatedAt !== undefined
        || record.invalidationReason !== undefined
        || record.deletionDueAt !== undefined
      ) {
        throw new Error('restored active data cannot contain invalidation metadata');
      }
      if (registry.records.has(record.objectId)) throw new Error('duplicate restored objectId');
      registry.records.set(record.objectId, cloneRecord(record));
    }
    for (const audit of state.deletionAudits) {
      registry.assertOpaqueObjectId(audit.objectId);
      timestamp(audit.requestedAt, 'requestedAt');
      timestamp(audit.completedAt, 'completedAt');
      timestamp(audit.expiresAt, 'expiresAt');
      if (timestamp(audit.completedAt, 'completedAt') < timestamp(audit.requestedAt, 'requestedAt')) {
        throw new Error('restored deletion completed before it was requested');
      }
      if (!SOURCE_KINDS.has(audit.scope as SourceDataKind) && !DERIVED_KINDS.has(audit.scope as DerivedDataKind)) {
        throw new Error('invalid restored deletion scope');
      }
      if (audit.resultCode !== 'DELETED_WITHIN_SLA' && audit.resultCode !== 'DELETED_AFTER_SLA') {
        throw new Error('invalid restored deletion result');
      }
      if (registry.records.has(audit.objectId)) throw new Error('deleted object cannot remain active');
      if (registry.deletionAudits.has(audit.objectId)) throw new Error('duplicate restored audit');
      registry.deletionAudits.set(audit.objectId, {
        objectId: audit.objectId,
        requestedAt: audit.requestedAt,
        completedAt: audit.completedAt,
        expiresAt: audit.expiresAt,
        scope: audit.scope,
        resultCode: audit.resultCode,
      });
    }
    for (const record of registry.records.values()) {
      for (const sourceObjectId of record.sourceObjectIds) {
        const source = registry.records.get(sourceObjectId);
        if (!source) {
          if (record.status === 'ACTIVE' || !registry.deletionAudits.has(sourceObjectId)) {
            throw new Error('restored source dependency is missing');
          }
          continue;
        }
        if (record.status === 'ACTIVE' && source.status !== 'ACTIVE') {
          throw new Error('restored active data depends on an inactive source');
        }
        if (timestamp(source.createdAt, 'createdAt') > timestamp(record.createdAt, 'createdAt')) {
          throw new Error('restored derived data predates its source');
        }
      }
      if (record.sourceObjectIds.length > 0) {
        const sourceExpiries = record.sourceObjectIds.map(sourceObjectId => {
          const source = registry.records.get(sourceObjectId);
          if (source) return timestamp(source.expiresAt, 'source expiresAt');
          const audit = registry.deletionAudits.get(sourceObjectId);
          if (!audit) throw new Error('restored source dependency is missing');
          return timestamp(audit.expiresAt, 'source audit expiresAt');
        });
        if (record.expiresAt !== iso(Math.min(...sourceExpiries))) {
          throw new Error('restored derived expiry does not match its earliest source');
        }
      }
    }
    for (const record of registry.records.values()) registry.indexDependencies(record);
    return registry;
  }

  exportState(): DataLifecycleState {
    return {
      schemaVersion: 'data-lifecycle-v0.1',
      policyFingerprint: lifecyclePolicyFingerprint(this.policy),
      records: Array.from(this.records.values(), cloneRecord),
      deletionAudits: Array.from(this.deletionAudits.values(), audit => ({ ...audit })),
    };
  }

  registerSource(input: {
    objectId: string;
    kind: SourceDataKind;
    capturedAt: string;
    requiredDeletionSurfaces: readonly DeletionSurface[];
  }): DataLifecycleRecord {
    this.assertNewObjectId(input.objectId);
    if (!SOURCE_KINDS.has(input.kind)) throw new Error(`invalid source kind: ${input.kind}`);
    this.assertSurfaces(input.requiredDeletionSurfaces);
    const capturedMs = timestamp(input.capturedAt, 'capturedAt');
    const record: DataLifecycleRecord = {
      objectId: input.objectId,
      kind: input.kind,
      sourceObjectIds: [],
      requiredDeletionSurfaces: [...new Set(input.requiredDeletionSurfaces)],
      createdAt: input.capturedAt,
      capturedAt: input.capturedAt,
      expiresAt: iso(capturedMs + this.policy.retentionDays * DAY_MS),
      status: 'ACTIVE',
    };
    this.records.set(input.objectId, record);
    return cloneRecord(record);
  }

  registerDerived(input: {
    objectId: string;
    kind: DerivedDataKind;
    sourceObjectIds: readonly string[];
    createdAt: string;
    requiredDeletionSurfaces: readonly DeletionSurface[];
  }): DataLifecycleRecord {
    this.assertNewObjectId(input.objectId);
    if (!DERIVED_KINDS.has(input.kind)) throw new Error(`invalid derived kind: ${input.kind}`);
    this.assertSurfaces(input.requiredDeletionSurfaces);
    if (input.sourceObjectIds.length === 0) {
      throw new Error('derived data requires at least one source');
    }
    const createdMs = timestamp(input.createdAt, 'createdAt');
    const sources = input.sourceObjectIds.map(objectId => {
      const source = this.records.get(objectId);
      if (!source) throw new Error(`source not found: ${objectId}`);
      if (
        source.status !== 'ACTIVE'
        || timestamp(source.createdAt, 'createdAt') > createdMs
        || timestamp(source.capturedAt, 'capturedAt') > createdMs
        || timestamp(source.expiresAt, 'expiresAt') <= createdMs
      ) {
        throw new Error(`source is not active: ${objectId}`);
      }
      return source;
    });
    const earliestExpiryMs = Math.min(...sources.map(source => timestamp(source.expiresAt, 'expiresAt')));
    const earliestCaptureMs = Math.min(...sources.map(source => timestamp(source.capturedAt, 'capturedAt')));
    const record: DataLifecycleRecord = {
      objectId: input.objectId,
      kind: input.kind,
      sourceObjectIds: [...new Set(input.sourceObjectIds)],
      requiredDeletionSurfaces: [...new Set(input.requiredDeletionSurfaces)],
      createdAt: input.createdAt,
      capturedAt: iso(earliestCaptureMs),
      expiresAt: iso(earliestExpiryMs),
      status: 'ACTIVE',
    };
    this.records.set(input.objectId, record);
    this.indexDependencies(record);
    return cloneRecord(record);
  }

  get(objectId: string): DataLifecycleRecord | null {
    const record = this.records.get(objectId);
    return record ? cloneRecord(record) : null;
  }

  getDeletionAudit(objectId: string): ContentFreeDeletionAudit | null {
    const audit = this.deletionAudits.get(objectId);
    return audit ? { ...audit } : null;
  }

  isUsable(objectId: string, at: string): boolean {
    const record = this.records.get(objectId);
    if (!record || record.status !== 'ACTIVE') return false;
    return timestamp(at, 'at') < timestamp(record.expiresAt, 'expiresAt');
  }

  withdraw(
    objectId: string,
    requestedAt: string,
    reason: InvalidationReason
  ): DataLifecycleRecord[] {
    const requestedMs = timestamp(requestedAt, 'requestedAt');
    if (!INVALIDATION_REASONS.has(reason)) throw new Error('invalid withdrawal reason');
    if (this.deletionAudits.has(objectId)) return [];
    if (!this.records.has(objectId)) throw new Error(`object not found: ${objectId}`);
    const affectedIds = this.collectDependents(objectId);
    const affected: DataLifecycleRecord[] = [];
    for (const affectedId of affectedIds) {
      const record = this.records.get(affectedId);
      if (!record) continue;
      if (record.status === 'INVALIDATED' || record.status === 'DELETION_PENDING') {
        affected.push(cloneRecord(record));
        continue;
      }
      const next: DataLifecycleRecord = {
        ...record,
        status: 'INVALIDATED',
        invalidatedAt: requestedAt,
        invalidationReason: reason,
        deletionDueAt: iso(Math.min(
          requestedMs + this.policy.withdrawalDeletionSlaHours * HOUR_MS,
          timestamp(record.expiresAt, 'expiresAt')
        )),
      };
      this.records.set(affectedId, next);
      affected.push(cloneRecord(next));
    }
    return affected;
  }

  listDeletionDue(at: string): DataLifecycleRecord[] {
    const atMs = timestamp(at, 'at');
    return Array.from(this.records.values())
      .filter(record => (
        (record.status === 'INVALIDATED' || record.status === 'DELETION_PENDING')
        && record.deletionDueAt !== undefined
        && timestamp(record.deletionDueAt, 'deletionDueAt') <= atMs
      ))
      .map(cloneRecord);
  }

  listOverdueDeletions(at: string): DataLifecycleRecord[] {
    const atMs = timestamp(at, 'at');
    return Array.from(this.records.values())
      .filter(record => (
        (record.status === 'INVALIDATED' || record.status === 'DELETION_PENDING')
        && record.deletionDueAt !== undefined
        && timestamp(record.deletionDueAt, 'deletionDueAt') < atMs
      ))
      .map(cloneRecord);
  }

  markDeletionPending(objectId: string): DataLifecycleRecord {
    const record = this.requireRecord(objectId);
    if (record.status !== 'INVALIDATED' && record.status !== 'DELETION_PENDING') {
      throw new Error(`cannot mark ${record.status} data as deletion pending`);
    }
    const next = { ...record, status: 'DELETION_PENDING' as const };
    this.records.set(objectId, next);
    return cloneRecord(next);
  }

  markDeleted(
    objectId: string,
    completedAt: string,
    receipts: readonly DeletionReceipt[]
  ): ContentFreeDeletionAudit {
    const completedMs = timestamp(completedAt, 'completedAt');
    const record = this.requireRecord(objectId);
    if (record.status !== 'INVALIDATED' && record.status !== 'DELETION_PENDING') {
      throw new Error(`cannot delete ${record.status} data`);
    }
    if (!record.invalidatedAt || !record.deletionDueAt) {
      throw new Error('invalidation metadata is required before deletion');
    }
    const requestedMs = timestamp(record.invalidatedAt, 'invalidatedAt');
    if (completedMs < requestedMs) throw new Error('completedAt cannot be earlier than requestedAt');
    for (const dependentId of this.dependents.get(objectId) ?? []) {
      if (this.records.get(dependentId)?.status === 'ACTIVE') {
        throw new Error('cannot delete data while an active dependent remains');
      }
    }

    const receiptsBySurface = new Map<DeletionSurface, DeletionReceipt>();
    for (const receipt of receipts) {
      if (receiptsBySurface.has(receipt.surface)) throw new Error('duplicate deletion receipt');
      this.assertOpaqueObjectId(receipt.verificationId);
      if (!DELETION_SURFACES.has(receipt.surface)) throw new Error('invalid deletion surface');
      if (receipt.status !== 'DELETED' && receipt.status !== 'NOT_FOUND') {
        throw new Error('invalid deletion receipt status');
      }
      const receiptMs = timestamp(receipt.completedAt, 'receipt completedAt');
      if (receiptMs < requestedMs || receiptMs > completedMs) {
        throw new Error('deletion receipt time is outside the deletion interval');
      }
      receiptsBySurface.set(receipt.surface, { ...receipt });
    }
    for (const surface of record.requiredDeletionSurfaces) {
      if (!receiptsBySurface.has(surface)) throw new Error(`missing deletion receipt: ${surface}`);
    }
    for (const surface of receiptsBySurface.keys()) {
      if (!record.requiredDeletionSurfaces.includes(surface)) {
        throw new Error(`unexpected deletion receipt: ${surface}`);
      }
    }

    const audit: ContentFreeDeletionAudit = {
      objectId,
      requestedAt: record.invalidatedAt,
      completedAt,
      expiresAt: record.expiresAt,
      scope: record.kind,
      resultCode: completedMs <= timestamp(record.deletionDueAt, 'deletionDueAt')
        ? 'DELETED_WITHIN_SLA'
        : 'DELETED_AFTER_SLA',
    };
    this.records.delete(objectId);
    this.dependents.delete(objectId);
    for (const children of this.dependents.values()) children.delete(objectId);
    this.deletionAudits.set(objectId, audit);
    return { ...audit };
  }

  applyRetentionExpiry(at: string): DataLifecycleRecord[] {
    const atMs = timestamp(at, 'at');
    const expired = Array.from(this.records.values())
      .filter(record => record.status === 'ACTIVE' && timestamp(record.expiresAt, 'expiresAt') <= atMs)
      .map(record => record.objectId);
    const affectedIds = new Set<string>();
    for (const objectId of expired) {
      for (const affectedId of this.collectDependents(objectId)) affectedIds.add(affectedId);
    }

    const affected: DataLifecycleRecord[] = [];
    for (const objectId of affectedIds) {
      const record = this.records.get(objectId);
      if (!record || record.status !== 'ACTIVE') continue;
      const next: DataLifecycleRecord = {
        ...record,
        status: 'DELETION_PENDING',
        invalidatedAt: record.expiresAt,
        invalidationReason: 'retention_expired',
        deletionDueAt: record.expiresAt,
      };
      this.records.set(objectId, next);
      affected.push(cloneRecord(next));
    }
    return affected;
  }

  private assertOpaqueObjectId(objectId: string): void {
    if (!UUID_PATTERN.test(objectId)) throw new Error('objectId must be an opaque UUID');
  }

  private assertNewObjectId(objectId: string): void {
    this.assertOpaqueObjectId(objectId);
    if (this.records.has(objectId) || this.deletionAudits.has(objectId)) {
      throw new Error(`duplicate objectId: ${objectId}`);
    }
  }

  private assertSurfaces(surfaces: readonly DeletionSurface[]): void {
    if (surfaces.length === 0) throw new Error('at least one deletion surface is required');
    if (new Set(surfaces).size !== surfaces.length) {
      throw new Error('deletion surfaces must be unique');
    }
    for (const surface of surfaces) {
      if (!DELETION_SURFACES.has(surface)) throw new Error(`invalid deletion surface: ${surface}`);
    }
  }

  private requireRecord(objectId: string): DataLifecycleRecord {
    const record = this.records.get(objectId);
    if (!record) throw new Error(`object not found: ${objectId}`);
    return record;
  }

  private indexDependencies(record: DataLifecycleRecord): void {
    for (const sourceObjectId of record.sourceObjectIds) {
      const children = this.dependents.get(sourceObjectId) ?? new Set<string>();
      children.add(record.objectId);
      this.dependents.set(sourceObjectId, children);
    }
  }

  private collectDependents(rootObjectId: string): string[] {
    const ordered: string[] = [];
    const queue = [rootObjectId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const objectId = queue.shift();
      if (!objectId || visited.has(objectId)) continue;
      visited.add(objectId);
      ordered.push(objectId);
      for (const dependent of this.dependents.get(objectId) ?? []) queue.push(dependent);
    }
    return ordered;
  }
}
