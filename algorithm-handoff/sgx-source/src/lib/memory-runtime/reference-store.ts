import { createHash } from 'node:crypto';

import type {
  CandidateSubmissionContext,
  ConfirmationDecision,
  CorrectionContext,
  DeletedReferenceTombstone,
  DeterministicBusinessDecision,
  InvalidationAudit,
  MemoryCandidate,
  ReferenceRecord,
  ReferenceRetrievalRequest,
  ReferenceStoreSnapshot,
  SourcedAcceptanceDecision,
  StoredReference,
} from './contracts.ts';

export const referenceStoreMetadata = {
  storeId: 'sgx-in-memory-reference-store',
  storeVersion: '0.1.0',
  canonicalWriteCapability: false,
  decisionGatedActivationCapability: true,
  durable: false,
} as const;

type OperationResult = { fingerprint: string; recordId: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
}

function assertPersistableCandidate(candidate: MemoryCandidate): void {
  if (candidate.canonicalWritePerformed !== false) {
    throw new Error('canonical writes are forbidden in Reference Store');
  }
  if (candidate.evidenceRefs.length === 0) throw new Error('candidate requires evidenceRefs');
  if (['SESSION_ONLY', 'NO_MEMORY', 'BLOCKED'].includes(candidate.disposition)) {
    throw new Error(`disposition ${candidate.disposition} cannot be submitted for durable reference use`);
  }
  if (candidate.authorityState === 'DERIVED_UNSUPPORTED') {
    throw new Error('AI-derived unsupported content cannot enter Reference Store');
  }
}

function assertAutoWriteDecision(
  candidate: MemoryCandidate,
  decision: DeterministicBusinessDecision,
): void {
  if (candidate.disposition !== 'AUTO_WRITE' || candidate.writeEligibility !== 'ELIGIBLE_FOR_BUSINESS_GATE') {
    throw new Error('candidate is not eligible for the deterministic AUTO_WRITE business gate');
  }
  if (!decision.deterministic || !decision.approved) {
    throw new Error('AUTO_WRITE requires an approved deterministic business decision');
  }
  if (decision.policyVersion !== candidate.policyVersion) {
    throw new Error('business decision policyVersion does not match candidate policyVersion');
  }
  assertNonEmpty(decision.decisionId, 'decisionId');
  assertNonEmpty(decision.decidedAt, 'decidedAt');
}

function makeRecord(
  candidate: MemoryCandidate,
  logicalId: string,
  version: number,
  submittedAt: string,
  supersedesRecordId: string | null,
): ReferenceRecord {
  return {
    recordId: `${logicalId}:v${version}`,
    logicalId,
    version,
    status: 'CANDIDATE',
    candidate: clone(candidate),
    submittedAt,
    activatedAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    supersedesRecordId,
    supersededByRecordId: null,
    activationDecisionId: null,
    activationKind: null,
    activationAuthorityRef: null,
    attributedOnly: false,
  };
}

function isReferenceRecord(value: StoredReference): value is ReferenceRecord {
  return value.status !== 'DELETED';
}

export function assertValidReferenceRetrievalRequest(request: ReferenceRetrievalRequest): void {
  assertNonEmpty(request.subjectId, 'subjectId');
  assertNonEmpty(request.familySpaceId, 'familySpaceId');
  assertNonEmpty(request.purpose, 'purpose');
  assertNonEmpty(request.authorizationVersion, 'authorizationVersion');
  if (!Array.isArray(request.visibilityScope) || request.visibilityScope.length === 0) {
    throw new Error('visibilityScope must contain at least one scope');
  }
  for (const scope of request.visibilityScope) assertNonEmpty(scope, 'visibilityScope item');
  if (request.mode !== undefined && !['ORDINARY', 'REVIEW'].includes(request.mode)) {
    throw new Error('mode must be ORDINARY or REVIEW');
  }
  if ((request.mode ?? 'ORDINARY') === 'REVIEW') {
    assertNonEmpty(request.reviewAuthorityRef ?? '', 'reviewAuthorityRef');
  }
  if (request.asOf !== undefined) {
    assertNonEmpty(request.asOf, 'asOf');
    if (temporalBoundaryMillis(request.asOf, false) === null) {
      throw new Error('asOf must be a valid date or datetime');
    }
  }
}

function isoWeekBoundaryMillis(value: string, end: boolean): number | null {
  const match = /^(\d{4})-W(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - weekday + 1 + (week - 1) * 7);
  if (end) monday.setUTCDate(monday.getUTCDate() + 7);
  return end ? monday.getTime() - 1 : monday.getTime();
}

function temporalBoundaryMillis(value: string, end: boolean): number | null {
  const normalized = value.trim();
  const week = isoWeekBoundaryMillis(normalized, end);
  if (week !== null) return week;
  if (/^\d{4}$/u.test(normalized)) {
    const year = Number(normalized);
    return end ? Date.UTC(year + 1, 0, 1) - 1 : Date.UTC(year, 0, 1);
  }
  const month = /^(\d{4})-(\d{2})$/u.exec(normalized);
  if (month) {
    const year = Number(month[1]);
    const monthIndex = Number(month[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return null;
    return end ? Date.UTC(year, monthIndex + 1, 1) - 1 : Date.UTC(year, monthIndex, 1);
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (day) {
    const year = Number(day[1]);
    const monthIndex = Number(day[2]) - 1;
    const date = Number(day[3]);
    const start = Date.UTC(year, monthIndex, date);
    const reconstructed = new Date(start);
    if (
      monthIndex < 0
      || monthIndex > 11
      || reconstructed.getUTCFullYear() !== year
      || reconstructed.getUTCMonth() !== monthIndex
      || reconstructed.getUTCDate() !== date
    ) return null;
    return end ? start + 86_400_000 - 1 : start;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTemporallyUsable(record: ReferenceRecord, asOf: string | undefined): boolean {
  if (!asOf) return true;
  const point = temporalBoundaryMillis(asOf, false);
  if (point === null) return false;
  if (record.candidate.validFrom) {
    const lower = temporalBoundaryMillis(record.candidate.validFrom, false);
    if (lower === null || point < lower) return false;
  }
  if (record.candidate.validTo) {
    const upper = temporalBoundaryMillis(record.candidate.validTo, true);
    if (upper === null || point > upper) return false;
  }
  return true;
}

function scopeAllows(record: ReferenceRecord, request: ReferenceRetrievalRequest): boolean {
  const candidate = record.candidate;
  if (record.status !== 'ACTIVE') return false;
  if (candidate.subjectId !== request.subjectId) return false;
  if (candidate.familySpaceId !== request.familySpaceId) return false;
  if (
    candidate.authorizationVersion !== '*'
    && candidate.authorizationVersion !== request.authorizationVersion
  ) return false;
  if (!candidate.allowedUses.includes('*') && !candidate.allowedUses.includes(request.purpose)) return false;
  if (candidate.forbiddenUses.includes('*') || candidate.forbiddenUses.includes(request.purpose)) return false;
  if (
    !candidate.visibilityScope.includes('*')
    && !request.visibilityScope.every(scope => candidate.visibilityScope.includes(scope))
  ) return false;
  if ((request.mode ?? 'ORDINARY') === 'ORDINARY' && candidate.conflictState === 'OPEN') return false;
  if (!isTemporallyUsable(record, request.asOf)) return false;
  return true;
}

export class InMemoryReferenceStore {
  readonly canonicalWriteCapability = false;
  readonly decisionGatedActivationCapability = true;

  private readonly records = new Map<string, StoredReference>();
  private readonly withdrawnEvidenceRefs = new Set<string>();
  private readonly operationResults = new Map<string, OperationResult>();

  constructor(snapshot?: ReferenceStoreSnapshot) {
    if (snapshot) this.restoreSnapshot(snapshot);
  }

  submitCandidate(
    candidate: MemoryCandidate,
    context: CandidateSubmissionContext,
  ): ReferenceRecord {
    assertPersistableCandidate(candidate);
    assertNonEmpty(context.operationId, 'operationId');
    assertNonEmpty(context.submittedAt, 'submittedAt');
    const operationFingerprint = fingerprint({ action: 'submit', candidate, context });
    const replay = this.replay(context.operationId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);

    if (candidate.evidenceRefs.some(ref => this.withdrawnEvidenceRefs.has(ref))) {
      throw new Error('candidate depends on withdrawn evidence');
    }

    const existing = [...this.records.values()]
      .find(record => record.logicalId === candidate.claimId);
    if (existing?.status === 'DELETED') {
      throw new Error('a deleted logical reference cannot be recreated from an old candidate');
    }
    if (existing) {
      if (fingerprint(existing.candidate) !== fingerprint(candidate)) {
        throw new Error('claimId already exists with a different candidate payload');
      }
      this.remember(context.operationId, operationFingerprint, existing.recordId);
      return clone(existing);
    }

    const record = makeRecord(candidate, candidate.claimId, 1, context.submittedAt, null);
    this.records.set(record.recordId, record);
    this.remember(context.operationId, operationFingerprint, record.recordId);
    return clone(record);
  }

  approveAutoWrite(recordId: string, decision: DeterministicBusinessDecision): ReferenceRecord {
    const operationFingerprint = fingerprint({ action: 'approve-auto-write', recordId, decision });
    const replay = this.replay(decision.decisionId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);

    const record = this.requireReferenceRecord(recordId);
    this.assertActivatable(record);
    assertAutoWriteDecision(record.candidate, decision);
    const activated = this.activate(
      record,
      decision.decisionId,
      decision.decidedAt,
      'BUSINESS_POLICY',
      false,
      null,
    );
    this.remember(decision.decisionId, operationFingerprint, recordId);
    return clone(activated);
  }

  confirm(recordId: string, decision: ConfirmationDecision): ReferenceRecord {
    const operationFingerprint = fingerprint({ action: 'confirm', recordId, decision });
    const replay = this.replay(decision.confirmationId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);

    const record = this.requireReferenceRecord(recordId);
    this.assertActivatable(record);
    const disposition = record.candidate.disposition;
    if (!['C2_BATCH_CONFIRM', 'C3_STRONG_CONFIRM'].includes(disposition)) {
      throw new Error(`disposition ${disposition} cannot be activated by confirmation`);
    }
    if (disposition === 'C3_STRONG_CONFIRM' && decision.level !== 'C3') {
      throw new Error('C3_STRONG_CONFIRM requires a C3 confirmation');
    }
    assertNonEmpty(decision.confirmationId, 'confirmationId');
    assertNonEmpty(decision.actorId, 'actorId');
    assertNonEmpty(decision.actorRole, 'actorRole');
    if (decision.actorRole !== 'elder') assertNonEmpty(decision.authorityRef ?? '', 'authorityRef');
    assertNonEmpty(decision.confirmedAt, 'confirmedAt');
    const activated = this.activate(
      record,
      decision.confirmationId,
      decision.confirmedAt,
      'CONFIRMATION',
      false,
      decision.authorityRef ?? null,
    );
    this.remember(decision.confirmationId, operationFingerprint, recordId);
    return clone(activated);
  }

  acceptSourced(recordId: string, decision: SourcedAcceptanceDecision): ReferenceRecord {
    const operationFingerprint = fingerprint({ action: 'accept-sourced', recordId, decision });
    const replay = this.replay(decision.decisionId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);

    const record = this.requireReferenceRecord(recordId);
    this.assertActivatable(record);
    if (record.candidate.disposition !== 'SOURCED_ONLY') {
      throw new Error('only SOURCED_ONLY candidates can use sourced acceptance');
    }
    if (!['SOURCED_CLAIM', 'OBSERVATION'].includes(record.candidate.authorityState)) {
      throw new Error('sourced acceptance cannot upgrade content to an elder self-asserted fact');
    }
    assertNonEmpty(decision.decisionId, 'decisionId');
    assertNonEmpty(decision.actorId, 'actorId');
    assertNonEmpty(decision.actorRole, 'actorRole');
    if (decision.actorRole !== 'elder') assertNonEmpty(decision.authorityRef ?? '', 'authorityRef');
    assertNonEmpty(decision.acceptedAt, 'acceptedAt');
    const activated = this.activate(
      record,
      decision.decisionId,
      decision.acceptedAt,
      'SOURCED_ACCEPTANCE',
      true,
      decision.authorityRef ?? null,
    );
    this.remember(decision.decisionId, operationFingerprint, recordId);
    return clone(activated);
  }

  correct(
    recordId: string,
    correctedCandidate: MemoryCandidate,
    decision: DeterministicBusinessDecision,
    context: CorrectionContext,
  ): ReferenceRecord {
    assertPersistableCandidate(correctedCandidate);
    assertNonEmpty(context.operationId, 'operationId');
    assertNonEmpty(context.submittedAt, 'submittedAt');
    const operationFingerprint = fingerprint({
      action: 'correct',
      recordId,
      correctedCandidate,
      decision,
      context,
    });
    const replay = this.replay(context.operationId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);

    const prior = this.requireReferenceRecord(recordId);
    if (prior.status !== 'ACTIVE') throw new Error('only an ACTIVE reference can be corrected');
    if (
      correctedCandidate.subjectId !== prior.candidate.subjectId
      || correctedCandidate.familySpaceId !== prior.candidate.familySpaceId
    ) throw new Error('correction cannot change subjectId or familySpaceId');
    if (
      correctedCandidate.confirmationBasis !== 'explicit_item'
      && !correctedCandidate.reasonCodes.includes('ELDER_EXPLICIT_CORRECTION')
    ) throw new Error('correction requires an explicit correction candidate');
    if (correctedCandidate.evidenceRefs.some(ref => this.withdrawnEvidenceRefs.has(ref))) {
      throw new Error('correction depends on withdrawn evidence');
    }
    assertAutoWriteDecision(correctedCandidate, decision);

    const nextVersion = Math.max(...[...this.records.values()]
      .filter(record => record.logicalId === prior.logicalId)
      .map(record => record.version)) + 1;
    const next = makeRecord(
      correctedCandidate,
      prior.logicalId,
      nextVersion,
      context.submittedAt,
      prior.recordId,
    );
    const activated = this.activate(
      next,
      decision.decisionId,
      decision.decidedAt,
      'BUSINESS_POLICY',
      false,
      null,
    );
    prior.status = 'SUPERSEDED';
    prior.invalidatedAt = decision.decidedAt;
    prior.invalidationReason = 'CORRECTED_BY_NEW_VERSION';
    prior.supersededByRecordId = activated.recordId;
    this.records.set(prior.recordId, prior);
    this.records.set(activated.recordId, activated);
    this.remember(context.operationId, operationFingerprint, activated.recordId);
    return clone(activated);
  }

  revoke(recordId: string, audit: InvalidationAudit): ReferenceRecord {
    const operationFingerprint = fingerprint({ action: 'revoke', recordId, audit });
    const replay = this.replay(audit.actionId, operationFingerprint);
    if (replay) return this.requireReferenceRecord(replay.recordId);
    const record = this.requireReferenceRecord(recordId);
    if (record.status === 'SUPERSEDED') throw new Error('a SUPERSEDED version cannot be revoked as current');
    if (record.status !== 'REVOKED') {
      record.status = 'REVOKED';
      record.invalidatedAt = audit.occurredAt;
      record.invalidationReason = audit.reasonCode;
      this.records.set(record.recordId, record);
    }
    this.remember(audit.actionId, operationFingerprint, recordId);
    return clone(record);
  }

  delete(recordId: string, audit: InvalidationAudit): DeletedReferenceTombstone {
    const operationFingerprint = fingerprint({ action: 'delete', recordId, audit });
    const replay = this.replay(audit.actionId, operationFingerprint);
    if (replay) return this.requireTombstone(replay.recordId);
    const existing = this.records.get(recordId);
    if (!existing) throw new Error(`unknown reference record ${recordId}`);
    const logicalId = existing.logicalId;
    for (const version of this.records.values()) {
      if (version.logicalId !== logicalId || version.status === 'DELETED') continue;
      const versionTombstone: DeletedReferenceTombstone = {
        recordId: version.recordId,
        logicalId: version.logicalId,
        version: version.version,
        status: 'DELETED',
        deletedAt: audit.occurredAt,
        reasonCode: audit.reasonCode,
      };
      this.records.set(version.recordId, versionTombstone);
    }
    const tombstone = this.requireTombstone(recordId);
    this.remember(audit.actionId, operationFingerprint, recordId);
    return tombstone;
  }

  /** Source withdrawal can delete one obsolete version without erasing a separately sourced correction. */
  deleteVersion(recordId: string, audit: InvalidationAudit): DeletedReferenceTombstone {
    const operationFingerprint = fingerprint({ action: 'deleteVersion', recordId, audit });
    const replay = this.replay(audit.actionId, operationFingerprint);
    if (replay) return this.requireTombstone(replay.recordId);
    const existing = this.records.get(recordId);
    if (!existing) throw new Error(`unknown reference record ${recordId}`);
    const tombstone: DeletedReferenceTombstone = {
      recordId: existing.recordId, logicalId: existing.logicalId, version: existing.version,
      status: 'DELETED', deletedAt: audit.occurredAt, reasonCode: audit.reasonCode,
    };
    this.records.set(recordId, tombstone);
    this.remember(audit.actionId, operationFingerprint, recordId);
    return clone(tombstone);
  }

  withdrawEvidence(evidenceRef: string, audit: InvalidationAudit): string[] {
    assertNonEmpty(evidenceRef, 'evidenceRef');
    this.withdrawnEvidenceRefs.add(evidenceRef);
    const affected: string[] = [];
    for (const record of this.records.values()) {
      if (!isReferenceRecord(record) || !record.candidate.evidenceRefs.includes(evidenceRef)) continue;
      affected.push(record.recordId);
      if (record.status === 'CANDIDATE' || record.status === 'ACTIVE') {
        record.status = 'REVOKED';
        record.invalidatedAt = audit.occurredAt;
        record.invalidationReason = `EVIDENCE_WITHDRAWN:${audit.reasonCode}`;
        this.records.set(record.recordId, record);
      }
    }
    return affected.sort();
  }

  retrieve(request: ReferenceRetrievalRequest): ReferenceRecord[] {
    assertValidReferenceRetrievalRequest(request);
    return [...this.records.values()]
      .filter(isReferenceRecord)
      .filter(record => this.isUsable(record, request))
      .sort((left, right) => (
        left.logicalId.localeCompare(right.logicalId) || right.version - left.version
      ))
      .map(clone);
  }

  isRecordUsable(recordId: string, request: ReferenceRetrievalRequest): boolean {
    assertValidReferenceRetrievalRequest(request);
    const stored = this.records.get(recordId);
    return Boolean(stored && isReferenceRecord(stored) && this.isUsable(stored, request));
  }

  get(recordId: string): StoredReference | null {
    const record = this.records.get(recordId);
    return record ? clone(record) : null;
  }

  exportSnapshot(): ReferenceStoreSnapshot {
    return clone({
      snapshotVersion: 'sgx-reference-store-v1',
      records: [...this.records.values()],
      withdrawnEvidenceRefs: [...this.withdrawnEvidenceRefs].sort(),
      operationResults: [...this.operationResults.entries()],
    });
  }

  static restore(snapshot: ReferenceStoreSnapshot): InMemoryReferenceStore {
    return new InMemoryReferenceStore(snapshot);
  }

  private activate(
    record: ReferenceRecord,
    decisionId: string,
    activatedAt: string,
    kind: NonNullable<ReferenceRecord['activationKind']>,
    attributedOnly: boolean,
    authorityRef: string | null,
  ): ReferenceRecord {
    record.status = 'ACTIVE';
    record.activatedAt = activatedAt;
    record.activationDecisionId = decisionId;
    record.activationKind = kind;
    record.activationAuthorityRef = authorityRef;
    record.attributedOnly = attributedOnly;
    this.records.set(record.recordId, record);
    return record;
  }

  private assertActivatable(record: ReferenceRecord): void {
    if (record.status !== 'CANDIDATE') {
      throw new Error(`illegal transition from ${record.status} to ACTIVE`);
    }
    if (record.candidate.evidenceRefs.some(ref => this.withdrawnEvidenceRefs.has(ref))) {
      throw new Error('candidate depends on withdrawn evidence');
    }
  }

  private isUsable(record: ReferenceRecord, request: ReferenceRetrievalRequest): boolean {
    if (!scopeAllows(record, request)) return false;
    if (record.candidate.evidenceRefs.some(ref => this.withdrawnEvidenceRefs.has(ref))) return false;
    return true;
  }

  private replay(operationId: string, operationFingerprint: string): OperationResult | null {
    const existing = this.operationResults.get(operationId);
    if (!existing) return null;
    if (existing.fingerprint !== operationFingerprint) {
      throw new Error('operationId reused with a different payload');
    }
    return existing;
  }

  private remember(
    operationId: string,
    operationFingerprint: string,
    recordId: string,
  ): void {
    this.operationResults.set(operationId, { fingerprint: operationFingerprint, recordId });
  }

  private requireReferenceRecord(recordId: string): ReferenceRecord {
    const record = this.records.get(recordId);
    if (!record) throw new Error(`unknown reference record ${recordId}`);
    if (!isReferenceRecord(record)) throw new Error(`reference record ${recordId} is deleted`);
    return clone(record);
  }

  private requireTombstone(recordId: string): DeletedReferenceTombstone {
    const record = this.records.get(recordId);
    if (!record || record.status !== 'DELETED') {
      throw new Error(`reference record ${recordId} is not deleted`);
    }
    return clone(record);
  }

  private restoreSnapshot(snapshot: ReferenceStoreSnapshot): void {
    if (snapshot.snapshotVersion !== 'sgx-reference-store-v1') {
      throw new Error('unsupported Reference Store snapshot version');
    }
    const activeByLogicalId = new Set<string>();
    for (const rawRecord of snapshot.records) {
      const record = clone(rawRecord);
      if (record.status === 'DELETED') {
        const keys = Object.keys(record).sort();
        const allowed = ['deletedAt', 'logicalId', 'reasonCode', 'recordId', 'status', 'version'].sort();
        if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
          throw new Error('deleted tombstone must not contain content');
        }
      } else {
        assertPersistableCandidate(record.candidate);
        if (record.status === 'ACTIVE') {
          if (activeByLogicalId.has(record.logicalId)) {
            throw new Error(`multiple ACTIVE versions for ${record.logicalId}`);
          }
          activeByLogicalId.add(record.logicalId);
        }
      }
      if (this.records.has(record.recordId)) throw new Error(`duplicate recordId ${record.recordId}`);
      this.records.set(record.recordId, record);
    }
    for (const evidenceRef of snapshot.withdrawnEvidenceRefs) this.withdrawnEvidenceRefs.add(evidenceRef);
    for (const [operationId, result] of snapshot.operationResults) {
      if (!this.records.has(result.recordId)) throw new Error('operation result points to an unknown record');
      this.operationResults.set(operationId, clone(result));
    }
  }
}
