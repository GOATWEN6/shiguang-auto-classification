import { createHash, randomUUID } from 'node:crypto';

import type { TranscriptEvidence } from '../asr-runtime/contracts.ts';
import {
  assertExactKeys,
  assertExactRuntimeIdentity,
  assertFiniteNonNegative,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertPlainRecord,
  assertTimestamp,
  cloneIdentity,
  sameExactIdentity,
  stableFingerprint,
  type AsrPartialObservationRequest,
  type AsrPartialObservationResult,
  type AsrTurnFinalRequest,
  type FinalEvidenceCommit,
  type FinalEvidenceReader,
  type FinalTurnEvidence,
  type GovernedIdFactory,
  type GovernedSessionStoreReader,
  type GovernedTurnHandle,
  type TrustedOpenTurnContext,
  type TypedTextFinalRequest,
  type TurnEvidenceInvalidationAudit,
  type TurnEvidenceTombstone,
} from './contracts.ts';

export interface InMemoryTurnEvidenceStoreOptions {
  idFactory?: GovernedIdFactory;
  /** Server clock; retention never trusts a client-provided receivedAt. */
  now?: () => string;
  /** Strictly validated durable state. ASR partials and raw audio are never part of it. */
  snapshot?: TurnEvidenceStoreSnapshot;
  /** Synchronous persistence hook invoked only after a state-changing operation. */
  onMutation?: (snapshot: TurnEvidenceStoreSnapshot) => void;
}

interface IdempotentEvidenceCommit {
  fingerprint: string;
  evidenceId: string;
}

export interface PersistedFinalTurnEvidence {
  evidence: FinalTurnEvidence;
  expiresAt: string;
}

export interface PersistedEvidenceOperation {
  operationKey: string;
  /** SHA-256 only. The request body is never retained as idempotency metadata. */
  fingerprint: string;
  evidenceId: string;
  status: 'ACTIVE' | 'INVALIDATED';
}

export interface PersistedAsrSourceBinding {
  evidenceId: string;
  /** SHA-256 only. No transcript segment or audio is retained here. */
  fingerprint: string;
}

export interface TurnEvidenceStoreSnapshot {
  schemaVersion: 'turn-evidence-store-snapshot-v0.1';
  activeEvidence: PersistedFinalTurnEvidence[];
  invalidations: TurnEvidenceTombstone[];
  operations: PersistedEvidenceOperation[];
  asrSourceBindings: PersistedAsrSourceBinding[];
  issuedEvidenceIds: string[];
  purgedEvidenceIds: string[];
}

const RETENTION_DURATION_MS = 40 * 24 * 60 * 60 * 1_000;
const INVALIDATION_PURGE_DELAY_MS = 24 * 60 * 60 * 1_000;

function opaqueFingerprint(value: unknown): string {
  return createHash('sha256').update(stableFingerprint(value)).digest('hex');
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 fingerprint`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${field} must not contain duplicates`);
  }
}

function assertFinalTurnEvidence(value: unknown, field: string): asserts value is FinalTurnEvidence {
  assertPlainRecord(value, field);
  assertExactKeys(value, [
    'schemaVersion',
    'evidenceId',
    'source',
    'sourceRefs',
    'sessionId',
    'identity',
    'text',
    'receivedAt',
    'purpose',
    'actorId',
    'subjectId',
    'familySpaceId',
    'authorizationVersion',
    'visibilityScope',
  ], field);
  if (value.schemaVersion !== 'turn-evidence-v0.1') {
    throw new TypeError(`${field}.schemaVersion must be turn-evidence-v0.1`);
  }
  assertNonEmptyString(value.evidenceId, `${field}.evidenceId`);
  if (value.source !== 'TYPED_TEXT' && value.source !== 'ASR_FINAL') {
    throw new TypeError(`${field}.source must be TYPED_TEXT or ASR_FINAL`);
  }
  assertStringArray(value.sourceRefs, `${field}.sourceRefs`);
  if (value.source === 'TYPED_TEXT' && value.sourceRefs.length !== 0) {
    throw new TypeError(`${field}.sourceRefs must be empty for TYPED_TEXT`);
  }
  if (value.source === 'ASR_FINAL' && value.sourceRefs.length === 0) {
    throw new TypeError(`${field}.sourceRefs must not be empty for ASR_FINAL`);
  }
  assertNonEmptyString(value.sessionId, `${field}.sessionId`);
  assertExactRuntimeIdentity(value.identity, `${field}.identity`);
  if (value.identity.evidenceRefs.length !== 0) {
    throw new TypeError(`${field}.identity.evidenceRefs must be empty before binding`);
  }
  assertNonEmptyString(value.text, `${field}.text`);
  assertTimestamp(value.receivedAt, `${field}.receivedAt`);
  if (value.purpose !== 'daily_chat' && value.purpose !== 'formal_interview') {
    throw new TypeError(`${field}.purpose must be daily_chat or formal_interview`);
  }
  assertNonEmptyString(value.actorId, `${field}.actorId`);
  assertNonEmptyString(value.subjectId, `${field}.subjectId`);
  assertNonEmptyString(value.familySpaceId, `${field}.familySpaceId`);
  assertNonEmptyString(value.authorizationVersion, `${field}.authorizationVersion`);
  assertStringArray(value.visibilityScope, `${field}.visibilityScope`);
  if (value.visibilityScope.length === 0) {
    throw new TypeError(`${field}.visibilityScope must not be empty`);
  }
}

function assertTombstone(value: unknown, field: string): asserts value is TurnEvidenceTombstone {
  assertPlainRecord(value, field);
  assertExactKeys(value, [
    'evidenceId', 'status', 'invalidatedAt', 'deleteBy', 'reasonCode',
  ], field);
  assertNonEmptyString(value.evidenceId, `${field}.evidenceId`);
  if (value.status !== 'INVALIDATED') {
    throw new TypeError(`${field}.status must be INVALIDATED`);
  }
  assertTimestamp(value.invalidatedAt, `${field}.invalidatedAt`);
  assertTimestamp(value.deleteBy, `${field}.deleteBy`);
  if (Date.parse(value.deleteBy) < Date.parse(value.invalidatedAt)) {
    throw new TypeError(`${field}.deleteBy must not precede invalidatedAt`);
  }
  assertNonEmptyString(value.reasonCode, `${field}.reasonCode`);
}

function assertSnapshot(value: unknown): asserts value is TurnEvidenceStoreSnapshot {
  assertPlainRecord(value, 'snapshot');
  assertExactKeys(value, [
    'schemaVersion',
    'activeEvidence',
    'invalidations',
    'operations',
    'asrSourceBindings',
    'issuedEvidenceIds',
    'purgedEvidenceIds',
  ], 'snapshot');
  if (value.schemaVersion !== 'turn-evidence-store-snapshot-v0.1') {
    throw new TypeError('snapshot.schemaVersion must be turn-evidence-store-snapshot-v0.1');
  }
  if (!Array.isArray(value.activeEvidence)) {
    throw new TypeError('snapshot.activeEvidence must be an array');
  }
  value.activeEvidence.forEach((entry, index) => {
    const field = `snapshot.activeEvidence[${index}]`;
    assertPlainRecord(entry, field);
    assertExactKeys(entry, ['evidence', 'expiresAt'], field);
    assertFinalTurnEvidence(entry.evidence, `${field}.evidence`);
    assertTimestamp(entry.expiresAt, `${field}.expiresAt`);
  });
  if (!Array.isArray(value.invalidations)) {
    throw new TypeError('snapshot.invalidations must be an array');
  }
  value.invalidations.forEach((entry, index) => (
    assertTombstone(entry, `snapshot.invalidations[${index}]`)
  ));
  if (!Array.isArray(value.operations)) {
    throw new TypeError('snapshot.operations must be an array');
  }
  value.operations.forEach((entry, index) => {
    const field = `snapshot.operations[${index}]`;
    assertPlainRecord(entry, field);
    assertExactKeys(entry, ['operationKey', 'fingerprint', 'evidenceId', 'status'], field);
    assertSha256(entry.operationKey, `${field}.operationKey`);
    assertSha256(entry.fingerprint, `${field}.fingerprint`);
    assertNonEmptyString(entry.evidenceId, `${field}.evidenceId`);
    if (entry.status !== 'ACTIVE' && entry.status !== 'INVALIDATED') {
      throw new TypeError(`${field}.status must be ACTIVE or INVALIDATED`);
    }
  });
  if (!Array.isArray(value.asrSourceBindings)) {
    throw new TypeError('snapshot.asrSourceBindings must be an array');
  }
  value.asrSourceBindings.forEach((entry, index) => {
    const field = `snapshot.asrSourceBindings[${index}]`;
    assertPlainRecord(entry, field);
    assertExactKeys(entry, ['evidenceId', 'fingerprint'], field);
    assertNonEmptyString(entry.evidenceId, `${field}.evidenceId`);
    assertSha256(entry.fingerprint, `${field}.fingerprint`);
  });
  assertStringArray(value.issuedEvidenceIds, 'snapshot.issuedEvidenceIds');
  assertStringArray(value.purgedEvidenceIds, 'snapshot.purgedEvidenceIds');
}

function defaultIdFactory(): GovernedIdFactory {
  return { next: kind => `${kind}:${randomUUID()}` };
}

function identityCoreKey(identity: GovernedTurnHandle['identity']): string {
  return JSON.stringify([
    identity.sessionEpoch,
    identity.turnId,
    identity.generationId,
    identity.invocationId,
  ]);
}

function operationKeyFor(identity: GovernedTurnHandle['identity'], idempotencyToken: string): string {
  return opaqueFingerprint({ identityCoreKey: identityCoreKey(identity), idempotencyToken });
}

function assertPartial(value: unknown): asserts value is AsrPartialObservationRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'partialId', 'text', 'receivedAt'], 'request');
  if (value.schemaVersion !== 'asr-partial-observation-v0.1') {
    throw new TypeError('request.schemaVersion must be asr-partial-observation-v0.1');
  }
  assertNonEmptyString(value.partialId, 'request.partialId');
  if (typeof value.text !== 'string') throw new TypeError('request.text must be a string');
  assertTimestamp(value.receivedAt, 'request.receivedAt');
}

function assertTypedFinal(value: unknown): asserts value is TypedTextFinalRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'idempotencyToken', 'text', 'receivedAt'], 'request');
  if (value.schemaVersion !== 'typed-text-final-v0.1') {
    throw new TypeError('request.schemaVersion must be typed-text-final-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertNonEmptyString(value.text, 'request.text');
  assertTimestamp(value.receivedAt, 'request.receivedAt');
}

function assertTranscriptEvidence(value: unknown, field: string): asserts value is TranscriptEvidence {
  assertPlainRecord(value, field);
  assertExactKeys(value, [
    'kind',
    'evidenceId',
    'segmentKey',
    'identity',
    'attemptId',
    'connectionId',
    'receivedAt',
    'providerSequence',
    'providerPacketFingerprint',
    'segmentIndex',
    'revision',
    'text',
    'providerSegmentId',
    'startTimeMs',
    'endTimeMs',
  ], field);
  if (value.kind !== 'transcript_final') throw new TypeError(`${field}.kind must be transcript_final`);
  assertNonEmptyString(value.evidenceId, `${field}.evidenceId`);
  assertNonEmptyString(value.segmentKey, `${field}.segmentKey`);
  assertExactRuntimeIdentity(value.identity, `${field}.identity`);
  assertNonEmptyString(value.attemptId, `${field}.attemptId`);
  assertNonEmptyString(value.connectionId, `${field}.connectionId`);
  assertTimestamp(value.receivedAt, `${field}.receivedAt`);
  assertNonNegativeInteger(value.providerSequence, `${field}.providerSequence`);
  if (value.providerPacketFingerprint !== undefined) {
    assertNonEmptyString(value.providerPacketFingerprint, `${field}.providerPacketFingerprint`);
  }
  assertNonNegativeInteger(value.segmentIndex, `${field}.segmentIndex`);
  assertNonNegativeInteger(value.revision, `${field}.revision`);
  assertNonEmptyString(value.text, `${field}.text`);
  if (value.providerSegmentId !== undefined) {
    assertNonEmptyString(value.providerSegmentId, `${field}.providerSegmentId`);
  }
  if (value.startTimeMs !== undefined) {
    assertFiniteNonNegative(value.startTimeMs, `${field}.startTimeMs`);
  }
  if (value.endTimeMs !== undefined) {
    assertFiniteNonNegative(value.endTimeMs, `${field}.endTimeMs`);
  }
  if (
    value.startTimeMs !== undefined
    && value.endTimeMs !== undefined
    && value.endTimeMs < value.startTimeMs
  ) throw new TypeError(`${field}.endTimeMs must not precede startTimeMs`);
}

function assertAsrFinal(value: unknown): asserts value is AsrTurnFinalRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'idempotencyToken', 'receivedAt', 'segments'], 'request');
  if (value.schemaVersion !== 'asr-turn-final-v0.1') {
    throw new TypeError('request.schemaVersion must be asr-turn-final-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertTimestamp(value.receivedAt, 'request.receivedAt');
  if (!Array.isArray(value.segments) || value.segments.length === 0) {
    throw new TypeError('request.segments must be a non-empty array');
  }
  value.segments.forEach((segment, index) => assertTranscriptEvidence(segment, `request.segments[${index}]`));
  for (let index = 1; index < value.segments.length; index += 1) {
    const prior = value.segments[index - 1];
    const current = value.segments[index];
    if (current.segmentIndex <= prior.segmentIndex) {
      throw new TypeError('request.segments must have strictly increasing segmentIndex values');
    }
    if (current.providerSequence <= prior.providerSequence) {
      throw new TypeError('request.segments must have strictly increasing providerSequence values');
    }
  }
  const refs = value.segments.map(segment => segment.evidenceId);
  if (new Set(refs).size !== refs.length) {
    throw new TypeError('request.segments evidenceId values must be unique');
  }
}

function cloneEvidence(value: FinalTurnEvidence): FinalTurnEvidence {
  return structuredClone({
    ...value,
    sourceRefs: [...value.sourceRefs],
    identity: cloneIdentity(value.identity),
    visibilityScope: [...value.visibilityScope],
  });
}

function cloneCommit(value: FinalEvidenceCommit): FinalEvidenceCommit {
  return structuredClone({
    evidence: cloneEvidence(value.evidence),
    boundTurn: value.boundTurn,
  });
}

function sameEvidenceScope(left: FinalTurnEvidence, right: FinalTurnEvidence): boolean {
  return left.sessionId === right.sessionId
    && left.identity.sessionEpoch === right.identity.sessionEpoch
    && left.actorId === right.actorId
    && left.subjectId === right.subjectId
    && left.familySpaceId === right.familySpaceId
    && left.authorizationVersion === right.authorizationVersion
    && JSON.stringify([...left.visibilityScope].sort()) === JSON.stringify([...right.visibilityScope].sort());
}

function recordFor(
  evidenceId: string,
  source: FinalTurnEvidence['source'],
  sourceRefs: readonly string[],
  text: string,
  receivedAt: string,
  context: TrustedOpenTurnContext,
): FinalTurnEvidence {
  return {
    schemaVersion: 'turn-evidence-v0.1',
    evidenceId,
    source,
    sourceRefs: [...sourceRefs],
    sessionId: context.sessionId,
    identity: cloneIdentity(context.identity),
    text,
    receivedAt,
    purpose: context.mode === 'DAILY_CHAT' ? 'daily_chat' : 'formal_interview',
    actorId: context.authority.actorId,
    subjectId: context.authority.subjectId,
    familySpaceId: context.authority.familySpaceId,
    authorizationVersion: context.authority.authorizationVersion,
    visibilityScope: [...context.authority.visibilityScope],
  };
}

export class InMemoryTurnEvidenceStore implements FinalEvidenceReader {
  private readonly sessions: GovernedSessionStoreReader;
  private readonly idFactory: GovernedIdFactory;
  private readonly now: () => string;
  private readonly onMutation?: (snapshot: TurnEvidenceStoreSnapshot) => void;
  private readonly issuedEvidenceIds = new Set<string>();
  private readonly finalEvidence = new Map<string, FinalTurnEvidence>();
  private readonly evidenceOrderBySession = new Map<string, string[]>();
  private readonly invalidatedEvidence = new Map<string, TurnEvidenceTombstone>();
  private readonly operations = new Map<string, IdempotentEvidenceCommit>();
  private readonly asrSourceFingerprints = new Map<string, string>();
  private readonly expiresAt = new Map<string, number>();
  private readonly purgedEvidenceIds = new Set<string>();

  constructor(
    sessions: GovernedSessionStoreReader,
    options: InMemoryTurnEvidenceStoreOptions = {},
  ) {
    if (!sessions) throw new TypeError('sessions is required');
    this.sessions = sessions;
    this.idFactory = options.idFactory ?? defaultIdFactory();
    this.now = options.now ?? (() => new Date().toISOString());
    this.onMutation = options.onMutation;
    if (!this.idFactory || typeof this.idFactory.next !== 'function') {
      throw new TypeError('idFactory.next must be a function');
    }
    if (this.onMutation !== undefined && typeof this.onMutation !== 'function') {
      throw new TypeError('onMutation must be a function');
    }
    if (options.snapshot !== undefined) this.restoreSnapshot(options.snapshot);
  }

  static restore(
    sessions: GovernedSessionStoreReader,
    snapshot: TurnEvidenceStoreSnapshot,
    options: Omit<InMemoryTurnEvidenceStoreOptions, 'snapshot'> = {},
  ): InMemoryTurnEvidenceStore {
    return new InMemoryTurnEvidenceStore(sessions, { ...options, snapshot });
  }

  observeAsrPartial(
    handle: GovernedTurnHandle,
    request: AsrPartialObservationRequest,
  ): AsrPartialObservationResult {
    assertPartial(request);
    this.sessions.resolveTurnHandle(handle);
    return { status: 'WAIT' };
  }

  commitTypedText(
    handle: GovernedTurnHandle,
    request: TypedTextFinalRequest,
  ): FinalEvidenceCommit {
    assertTypedFinal(request);
    const context = this.sessions.resolveTurnHandle(handle);
    const fingerprint = opaqueFingerprint({ identity: handle?.identity, request });
    const operationKey = operationKeyFor(handle.identity, request.idempotencyToken);
    const replay = this.operations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      const evidence = this.get(replay.evidenceId);
      if (!evidence) {
        throw new Error('final evidence has been invalidated');
      }
      const boundTurn = this.sessions.bindEvidence(handle, [replay.evidenceId]);
      return cloneCommit({ evidence, boundTurn });
    }
    const evidenceId = this.nextEvidenceId();
    const record = recordFor(
      evidenceId,
      'TYPED_TEXT',
      [],
      request.text,
      request.receivedAt,
      context,
    );
    const boundTurn = this.sessions.bindEvidence(handle, [evidenceId]);
    const result = { evidence: record, boundTurn };
    this.finalEvidence.set(evidenceId, cloneEvidence(record));
    this.rememberExpiry(evidenceId);
    this.rememberSessionOrder(record.sessionId, evidenceId);
    this.operations.set(operationKey, { fingerprint, evidenceId });
    this.emitMutation();
    return cloneCommit(result);
  }

  commitAsrFinal(
    handle: GovernedTurnHandle,
    request: AsrTurnFinalRequest,
  ): FinalEvidenceCommit {
    assertAsrFinal(request);
    const context = this.sessions.resolveTurnHandle(handle);
    const fingerprint = opaqueFingerprint({ identity: handle?.identity, request });
    const operationKey = operationKeyFor(handle.identity, request.idempotencyToken);
    const replay = this.operations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      const evidence = this.get(replay.evidenceId);
      if (!evidence) {
        throw new Error('final evidence has been invalidated');
      }
      const boundTurn = this.sessions.bindEvidence(handle, [replay.evidenceId]);
      return cloneCommit({ evidence, boundTurn });
    }
    for (const [index, segment] of request.segments.entries()) {
      if (!sameExactIdentity(segment.identity, context.identity)) {
        throw new Error(`request.segments[${index}].identity does not match the governed turn`);
      }
      const segmentFingerprint = opaqueFingerprint(segment);
      const existing = this.asrSourceFingerprints.get(segment.evidenceId);
      if (existing !== undefined && existing !== segmentFingerprint) {
        throw new Error('ASR evidence ref reused with a different payload');
      }
      if (existing !== undefined) {
        throw new Error('ASR evidence ref is already bound to another final turn');
      }
    }
    const evidenceId = this.nextEvidenceId();
    const record = recordFor(
      evidenceId,
      'ASR_FINAL',
      request.segments.map(segment => segment.evidenceId),
      request.segments.map(segment => segment.text).join(''),
      request.receivedAt,
      context,
    );
    const boundTurn = this.sessions.bindEvidence(handle, [evidenceId]);
    for (const segment of request.segments) {
      this.asrSourceFingerprints.set(segment.evidenceId, opaqueFingerprint(segment));
    }
    const result = { evidence: record, boundTurn };
    this.finalEvidence.set(evidenceId, cloneEvidence(record));
    this.rememberExpiry(evidenceId);
    this.rememberSessionOrder(record.sessionId, evidenceId);
    this.operations.set(operationKey, { fingerprint, evidenceId });
    this.emitMutation();
    return cloneCommit(result);
  }

  get(evidenceId: string): FinalTurnEvidence | null {
    assertNonEmptyString(evidenceId, 'evidenceId');
    const value = this.finalEvidence.get(evidenceId);
    return value && !this.isExpired(evidenceId, this.now()) ? cloneEvidence(value) : null;
  }

  /** Trusted server deadline, for outputs derived from this source. */
  getExpiresAt(evidenceId: string): string | null {
    if (!this.get(evidenceId)) return null;
    const expiry = this.expiresAt.get(evidenceId);
    return expiry === undefined ? null : new Date(expiry).toISOString();
  }

  getPreviousCompletedInSession(currentEvidenceId: string): FinalTurnEvidence | null {
    assertNonEmptyString(currentEvidenceId, 'currentEvidenceId');
    const current = this.get(currentEvidenceId);
    if (!current) return null;
    const order = this.evidenceOrderBySession.get(current.sessionId) ?? [];
    const index = order.indexOf(currentEvidenceId);
    if (index <= 0) return null;
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = this.get(order[candidateIndex]);
      if (!candidate) continue;
      if (sameEvidenceScope(candidate, current)) return cloneEvidence(candidate);
    }
    return null;
  }

  /** Includes the current control turn; never crosses an epoch or authority scope. */
  listCompletedInSession(currentEvidenceId: string): FinalTurnEvidence[] {
    const current = this.get(currentEvidenceId);
    if (!current) return [];
    const order = this.evidenceOrderBySession.get(current.sessionId) ?? [];
    const currentIndex = order.indexOf(currentEvidenceId);
    if (currentIndex < 0) return [];
    return order.slice(0, currentIndex + 1)
      .map(evidenceId => this.get(evidenceId))
      .filter((value): value is FinalTurnEvidence => Boolean(value && sameEvidenceScope(value, current)));
  }

  invalidateEvidence(
    evidenceId: string,
    audit: TurnEvidenceInvalidationAudit,
  ): TurnEvidenceTombstone | null {
    assertNonEmptyString(evidenceId, 'evidenceId');
    assertPlainRecord(audit, 'audit');
    assertExactKeys(audit, ['actionId', 'actorId', 'occurredAt', 'reasonCode'], 'audit');
    assertNonEmptyString(audit.actionId, 'audit.actionId');
    assertNonEmptyString(audit.actorId, 'audit.actorId');
    assertTimestamp(audit.occurredAt, 'audit.occurredAt');
    assertNonEmptyString(audit.reasonCode, 'audit.reasonCode');
    const replay = this.invalidatedEvidence.get(evidenceId);
    if (replay) return structuredClone(replay);
    if (!this.finalEvidence.has(evidenceId)) return null;
    const deleteBy = new Date(Date.parse(audit.occurredAt) + INVALIDATION_PURGE_DELAY_MS).toISOString();
    const tombstone: TurnEvidenceTombstone = {
      evidenceId,
      status: 'INVALIDATED',
      invalidatedAt: audit.occurredAt,
      deleteBy,
      reasonCode: audit.reasonCode,
    };
    this.finalEvidence.delete(evidenceId);
    this.expiresAt.delete(evidenceId);
    this.invalidatedEvidence.set(evidenceId, tombstone);
    this.emitMutation();
    return structuredClone(tombstone);
  }

  getInvalidation(evidenceId: string): TurnEvidenceTombstone | null {
    assertNonEmptyString(evidenceId, 'evidenceId');
    const tombstone = this.invalidatedEvidence.get(evidenceId);
    return tombstone ? structuredClone(tombstone) : null;
  }

  purgeInvalidatedDue(now: string): string[] {
    assertTimestamp(now, 'now');
    const cutoff = Date.parse(now);
    const due = [...this.invalidatedEvidence.values()]
      .filter(tombstone => Date.parse(tombstone.deleteBy) <= cutoff
        && !this.purgedEvidenceIds.has(tombstone.evidenceId))
      .map(tombstone => tombstone.evidenceId);
    // Content was removed on invalidation. Keep hash/ID-only idempotency guards,
    // otherwise an old commit key could recreate withdrawn content.
    for (const evidenceId of due) this.purgedEvidenceIds.add(evidenceId);
    if (due.length > 0) this.emitMutation();
    return due.sort();
  }

  /** Physical local-content deletion at the 40-day boundary; caller propagates refs. */
  purgeExpired(now: string = this.now()): string[] {
    assertTimestamp(now, 'now');
    const due = [...this.finalEvidence.values()]
      .filter(record => this.isExpired(record.evidenceId, now));
    for (const record of due) {
      this.invalidateEvidence(record.evidenceId, {
        actionId: `expiry:${record.evidenceId}`,
        actorId: record.actorId,
        occurredAt: now,
        reasonCode: 'RETENTION_40_DAY_EXPIRY',
      });
    }
    return due.map(record => record.evidenceId).sort();
  }

  /**
   * Produces a strict durable snapshot. Expired content is omitted immediately,
   * while its no-content invalidation and idempotency guards remain.
   */
  exportSnapshot(): TurnEvidenceStoreSnapshot {
    const now = this.now();
    assertTimestamp(now, 'now');
    const cutoff = Date.parse(now);
    const activeEvidence: PersistedFinalTurnEvidence[] = [];
    const invalidations = new Map<string, TurnEvidenceTombstone>(
      [...this.invalidatedEvidence.entries()].map(([id, tombstone]) => (
        [id, structuredClone(tombstone)]
      )),
    );
    for (const evidence of this.finalEvidence.values()) {
      const expiry = this.expiresAt.get(evidence.evidenceId);
      if (expiry === undefined || !Number.isFinite(expiry)) {
        throw new Error(`active evidence ${evidence.evidenceId} is missing a valid expiry`);
      }
      if (cutoff >= expiry) {
        if (!invalidations.has(evidence.evidenceId)) {
          const invalidatedAt = new Date(expiry).toISOString();
          invalidations.set(evidence.evidenceId, {
            evidenceId: evidence.evidenceId,
            status: 'INVALIDATED',
            invalidatedAt,
            deleteBy: new Date(expiry + INVALIDATION_PURGE_DELAY_MS).toISOString(),
            reasonCode: 'RETENTION_40_DAY_EXPIRY',
          });
        }
        continue;
      }
      activeEvidence.push({
        evidence: cloneEvidence(evidence),
        expiresAt: new Date(expiry).toISOString(),
      });
    }
    const activeIds = new Set(activeEvidence.map(entry => entry.evidence.evidenceId));
    return structuredClone({
      schemaVersion: 'turn-evidence-store-snapshot-v0.1',
      activeEvidence,
      invalidations: [...invalidations.values()],
      operations: [...this.operations.entries()].map(([operationKey, operation]) => ({
        operationKey,
        fingerprint: operation.fingerprint,
        evidenceId: operation.evidenceId,
        status: activeIds.has(operation.evidenceId) ? 'ACTIVE' as const : 'INVALIDATED' as const,
      })),
      asrSourceBindings: [...this.asrSourceFingerprints.entries()].map(([evidenceId, fingerprint]) => ({
        evidenceId,
        fingerprint,
      })),
      issuedEvidenceIds: [...this.issuedEvidenceIds].sort(),
      purgedEvidenceIds: [...this.purgedEvidenceIds].sort(),
    });
  }

  private restoreSnapshot(snapshot: TurnEvidenceStoreSnapshot): void {
    assertSnapshot(snapshot);
    const safe = structuredClone(snapshot);
    const activeIds = new Set<string>();
    const invalidatedIds = new Set<string>();
    const operationKeys = new Set<string>();
    const asrSourceIds = new Set<string>();
    const issuedIds = new Set(safe.issuedEvidenceIds);

    for (const entry of safe.activeEvidence) {
      const id = entry.evidence.evidenceId;
      if (activeIds.has(id)) throw new TypeError(`snapshot contains duplicate active evidence ${id}`);
      activeIds.add(id);
      if (!issuedIds.has(id)) {
        throw new TypeError(`snapshot active evidence ${id} is absent from issuedEvidenceIds`);
      }
    }
    for (const tombstone of safe.invalidations) {
      const id = tombstone.evidenceId;
      if (invalidatedIds.has(id)) throw new TypeError(`snapshot contains duplicate invalidation ${id}`);
      if (activeIds.has(id)) throw new TypeError(`snapshot evidence ${id} is both active and invalidated`);
      if (!issuedIds.has(id)) {
        throw new TypeError(`snapshot invalidation ${id} is absent from issuedEvidenceIds`);
      }
      invalidatedIds.add(id);
    }
    for (const operation of safe.operations) {
      if (operationKeys.has(operation.operationKey)) {
        throw new TypeError(`snapshot contains duplicate operation ${operation.operationKey}`);
      }
      operationKeys.add(operation.operationKey);
      if (!issuedIds.has(operation.evidenceId)) {
        throw new TypeError(`snapshot operation references unissued evidence ${operation.evidenceId}`);
      }
      if (operation.status === 'ACTIVE' && !activeIds.has(operation.evidenceId)) {
        throw new TypeError('snapshot ACTIVE operation must reference active evidence');
      }
      if (operation.status === 'INVALIDATED' && activeIds.has(operation.evidenceId)) {
        throw new TypeError('snapshot INVALIDATED operation must not reference active evidence');
      }
      if (operation.status === 'INVALIDATED' && !invalidatedIds.has(operation.evidenceId)) {
        throw new TypeError('snapshot INVALIDATED operation must reference an invalidation tombstone');
      }
    }
    for (const binding of safe.asrSourceBindings) {
      if (asrSourceIds.has(binding.evidenceId)) {
        throw new TypeError(`snapshot contains duplicate ASR source binding ${binding.evidenceId}`);
      }
      asrSourceIds.add(binding.evidenceId);
    }
    for (const entry of safe.activeEvidence) {
      if (
        entry.evidence.source === 'ASR_FINAL'
        && entry.evidence.sourceRefs.some(ref => !asrSourceIds.has(ref))
      ) throw new TypeError('snapshot ASR_FINAL evidence has an unbound source ref');
    }
    for (const id of safe.purgedEvidenceIds) {
      if (!invalidatedIds.has(id)) {
        throw new TypeError(`snapshot purged evidence ${id} has no invalidation tombstone`);
      }
    }

    const now = this.now();
    assertTimestamp(now, 'now');
    const cutoff = Date.parse(now);
    for (const id of safe.issuedEvidenceIds) this.issuedEvidenceIds.add(id);
    for (const tombstone of safe.invalidations) {
      this.invalidatedEvidence.set(tombstone.evidenceId, structuredClone(tombstone));
    }
    for (const entry of safe.activeEvidence) {
      const expiry = Date.parse(entry.expiresAt);
      const evidence = entry.evidence;
      if (cutoff >= expiry) {
        const invalidatedAt = new Date(expiry).toISOString();
        this.invalidatedEvidence.set(evidence.evidenceId, {
          evidenceId: evidence.evidenceId,
          status: 'INVALIDATED',
          invalidatedAt,
          deleteBy: new Date(expiry + INVALIDATION_PURGE_DELAY_MS).toISOString(),
          reasonCode: 'RETENTION_40_DAY_EXPIRY',
        });
        continue;
      }
      this.finalEvidence.set(evidence.evidenceId, cloneEvidence(evidence));
      this.expiresAt.set(evidence.evidenceId, expiry);
      this.rememberSessionOrder(evidence.sessionId, evidence.evidenceId);
    }
    for (const operation of safe.operations) {
      this.operations.set(operation.operationKey, {
        fingerprint: operation.fingerprint,
        evidenceId: operation.evidenceId,
      });
    }
    for (const binding of safe.asrSourceBindings) {
      this.asrSourceFingerprints.set(binding.evidenceId, binding.fingerprint);
    }
    for (const id of safe.purgedEvidenceIds) this.purgedEvidenceIds.add(id);
  }

  private emitMutation(): void {
    if (this.onMutation) this.onMutation(this.exportSnapshot());
  }

  private rememberExpiry(evidenceId: string): void {
    const now = this.now();
    assertTimestamp(now, 'now');
    this.expiresAt.set(evidenceId, Date.parse(now) + RETENTION_DURATION_MS);
  }

  private isExpired(evidenceId: string, now: string): boolean {
    assertTimestamp(now, 'now');
    const expiresAt = this.expiresAt.get(evidenceId);
    return expiresAt !== undefined && Date.parse(now) >= expiresAt;
  }

  private rememberSessionOrder(sessionId: string, evidenceId: string): void {
    const order = this.evidenceOrderBySession.get(sessionId) ?? [];
    if (!order.includes(evidenceId)) order.push(evidenceId);
    this.evidenceOrderBySession.set(sessionId, order);
  }

  private nextEvidenceId(): string {
    const id = this.idFactory.next('evidence');
    assertNonEmptyString(id, 'idFactory.next(evidence)');
    if (this.issuedEvidenceIds.has(id) || this.finalEvidence.has(id)) {
      throw new Error(`idFactory produced duplicate evidence id ${id}`);
    }
    this.issuedEvidenceIds.add(id);
    return id;
  }
}
