import { randomUUID } from 'node:crypto';

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
}

interface IdempotentEvidenceCommit {
  fingerprint: string;
  evidenceId: string;
  /** Null retains only a no-content replay guard after withdrawal/deletion. */
  result: FinalEvidenceCommit | null;
}

const RETENTION_DURATION_MS = 40 * 24 * 60 * 60 * 1_000;

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
    if (!this.idFactory || typeof this.idFactory.next !== 'function') {
      throw new TypeError('idFactory.next must be a function');
    }
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
    const fingerprint = stableFingerprint({ identity: handle?.identity, request });
    const operationKey = `${identityCoreKey(handle.identity)}\u0000${request.idempotencyToken}`;
    const replay = this.operations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      if (!replay.result || !this.get(replay.evidenceId)) {
        throw new Error('final evidence has been invalidated');
      }
      return cloneCommit(replay.result);
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
    this.operations.set(operationKey, { fingerprint, evidenceId, result: cloneCommit(result) });
    return cloneCommit(result);
  }

  commitAsrFinal(
    handle: GovernedTurnHandle,
    request: AsrTurnFinalRequest,
  ): FinalEvidenceCommit {
    assertAsrFinal(request);
    const context = this.sessions.resolveTurnHandle(handle);
    const fingerprint = stableFingerprint({ identity: handle?.identity, request });
    const operationKey = `${identityCoreKey(handle.identity)}\u0000${request.idempotencyToken}`;
    const replay = this.operations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      if (!replay.result || !this.get(replay.evidenceId)) {
        throw new Error('final evidence has been invalidated');
      }
      return cloneCommit(replay.result);
    }
    for (const [index, segment] of request.segments.entries()) {
      if (!sameExactIdentity(segment.identity, context.identity)) {
        throw new Error(`request.segments[${index}].identity does not match the governed turn`);
      }
      const segmentFingerprint = stableFingerprint(segment);
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
      this.asrSourceFingerprints.set(segment.evidenceId, stableFingerprint(segment));
    }
    const result = { evidence: record, boundTurn };
    this.finalEvidence.set(evidenceId, cloneEvidence(record));
    this.rememberExpiry(evidenceId);
    this.rememberSessionOrder(record.sessionId, evidenceId);
    this.operations.set(operationKey, { fingerprint, evidenceId, result: cloneCommit(result) });
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
    const deleteBy = new Date(Date.parse(audit.occurredAt) + 24 * 60 * 60 * 1_000).toISOString();
    const tombstone: TurnEvidenceTombstone = {
      evidenceId,
      status: 'INVALIDATED',
      invalidatedAt: audit.occurredAt,
      deleteBy,
      reasonCode: audit.reasonCode,
    };
    this.finalEvidence.delete(evidenceId);
    this.expiresAt.delete(evidenceId);
    for (const operation of this.operations.values()) {
      if (operation.evidenceId === evidenceId) operation.result = null;
    }
    this.invalidatedEvidence.set(evidenceId, tombstone);
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
