import { randomUUID } from 'node:crypto';

import type { RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import type { InterviewSessionStatus } from '../interview-policy/contracts.ts';
import {
  assertExactKeys,
  assertExactRuntimeIdentity,
  assertFiniteNonNegative,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertPlainRecord,
  assertStringArray,
  cloneIdentity,
  sameExactIdentity,
  stableFingerprint,
  type BoundTurnContext,
  type ClientSessionStartRequest,
  type ClientTurnOpenRequest,
  type GovernedIdFactory,
  type GovernedIdKind,
  type GovernedSessionSnapshot,
  type GovernedSessionStoreReader,
  type GovernedTurnHandle,
  type SessionStartResult,
  type TrustedInterviewRuntimeState,
  type TrustedInterviewSessionState,
  type TrustedOpenTurnContext,
  type TrustedSessionAuthority,
  type TrustedSessionCasRequest,
  type TrustedModeTransitionRequest,
  type TrustedSessionStatePatch,
  type TurnOpenResult,
} from './contracts.ts';

const SESSION_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED', 'RECOVERING'] as const;
const MODES = ['DAILY_CHAT', 'FORMAL_INTERVIEW'] as const;
const VAD_STATES = ['SILENT', 'SPEAKING', 'UNKNOWN'] as const;
const TTS_STATES = ['IDLE', 'PLAYING'] as const;
const NETWORK_STATES = ['ONLINE', 'OFFLINE'] as const;
const PROVIDER_STATES = ['READY', 'TIMEOUT'] as const;

interface SessionRecord extends GovernedSessionSnapshot {
  activeTurnId: string | null;
  activeIdentityKey: string | null;
}

interface HandleRecord {
  handle: GovernedTurnHandle;
  sessionId: string;
  stateVersion: number;
  identity: RuntimeIdentity;
}

interface IdempotentSessionStart {
  fingerprint: string;
  sessionId: string;
}

interface IdempotentTurnOpen {
  fingerprint: string;
  handle: GovernedTurnHandle;
}

interface IdempotentCas {
  fingerprint: string;
  result: GovernedSessionSnapshot;
}

interface IdempotentModeTransition {
  fingerprint: string;
  result: GovernedSessionSnapshot;
}

export interface InMemoryGovernedSessionStoreOptions {
  idFactory?: GovernedIdFactory;
  interviewStateFactory?: (
    authority: TrustedSessionAuthority,
  ) => TrustedInterviewSessionState;
  runtimeStateFactory?: (
    authority: TrustedSessionAuthority,
  ) => TrustedInterviewRuntimeState;
}

function defaultIdFactory(): GovernedIdFactory {
  return { next: kind => `${kind}:${randomUUID()}` };
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  }
}

function assertStringOrNull(value: unknown, field: string): asserts value is string | null {
  if (value !== null) assertNonEmptyString(value, field);
}

function assertClientSessionStartRequest(value: unknown): asserts value is ClientSessionStartRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'idempotencyToken', 'requestedMode'], 'request');
  if (value.schemaVersion !== 'client-session-start-v0.1') {
    throw new TypeError('request.schemaVersion must be client-session-start-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertEnum(value.requestedMode, MODES, 'request.requestedMode');
}

function assertClientTurnOpenRequest(value: unknown): asserts value is ClientTurnOpenRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'sessionId', 'idempotencyToken'], 'request');
  if (value.schemaVersion !== 'client-turn-open-v0.1') {
    throw new TypeError('request.schemaVersion must be client-turn-open-v0.1');
  }
  assertNonEmptyString(value.sessionId, 'request.sessionId');
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
}

function assertAuthority(value: unknown): asserts value is TrustedSessionAuthority {
  assertPlainRecord(value, 'authority');
  assertExactKeys(value, [
    'schemaVersion',
    'actorId',
    'subjectId',
    'familySpaceId',
    'authorizationVersion',
    'visibilityScope',
  ], 'authority');
  if (value.schemaVersion !== 'trusted-session-authority-v0.1') {
    throw new TypeError('authority.schemaVersion must be trusted-session-authority-v0.1');
  }
  assertNonEmptyString(value.actorId, 'authority.actorId');
  assertNonEmptyString(value.subjectId, 'authority.subjectId');
  assertNonEmptyString(value.familySpaceId, 'authority.familySpaceId');
  assertNonEmptyString(value.authorizationVersion, 'authority.authorizationVersion');
  assertStringArray(value.visibilityScope, 'authority.visibilityScope');
  if (value.visibilityScope.length === 0) {
    throw new TypeError('authority.visibilityScope must not be empty');
  }
}

function assertInterviewState(value: unknown, field: string): asserts value is TrustedInterviewSessionState {
  assertPlainRecord(value, field);
  assertExactKeys(value, [
    'currentTopic',
    'selectedTopic',
    'pendingModeOffer',
    'followUpDepth',
    'blockedTopics',
  ], field);
  assertStringOrNull(value.currentTopic, `${field}.currentTopic`);
  assertStringOrNull(value.selectedTopic, `${field}.selectedTopic`);
  if (value.pendingModeOffer !== null && value.pendingModeOffer !== 'FORMAL_INTERVIEW') {
    throw new TypeError(`${field}.pendingModeOffer must be FORMAL_INTERVIEW or null`);
  }
  assertNonNegativeInteger(value.followUpDepth, `${field}.followUpDepth`);
  assertStringArray(value.blockedTopics, `${field}.blockedTopics`);
}

function assertRuntimeState(value: unknown, field: string): asserts value is TrustedInterviewRuntimeState {
  assertPlainRecord(value, field);
  assertExactKeys(value, [
    'vad',
    'tts',
    'network',
    'provider',
    'ref',
    'silenceSeconds',
    'waitPreferenceSeconds',
  ], field);
  assertEnum(value.vad, VAD_STATES, `${field}.vad`);
  assertEnum(value.tts, TTS_STATES, `${field}.tts`);
  assertEnum(value.network, NETWORK_STATES, `${field}.network`);
  assertEnum(value.provider, PROVIDER_STATES, `${field}.provider`);
  assertStringOrNull(value.ref, `${field}.ref`);
  if (value.silenceSeconds !== undefined) {
    assertFiniteNonNegative(value.silenceSeconds, `${field}.silenceSeconds`);
  }
  if (value.waitPreferenceSeconds !== undefined) {
    assertFiniteNonNegative(value.waitPreferenceSeconds, `${field}.waitPreferenceSeconds`);
  }
}

function assertPatch(value: unknown): asserts value is TrustedSessionStatePatch {
  assertPlainRecord(value, 'request.patch');
  assertExactKeys(value, [
    'status',
    'mode',
    'modeChangeEvidenceRef',
    'authorizationVersion',
    'visibilityScope',
    'interviewState',
    'runtimeState',
  ], 'request.patch');
  if (Reflect.ownKeys(value).length === 0) throw new TypeError('request.patch must not be empty');
  if (value.status !== undefined) assertEnum(value.status, SESSION_STATUSES, 'request.patch.status');
  const hasMode = Object.prototype.hasOwnProperty.call(value, 'mode');
  const hasModeEvidence = Object.prototype.hasOwnProperty.call(value, 'modeChangeEvidenceRef');
  if (hasMode !== hasModeEvidence) {
    throw new TypeError('request.patch.mode and modeChangeEvidenceRef must be provided together');
  }
  if (hasMode) assertEnum(value.mode, MODES, 'request.patch.mode');
  if (hasModeEvidence) {
    assertNonEmptyString(value.modeChangeEvidenceRef, 'request.patch.modeChangeEvidenceRef');
  }
  if (value.authorizationVersion !== undefined) {
    assertNonEmptyString(value.authorizationVersion, 'request.patch.authorizationVersion');
  }
  if (value.visibilityScope !== undefined) {
    assertStringArray(value.visibilityScope, 'request.patch.visibilityScope');
    if (value.visibilityScope.length === 0) {
      throw new TypeError('request.patch.visibilityScope must not be empty');
    }
  }
  if (value.interviewState !== undefined) {
    assertInterviewState(value.interviewState, 'request.patch.interviewState');
  }
  if (value.runtimeState !== undefined) {
    assertRuntimeState(value.runtimeState, 'request.patch.runtimeState');
  }
}

function assertCasRequest(value: unknown): asserts value is TrustedSessionCasRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, [
    'schemaVersion',
    'sessionId',
    'expectedStateVersion',
    'operationId',
    'patch',
  ], 'request');
  if (value.schemaVersion !== 'trusted-session-cas-v0.1') {
    throw new TypeError('request.schemaVersion must be trusted-session-cas-v0.1');
  }
  assertNonEmptyString(value.sessionId, 'request.sessionId');
  assertNonNegativeInteger(value.expectedStateVersion, 'request.expectedStateVersion');
  assertNonEmptyString(value.operationId, 'request.operationId');
  assertPatch(value.patch);
}

function assertModeTransitionRequest(value: unknown): asserts value is TrustedModeTransitionRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, [
    'schemaVersion',
    'sessionId',
    'expectedStateVersion',
    'operationId',
    'targetMode',
    'source',
    'eventRef',
  ], 'request');
  if (value.schemaVersion !== 'trusted-mode-transition-v0.1') {
    throw new TypeError('request.schemaVersion must be trusted-mode-transition-v0.1');
  }
  assertNonEmptyString(value.sessionId, 'request.sessionId');
  assertNonNegativeInteger(value.expectedStateVersion, 'request.expectedStateVersion');
  assertNonEmptyString(value.operationId, 'request.operationId');
  assertEnum(value.targetMode, MODES, 'request.targetMode');
  if (value.source !== 'EXPLICIT_UI_ACTION') {
    throw new TypeError('request.source must be EXPLICIT_UI_ACTION');
  }
  assertNonEmptyString(value.eventRef, 'request.eventRef');
}

function cloneAuthority(authority: TrustedSessionAuthority): TrustedSessionAuthority {
  return {
    schemaVersion: 'trusted-session-authority-v0.1',
    actorId: authority.actorId,
    subjectId: authority.subjectId,
    familySpaceId: authority.familySpaceId,
    authorizationVersion: authority.authorizationVersion,
    visibilityScope: [...authority.visibilityScope],
  };
}

function cloneInterviewState(state: TrustedInterviewSessionState): TrustedInterviewSessionState {
  return {
    currentTopic: state.currentTopic,
    selectedTopic: state.selectedTopic,
    pendingModeOffer: state.pendingModeOffer,
    followUpDepth: state.followUpDepth,
    blockedTopics: [...state.blockedTopics],
  };
}

function cloneRuntimeState(state: TrustedInterviewRuntimeState): TrustedInterviewRuntimeState {
  return {
    vad: state.vad,
    tts: state.tts,
    network: state.network,
    provider: state.provider,
    ref: state.ref,
    ...(state.silenceSeconds === undefined ? {} : { silenceSeconds: state.silenceSeconds }),
    ...(state.waitPreferenceSeconds === undefined
      ? {}
      : { waitPreferenceSeconds: state.waitPreferenceSeconds }),
  };
}

function defaultInterviewState(): TrustedInterviewSessionState {
  return {
    currentTopic: null,
    selectedTopic: null,
    pendingModeOffer: null,
    followUpDepth: 0,
    blockedTopics: [],
  };
}

function defaultRuntimeState(): TrustedInterviewRuntimeState {
  return {
    vad: 'SILENT',
    tts: 'IDLE',
    network: 'ONLINE',
    provider: 'READY',
    ref: null,
  };
}

function snapshot(record: SessionRecord): GovernedSessionSnapshot {
  return structuredClone({
    schemaVersion: 'governed-session-v0.1' as const,
    sessionId: record.sessionId,
    sessionEpoch: record.sessionEpoch,
    stateVersion: record.stateVersion,
    status: record.status,
    mode: record.mode,
    actorId: record.actorId,
    subjectId: record.subjectId,
    familySpaceId: record.familySpaceId,
    authorizationVersion: record.authorizationVersion,
    visibilityScope: [...record.visibilityScope],
    turnCount: record.turnCount,
    generationId: record.generationId,
    interviewState: cloneInterviewState(record.interviewState),
    runtimeState: cloneRuntimeState(record.runtimeState),
  });
}

function identityCoreKey(identity: RuntimeIdentity): string {
  return JSON.stringify([
    identity.sessionEpoch,
    identity.turnId,
    identity.generationId,
    identity.invocationId,
  ]);
}

function cloneBound(value: BoundTurnContext): BoundTurnContext {
  return structuredClone({
    sessionId: value.sessionId,
    mode: value.mode,
    status: value.status,
    stateVersion: value.stateVersion,
    identity: cloneIdentity(value.identity),
    authority: cloneAuthority(value.authority),
    interviewState: cloneInterviewState(value.interviewState),
    runtimeState: cloneRuntimeState(value.runtimeState),
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertStatusTransition(
  current: InterviewSessionStatus,
  next: InterviewSessionStatus,
): void {
  if (current === next) return;
  if (current === 'ENDED') throw new Error('ENDED session cannot transition to another status');
  const allowed: Record<Exclude<InterviewSessionStatus, 'ENDED'>, readonly InterviewSessionStatus[]> = {
    ACTIVE: ['PAUSED', 'RECOVERING', 'ENDED'],
    PAUSED: ['ACTIVE', 'RECOVERING', 'ENDED'],
    RECOVERING: ['ACTIVE', 'PAUSED', 'ENDED'],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`illegal session status transition ${current} -> ${next}`);
  }
}

export class InMemoryGovernedSessionStore implements GovernedSessionStoreReader {
  private readonly idFactory: GovernedIdFactory;
  private readonly interviewStateFactory?: InMemoryGovernedSessionStoreOptions['interviewStateFactory'];
  private readonly runtimeStateFactory?: InMemoryGovernedSessionStoreOptions['runtimeStateFactory'];
  private readonly issuedIds = new Set<string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly startOperations = new Map<string, IdempotentSessionStart>();
  private readonly turnOperations = new Map<string, IdempotentTurnOpen>();
  private readonly casOperations = new Map<string, IdempotentCas>();
  private readonly modeTransitionOperations = new Map<string, IdempotentModeTransition>();
  private readonly handles = new WeakMap<object, HandleRecord>();
  private readonly closedHandles = new WeakMap<object, GovernedSessionSnapshot>();
  private readonly boundByHandle = new WeakMap<object, BoundTurnContext>();
  private readonly boundByIdentity = new Map<string, BoundTurnContext>();

  constructor(options: InMemoryGovernedSessionStoreOptions = {}) {
    this.idFactory = options.idFactory ?? defaultIdFactory();
    if (!this.idFactory || typeof this.idFactory.next !== 'function') {
      throw new TypeError('idFactory.next must be a function');
    }
    this.interviewStateFactory = options.interviewStateFactory;
    this.runtimeStateFactory = options.runtimeStateFactory;
  }

  startSession(
    request: ClientSessionStartRequest,
    authority: TrustedSessionAuthority,
  ): SessionStartResult {
    assertClientSessionStartRequest(request);
    assertAuthority(authority);
    const safeRequest = structuredClone(request);
    const safeAuthority = cloneAuthority(authority);
    const fingerprint = stableFingerprint({ request: safeRequest, authority: safeAuthority });
    const operationKey = [
      safeAuthority.actorId,
      safeAuthority.subjectId,
      safeAuthority.familySpaceId,
      safeRequest.idempotencyToken,
    ].join('\u0000');
    const prior = this.startOperations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      return { replayed: true, session: snapshot(this.requireSession(prior.sessionId)) };
    }

    const interviewState = this.interviewStateFactory
      ? this.interviewStateFactory(cloneAuthority(safeAuthority))
      : defaultInterviewState();
    const runtimeState = this.runtimeStateFactory
      ? this.runtimeStateFactory(cloneAuthority(safeAuthority))
      : defaultRuntimeState();
    assertInterviewState(interviewState, 'interviewStateFactory result');
    assertRuntimeState(runtimeState, 'runtimeStateFactory result');
    const sessionId = this.nextId('session');
    const record: SessionRecord = {
      schemaVersion: 'governed-session-v0.1',
      sessionId,
      sessionEpoch: this.nextId('epoch'),
      stateVersion: 0,
      status: 'ACTIVE',
      mode: safeRequest.requestedMode,
      actorId: safeAuthority.actorId,
      subjectId: safeAuthority.subjectId,
      familySpaceId: safeAuthority.familySpaceId,
      authorizationVersion: safeAuthority.authorizationVersion,
      visibilityScope: [...safeAuthority.visibilityScope],
      turnCount: 0,
      generationId: 0,
      interviewState: cloneInterviewState(interviewState),
      runtimeState: cloneRuntimeState(runtimeState),
      activeTurnId: null,
      activeIdentityKey: null,
    };
    this.sessions.set(sessionId, record);
    this.startOperations.set(operationKey, { fingerprint, sessionId });
    return { replayed: false, session: snapshot(record) };
  }

  openTurn(request: ClientTurnOpenRequest): TurnOpenResult {
    assertClientTurnOpenRequest(request);
    const safeRequest = structuredClone(request);
    const fingerprint = stableFingerprint(safeRequest);
    const operationKey = `${safeRequest.sessionId}\u0000${safeRequest.idempotencyToken}`;
    const prior = this.turnOperations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different payload');
      }
      return { replayed: true, handle: prior.handle };
    }

    const record = this.requireSession(safeRequest.sessionId);
    // A paused session may accept the next governed turn so InterviewPolicy
    // can decide whether the user explicitly resumed it. RECOVERING and
    // ENDED remain blocked at this boundary.
    if (record.status !== 'ACTIVE' && record.status !== 'PAUSED') {
      throw new Error(`cannot open a turn while session is ${record.status}`);
    }
    record.turnCount += 1;
    record.generationId += 1;
    record.stateVersion += 1;
    const identity = cloneIdentity({
      sessionEpoch: record.sessionEpoch,
      turnId: this.nextId('turn'),
      generationId: record.generationId,
      invocationId: this.nextId('invocation'),
      responseId: this.nextId('response'),
      evidenceRefs: [],
    });
    record.activeTurnId = identity.turnId;
    record.activeIdentityKey = identityCoreKey(identity);
    const handle = Object.freeze({
      sessionId: record.sessionId,
      mode: record.mode,
      stateVersion: record.stateVersion,
      identity,
    }) as GovernedTurnHandle;
    this.handles.set(handle, {
      handle,
      sessionId: record.sessionId,
      stateVersion: record.stateVersion,
      identity,
    });
    this.turnOperations.set(operationKey, { fingerprint, handle });
    return { replayed: false, handle };
  }

  compareAndSwap(request: TrustedSessionCasRequest): GovernedSessionSnapshot {
    assertCasRequest(request);
    const safeRequest = structuredClone(request);
    const fingerprint = stableFingerprint(safeRequest);
    const operationKey = `${safeRequest.sessionId}\u0000${safeRequest.operationId}`;
    const replay = this.casOperations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('operationId reused with a different payload');
      }
      return structuredClone(replay.result);
    }
    const record = this.requireSession(safeRequest.sessionId);
    if (record.stateVersion !== safeRequest.expectedStateVersion) {
      throw new Error(
        `state version mismatch: expected ${safeRequest.expectedStateVersion}, current ${record.stateVersion}`,
      );
    }
    this.applyPatch(record, safeRequest.patch);
    record.stateVersion += 1;
    const result = snapshot(record);
    this.casOperations.set(operationKey, { fingerprint, result: structuredClone(result) });
    return result;
  }

  /**
   * Applies a validated explicit UI mode switch before the next turn opens.
   * This is a server-internal boundary. Spoken mode changes continue to use a
   * bound final-turn evidence ref through compareAndSwap().
   */
  applyTrustedModeTransition(request: TrustedModeTransitionRequest): GovernedSessionSnapshot {
    assertModeTransitionRequest(request);
    const safeRequest = structuredClone(request);
    const fingerprint = stableFingerprint(safeRequest);
    const operationKey = `${safeRequest.sessionId}\u0000${safeRequest.operationId}`;
    const replay = this.modeTransitionOperations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error('operationId reused with a different mode transition');
      }
      return structuredClone(replay.result);
    }
    const record = this.requireSession(safeRequest.sessionId);
    if (record.stateVersion !== safeRequest.expectedStateVersion) {
      throw new Error(
        `state version mismatch: expected ${safeRequest.expectedStateVersion}, current ${record.stateVersion}`,
      );
    }
    if (record.status !== 'ACTIVE') throw new Error('mode transition requires an ACTIVE session');
    if (record.activeTurnId !== null) throw new Error('mode transition requires no active turn');
    if (safeRequest.targetMode === record.mode) throw new Error('mode transition must change the current mode');
    record.mode = safeRequest.targetMode;
    record.stateVersion += 1;
    const result = snapshot(record);
    this.modeTransitionOperations.set(operationKey, {
      fingerprint,
      result: structuredClone(result),
    });
    return result;
  }

  /** Marks the exact active turn terminal after all accepted child work settles. */
  closeTurn(handle: GovernedTurnHandle): GovernedSessionSnapshot {
    if (handle === null || typeof handle !== 'object') throw new TypeError('turn handle is invalid');
    const replay = this.closedHandles.get(handle as object);
    if (replay) return structuredClone(replay);
    const issued = this.handles.get(handle as object);
    if (!issued || issued.handle !== handle) throw new Error('turn handle was not issued by this store');
    const record = this.requireSession(issued.sessionId);
    if (
      record.activeTurnId !== issued.identity.turnId
      || record.sessionEpoch !== issued.identity.sessionEpoch
      || record.generationId !== issued.identity.generationId
    ) throw new Error('cannot close a stale turn');
    record.activeTurnId = null;
    record.activeIdentityKey = null;
    record.stateVersion += 1;
    const result = snapshot(record);
    this.closedHandles.set(handle as object, structuredClone(result));
    return result;
  }

  getSession(sessionId: string): GovernedSessionSnapshot | null {
    assertNonEmptyString(sessionId, 'sessionId');
    const record = this.sessions.get(sessionId);
    return record ? snapshot(record) : null;
  }

  resolveTurnHandle(handle: GovernedTurnHandle): TrustedOpenTurnContext {
    if (handle === null || typeof handle !== 'object') throw new TypeError('turn handle is invalid');
    const issued = this.handles.get(handle as object);
    if (!issued || issued.handle !== handle) throw new Error('turn handle was not issued by this store');
    const record = this.requireSession(issued.sessionId);
    if (
      record.stateVersion !== issued.stateVersion
      || record.activeTurnId !== issued.identity.turnId
      || record.sessionEpoch !== issued.identity.sessionEpoch
      || record.generationId !== issued.identity.generationId
    ) throw new Error('turn handle is stale');
    return {
      handle,
      sessionId: record.sessionId,
      mode: record.mode,
      status: record.status,
      stateVersion: record.stateVersion,
      identity: cloneIdentity(issued.identity),
      authority: this.authorityFor(record),
      interviewState: cloneInterviewState(record.interviewState),
      runtimeState: cloneRuntimeState(record.runtimeState),
    };
  }

  bindEvidence(handle: GovernedTurnHandle, evidenceRefs: readonly string[]): BoundTurnContext {
    assertStringArray(evidenceRefs, 'evidenceRefs');
    if (evidenceRefs.length === 0) throw new TypeError('evidenceRefs must not be empty');
    const prior = this.boundByHandle.get(handle as object);
    if (prior) {
      if (!sameStrings(prior.identity.evidenceRefs, evidenceRefs)) {
        throw new Error('turn is already bound to different evidence');
      }
      return cloneBound(prior);
    }
    const open = this.resolveTurnHandle(handle);
    const identity = cloneIdentity({ ...open.identity, evidenceRefs: [...evidenceRefs] });
    const bound: BoundTurnContext = {
      sessionId: open.sessionId,
      mode: open.mode,
      status: open.status,
      stateVersion: open.stateVersion,
      identity,
      authority: cloneAuthority(open.authority),
      interviewState: cloneInterviewState(open.interviewState),
      runtimeState: cloneRuntimeState(open.runtimeState),
    };
    this.boundByHandle.set(handle as object, bound);
    this.boundByIdentity.set(identityCoreKey(identity), bound);
    return cloneBound(bound);
  }

  resolveBoundTurn(identity: RuntimeIdentity): BoundTurnContext | null {
    assertExactRuntimeIdentity(identity);
    const bound = this.boundByIdentity.get(identityCoreKey(identity));
    if (!bound || !sameExactIdentity(bound.identity, identity)) return null;
    const record = this.sessions.get(bound.sessionId);
    if (!record) return null;
    if (
      record.stateVersion !== bound.stateVersion
      || record.activeTurnId !== bound.identity.turnId
      || record.sessionEpoch !== bound.identity.sessionEpoch
      || record.generationId !== bound.identity.generationId
    ) return null;
    return cloneBound(bound);
  }

  private nextId(kind: GovernedIdKind): string {
    const id = this.idFactory.next(kind);
    assertNonEmptyString(id, `idFactory.next(${kind})`);
    if (this.issuedIds.has(id)) throw new Error(`idFactory produced duplicate id ${id}`);
    this.issuedIds.add(id);
    return id;
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`unknown session ${sessionId}`);
    return record;
  }

  private authorityFor(record: SessionRecord): TrustedSessionAuthority {
    return {
      schemaVersion: 'trusted-session-authority-v0.1',
      actorId: record.actorId,
      subjectId: record.subjectId,
      familySpaceId: record.familySpaceId,
      authorizationVersion: record.authorizationVersion,
      visibilityScope: [...record.visibilityScope],
    };
  }

  private applyPatch(record: SessionRecord, patch: TrustedSessionStatePatch): void {
    if (patch.mode !== undefined) {
      if (record.status !== 'ACTIVE' || (patch.status !== undefined && patch.status !== 'ACTIVE')) {
        throw new Error('mode transition requires an ACTIVE session');
      }
      if (patch.mode === record.mode) throw new Error('mode transition must change the current mode');
      const bound = record.activeIdentityKey === null
        ? undefined
        : this.boundByIdentity.get(record.activeIdentityKey);
      if (
        !bound
        || bound.sessionId !== record.sessionId
        || bound.stateVersion !== record.stateVersion
        || !bound.identity.evidenceRefs.includes(patch.modeChangeEvidenceRef as string)
      ) throw new Error('mode transition requires evidence bound to the active turn');
      record.mode = patch.mode;
    }
    if (patch.status !== undefined) {
      assertStatusTransition(record.status, patch.status);
      record.status = patch.status;
    }
    if (patch.authorizationVersion !== undefined) {
      record.authorizationVersion = patch.authorizationVersion;
    }
    if (patch.visibilityScope !== undefined) record.visibilityScope = [...patch.visibilityScope];
    if (patch.interviewState !== undefined) {
      record.interviewState = cloneInterviewState(patch.interviewState);
    }
    if (patch.runtimeState !== undefined) record.runtimeState = cloneRuntimeState(patch.runtimeState);
  }
}
