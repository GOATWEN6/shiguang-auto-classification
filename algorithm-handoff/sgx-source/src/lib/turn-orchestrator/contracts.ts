import type { RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import type {
  InterviewMode,
  InterviewSessionStatus,
  NetworkStatus,
  ProviderStatus,
  TtsStatus,
  VadStatus,
} from '../interview-policy/contracts.ts';

export type GovernedIdKind =
  | 'session'
  | 'epoch'
  | 'turn'
  | 'invocation'
  | 'response'
  | 'evidence';

export interface GovernedIdFactory {
  next(kind: GovernedIdKind): string;
}

/** Exact external start command. Authentication and access scope are separate trusted input. */
export interface ClientSessionStartRequest {
  schemaVersion: 'client-session-start-v0.1';
  idempotencyToken: string;
  requestedMode: InterviewMode;
}

/** Produced by the authenticated server adapter. It must never be deserialized from the HTTP body. */
export interface TrustedSessionAuthority {
  schemaVersion: 'trusted-session-authority-v0.1';
  actorId: string;
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  visibilityScope: readonly string[];
}

/** Exact external turn command. Runtime identity and evidence are always allocated by the store. */
export interface ClientTurnOpenRequest {
  schemaVersion: 'client-turn-open-v0.1';
  sessionId: string;
  idempotencyToken: string;
}

export interface TrustedInterviewSessionState {
  currentTopic: string | null;
  selectedTopic: string | null;
  pendingModeOffer: 'FORMAL_INTERVIEW' | null;
  followUpDepth: number;
  blockedTopics: readonly string[];
}

export interface TrustedInterviewRuntimeState {
  vad: VadStatus;
  tts: TtsStatus;
  network: NetworkStatus;
  provider: ProviderStatus;
  ref: string | null;
  silenceSeconds?: number;
  waitPreferenceSeconds?: number;
}

export interface TrustedSessionStatePatch {
  status?: InterviewSessionStatus;
  /** Trusted mode transition; must name evidence bound to the active turn. */
  mode?: InterviewMode;
  modeChangeEvidenceRef?: string;
  authorizationVersion?: string;
  visibilityScope?: readonly string[];
  interviewState?: TrustedInterviewSessionState;
  runtimeState?: TrustedInterviewRuntimeState;
}

/** Internal policy/state transition command. This is not an HTTP request contract. */
export interface TrustedSessionCasRequest {
  schemaVersion: 'trusted-session-cas-v0.1';
  sessionId: string;
  expectedStateVersion: number;
  operationId: string;
  patch: TrustedSessionStatePatch;
}

/**
 * Internal command created only after the server validates an explicit user UI
 * action. HTTP clients may submit the UI action, but they never submit this
 * trusted command or choose its authority/session fields.
 */
export interface TrustedModeTransitionRequest {
  schemaVersion: 'trusted-mode-transition-v0.1';
  sessionId: string;
  expectedStateVersion: number;
  operationId: string;
  targetMode: InterviewMode;
  source: 'EXPLICIT_UI_ACTION';
  eventRef: string;
}

export interface GovernedSessionSnapshot {
  schemaVersion: 'governed-session-v0.1';
  sessionId: string;
  sessionEpoch: string;
  stateVersion: number;
  status: InterviewSessionStatus;
  mode: InterviewMode;
  actorId: string;
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  visibilityScope: readonly string[];
  turnCount: number;
  generationId: number;
  interviewState: TrustedInterviewSessionState;
  runtimeState: TrustedInterviewRuntimeState;
}

declare const governedTurnHandleBrand: unique symbol;

/** Opaque capability. Runtime acceptance also requires object identity in the issuing store. */
export interface GovernedTurnHandle {
  readonly [governedTurnHandleBrand]: true;
  readonly sessionId: string;
  readonly mode: InterviewMode;
  readonly stateVersion: number;
  readonly identity: RuntimeIdentity;
}

export interface SessionStartResult {
  replayed: boolean;
  session: GovernedSessionSnapshot;
}

export interface TurnOpenResult {
  replayed: boolean;
  handle: GovernedTurnHandle;
}

/** Trusted snapshot frozen when final turn evidence is bound to a response identity. */
export interface BoundTurnContext {
  sessionId: string;
  mode: InterviewMode;
  status: InterviewSessionStatus;
  stateVersion: number;
  identity: RuntimeIdentity;
  authority: TrustedSessionAuthority;
  interviewState: TrustedInterviewSessionState;
  runtimeState: TrustedInterviewRuntimeState;
}

export interface TrustedOpenTurnContext extends Omit<BoundTurnContext, 'identity'> {
  identity: RuntimeIdentity;
  handle: GovernedTurnHandle;
}

export interface AsrPartialObservationRequest {
  schemaVersion: 'asr-partial-observation-v0.1';
  partialId: string;
  text: string;
  receivedAt: string;
}

export interface TypedTextFinalRequest {
  schemaVersion: 'typed-text-final-v0.1';
  idempotencyToken: string;
  text: string;
  receivedAt: string;
}

export interface AsrTurnFinalRequest {
  schemaVersion: 'asr-turn-final-v0.1';
  idempotencyToken: string;
  receivedAt: string;
  segments: readonly import('../asr-runtime/contracts.ts').TranscriptEvidence[];
}

export type FinalTurnEvidenceSource = 'TYPED_TEXT' | 'ASR_FINAL';

export interface FinalTurnEvidence {
  schemaVersion: 'turn-evidence-v0.1';
  evidenceId: string;
  source: FinalTurnEvidenceSource;
  sourceRefs: readonly string[];
  sessionId: string;
  identity: RuntimeIdentity;
  text: string;
  receivedAt: string;
  purpose: 'daily_chat' | 'formal_interview';
  actorId: string;
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  visibilityScope: readonly string[];
}

export interface FinalEvidenceCommit {
  evidence: FinalTurnEvidence;
  boundTurn: BoundTurnContext;
}

export interface AsrPartialObservationResult {
  status: 'WAIT';
}

export interface GovernedSessionStoreReader {
  getSession(sessionId: string): GovernedSessionSnapshot | null;
  resolveTurnHandle(handle: GovernedTurnHandle): TrustedOpenTurnContext;
  bindEvidence(handle: GovernedTurnHandle, evidenceRefs: readonly string[]): BoundTurnContext;
  resolveBoundTurn(identity: RuntimeIdentity): BoundTurnContext | null;
}

export interface FinalEvidenceReader {
  get(evidenceId: string): FinalTurnEvidence | null;
  getPreviousCompletedInSession(currentEvidenceId: string): FinalTurnEvidence | null;
}

export interface TurnEvidenceInvalidationAudit {
  actionId: string;
  actorId: string;
  occurredAt: string;
  reasonCode: string;
}

export interface TurnEvidenceTombstone {
  evidenceId: string;
  status: 'INVALIDATED';
  invalidatedAt: string;
  deleteBy: string;
  reasonCode: string;
}

export type PlainRecord = Record<string, unknown>;

export function assertPlainRecord(value: unknown, field: string): asserts value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

export function assertExactKeys(value: PlainRecord, allowed: readonly string[], field: string): void {
  const keys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.has(key)) throw new TypeError(`${field}.${String(key)} is not allowed`);
  }
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

export function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must not contain duplicates`);
}

export function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

export function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
}

export function assertTimestamp(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be a valid timestamp`);
}

export function assertExactRuntimeIdentity(
  value: unknown,
  field = 'identity',
): asserts value is RuntimeIdentity {
  assertPlainRecord(value, field);
  assertExactKeys(
    value,
    ['sessionEpoch', 'turnId', 'generationId', 'invocationId', 'responseId', 'evidenceRefs'],
    field,
  );
  assertNonEmptyString(value.sessionEpoch, `${field}.sessionEpoch`);
  assertNonEmptyString(value.turnId, `${field}.turnId`);
  assertNonNegativeInteger(value.generationId, `${field}.generationId`);
  assertNonEmptyString(value.invocationId, `${field}.invocationId`);
  if (value.responseId !== undefined) assertNonEmptyString(value.responseId, `${field}.responseId`);
  assertStringArray(value.evidenceRefs, `${field}.evidenceRefs`);
}

export function cloneIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return Object.freeze({
    sessionEpoch: identity.sessionEpoch,
    turnId: identity.turnId,
    generationId: identity.generationId,
    invocationId: identity.invocationId,
    ...(identity.responseId === undefined ? {} : { responseId: identity.responseId }),
    evidenceRefs: Object.freeze([...identity.evidenceRefs]),
  });
}

export function sameExactIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionEpoch === right.sessionEpoch
    && left.turnId === right.turnId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId
    && left.responseId === right.responseId
    && left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((item, index) => item === right.evidenceRefs[index]);
}

export function stableFingerprint(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(Object.keys(candidate as PlainRecord).sort().map(key => (
        [key, visit((candidate as PlainRecord)[key])]
      )));
    }
    return candidate;
  };
  return JSON.stringify(visit(value));
}
