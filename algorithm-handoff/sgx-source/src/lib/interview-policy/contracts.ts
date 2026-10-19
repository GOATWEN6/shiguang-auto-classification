/**
 * Public contracts for the SGX InterviewPolicy v0.2 runtime library.
 *
 * The policy produces a plan and runtime controls only. It has no authority to
 * persist CanonicalMemory, finalize stories, or bypass the voice runtime.
 */

export type InterviewMode = 'DAILY_CHAT' | 'FORMAL_INTERVIEW';
export type InterviewSessionStatus = 'ACTIVE' | 'PAUSED' | 'ENDED' | 'RECOVERING';
export type AsrStatus = 'NONE' | 'PARTIAL' | 'FINAL' | 'FAILED';
export type VadStatus = 'SILENT' | 'SPEAKING' | 'UNKNOWN';
export type TtsStatus = 'IDLE' | 'PLAYING';
export type NetworkStatus = 'ONLINE' | 'OFFLINE';
export type ProviderStatus = 'READY' | 'TIMEOUT';

export interface InterviewAsrInput {
  status: AsrStatus;
  text: string;
  ref: string | null;
}

export interface InterviewRuntimeInput {
  vad: VadStatus;
  tts: TtsStatus;
  network: NetworkStatus;
  provider: ProviderStatus;
  ref?: string | null;
  sessionEpoch?: string;
  generationId?: number;
  silenceSeconds?: number;
  waitPreferenceSeconds?: number;
}

export type InterviewUiEvent =
  | { type: 'END_BUTTON'; ref: string }
  | { type: 'MEMORY_TOPIC_CLICK'; ref: string };

export interface InterviewIncomingProviderResponse {
  type: 'PROVIDER_RESPONSE';
  ref: string;
  sessionEpoch?: string;
  generationId?: number;
  originDecisionId?: string;
}

export interface InterviewMemoryRef {
  ref: string;
  source: string;
  text: string;
  allowedForInterview: boolean;
}

/**
 * Compatibility input used by the frozen v0.2 reducer.
 *
 * `sessionEpoch` and `runtime.generationId` stay optional only so the frozen
 * regression suite can be replayed byte-for-byte. Live callers must use
 * `LiveInterviewDecisionRequest`, whose assertion requires both fields.
 */
export interface InterviewPolicyInput {
  mode: InterviewMode;
  sessionStatus: InterviewSessionStatus;
  currentTopic: string | null;
  selectedTopic?: string | null;
  pendingModeOffer?: 'FORMAL_INTERVIEW' | null;
  followUpDepth: number;
  /** Trusted resolver hint; never used as persistence authority. */
  previousCompletedUserEvidenceRef?: string | null;
  sessionEpoch?: string;
  asr: InterviewAsrInput;
  uiEvent: InterviewUiEvent | null;
  runtime: InterviewRuntimeInput;
  incomingEvent?: InterviewIncomingProviderResponse | null;
  blockedTopics: readonly string[];
  memoryRefs: readonly InterviewMemoryRef[];
}

export interface InterviewLiveIdentity {
  sessionEpoch: string;
  turnId: string;
  generationId: number;
  invocationId: string;
  responseId?: string;
  evidenceRefs: readonly string[];
}

export interface LiveInterviewDecisionRequest {
  input: InterviewPolicyInput & {
    sessionEpoch: string;
    runtime: InterviewRuntimeInput & {
      sessionEpoch: string;
      generationId: number;
    };
  };
  identity: InterviewLiveIdentity;
}

export type InteractionAction =
  | 'NONE'
  | 'WAIT'
  | 'PAUSE'
  | 'END'
  | 'TECHNICAL_RECOVERY'
  | 'SAFE_RESPONSE';

export type InterviewAction =
  | 'NONE'
  | 'ACKNOWLEDGE'
  | 'FOLLOW_UP'
  | 'CLARIFY'
  | 'OFFER_TOPIC'
  | 'SWITCH_TOPIC';

export type EvidenceKind = 'TURN' | 'MEMORY' | 'UI_EVENT' | 'RUNTIME_SIGNAL';

export interface InterviewEvidenceRef {
  ref: string;
  kind: EvidenceKind;
  purpose: string;
}

export type InterviewUncertainty = 'LOW' | 'MEDIUM' | 'HIGH';

export interface InterviewUtterancePlan {
  intent: string;
  suggestedText: string;
  questionCount: 0 | 1;
  mustAvoid: string[];
}

export type InterviewObligationId =
  | 'AUTHORITY_BOUNDARY'
  | 'TERMINAL_GUARD'
  | 'DELIVERY_SUPPRESSION'
  | 'GENERATION_CANCEL'
  | 'SESSION_CONTROL'
  | 'SAFETY_RESPONSE'
  | 'TECHNICAL_RECOVERY'
  | 'TOPIC_GOVERNANCE'
  | 'RETENTION_NO_SAVE'
  | 'MEMORY_INPUT_BLOCK'
  | 'INTERVIEW_MOVE';

export type InterviewObligationPlane =
  | 'AUTHORITY'
  | 'RUNTIME'
  | 'SESSION'
  | 'SAFETY'
  | 'TOPIC'
  | 'RETENTION'
  | 'INTERVIEW';

export interface InterviewObligation {
  id: InterviewObligationId;
  plane: InterviewObligationPlane;
  operation: string;
  sourceRefs: string[];
}

export type EpochRelation = 'SAME' | 'STALE' | 'TERMINAL_REJECTED' | 'UNKNOWN';
export type GenerationCancelScope = 'NONE' | 'GENERATION_ID' | 'ACTIVE_RESPONSE_FALLBACK';

export interface InterviewRuntimeControl {
  sessionEpoch: {
    current: string | null;
    incoming: string | null;
    relation: EpochRelation;
  };
  generation: {
    activeGenerationId: number | null;
    incomingGenerationId: number | null;
    cancelRequested: boolean;
    cancelScope: GenerationCancelScope;
    cancelGenerationId: number | null;
  };
  delivery: {
    mode: 'EMIT' | 'SUPPRESS';
    reasonCode: string | null;
  };
}

export interface InterviewRetentionControl {
  intent: 'DEFAULT' | 'NO_SAVE';
  scope: 'NONE' | 'CURRENT_TURN' | 'PREVIOUS_COMPLETED_TURN' | 'CURRENT_TOPIC' | 'CURRENT_SESSION';
  sourceRefs: string[];
  cancelPendingExtraction: boolean;
}

export interface InterviewStatePatch {
  sessionStatus?: InterviewSessionStatus;
  mode?: InterviewMode;
  /** Clear a pending formal-interview invitation after an explicit decline. */
  pendingModeOffer?: null;
  currentTopic?: string | null;
  blockedTopicsAdd?: string[];
  resumePoint?: string | null;
  dropPendingResponse?: boolean;
}

export interface InterviewMemoryCandidate {
  candidateId: string;
  evidenceRefs: string[];
  status: 'CANDIDATE';
}

export interface InterviewNextAction {
  schemaVersion: '0.2';
  decisionId: string;
  mode: InterviewMode;
  interactionAction: InteractionAction;
  interviewAction: InterviewAction;
  reasonCodes: string[];
  evidenceRefs: InterviewEvidenceRef[];
  uncertainty: InterviewUncertainty;
  utterancePlan: InterviewUtterancePlan;
  obligations: InterviewObligation[];
  runtimeControl: InterviewRuntimeControl;
  retentionControl: InterviewRetentionControl;
  statePatch: InterviewStatePatch;
  memoryCandidates: InterviewMemoryCandidate[];
  storyCandidateRefs: string[];
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertStringOrNull(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`${field} must be a string or null`);
  }
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

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

export function assertInterviewLiveIdentity(value: unknown): InterviewLiveIdentity {
  assertRecord(value, 'identity');
  assertNonEmptyString(value.sessionEpoch, 'identity.sessionEpoch');
  assertNonEmptyString(value.turnId, 'identity.turnId');
  assertNonNegativeInteger(value.generationId, 'identity.generationId');
  assertNonEmptyString(value.invocationId, 'identity.invocationId');
  if (value.responseId !== undefined) assertNonEmptyString(value.responseId, 'identity.responseId');
  assertStringArray(value.evidenceRefs, 'identity.evidenceRefs');
  return value as unknown as InterviewLiveIdentity;
}

export function assertInterviewPolicyInput(value: unknown): InterviewPolicyInput {
  assertRecord(value, 'input');
  assertEnum(value.mode, ['DAILY_CHAT', 'FORMAL_INTERVIEW'], 'input.mode');
  assertEnum(value.sessionStatus, ['ACTIVE', 'PAUSED', 'ENDED', 'RECOVERING'], 'input.sessionStatus');
  assertStringOrNull(value.currentTopic, 'input.currentTopic');
  if (value.selectedTopic !== undefined) assertStringOrNull(value.selectedTopic, 'input.selectedTopic');
  if (value.pendingModeOffer !== undefined && value.pendingModeOffer !== null) {
    assertEnum(value.pendingModeOffer, ['FORMAL_INTERVIEW'], 'input.pendingModeOffer');
  }
  assertNonNegativeInteger(value.followUpDepth, 'input.followUpDepth');
  if (value.previousCompletedUserEvidenceRef !== undefined) {
    assertStringOrNull(value.previousCompletedUserEvidenceRef, 'input.previousCompletedUserEvidenceRef');
  }
  if (value.sessionEpoch !== undefined) assertNonEmptyString(value.sessionEpoch, 'input.sessionEpoch');

  assertRecord(value.asr, 'input.asr');
  assertEnum(value.asr.status, ['NONE', 'PARTIAL', 'FINAL', 'FAILED'], 'input.asr.status');
  if (typeof value.asr.text !== 'string') throw new TypeError('input.asr.text must be a string');
  if (value.asr.ref !== null) assertNonEmptyString(value.asr.ref, 'input.asr.ref');

  assertRecord(value.runtime, 'input.runtime');
  assertEnum(value.runtime.vad, ['SILENT', 'SPEAKING', 'UNKNOWN'], 'input.runtime.vad');
  assertEnum(value.runtime.tts, ['IDLE', 'PLAYING'], 'input.runtime.tts');
  assertEnum(value.runtime.network, ['ONLINE', 'OFFLINE'], 'input.runtime.network');
  assertEnum(value.runtime.provider, ['READY', 'TIMEOUT'], 'input.runtime.provider');
  if (value.runtime.ref !== undefined && value.runtime.ref !== null) {
    assertNonEmptyString(value.runtime.ref, 'input.runtime.ref');
  }
  if (value.runtime.sessionEpoch !== undefined) {
    assertNonEmptyString(value.runtime.sessionEpoch, 'input.runtime.sessionEpoch');
  }
  if (value.runtime.generationId !== undefined) {
    assertNonNegativeInteger(value.runtime.generationId, 'input.runtime.generationId');
  }
  for (const field of ['silenceSeconds', 'waitPreferenceSeconds'] as const) {
    const candidate = value.runtime[field];
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) {
      throw new TypeError(`input.runtime.${field} must be a finite non-negative number`);
    }
  }

  if (value.uiEvent !== null) {
    assertRecord(value.uiEvent, 'input.uiEvent');
    assertEnum(value.uiEvent.type, ['END_BUTTON', 'MEMORY_TOPIC_CLICK'], 'input.uiEvent.type');
    assertNonEmptyString(value.uiEvent.ref, 'input.uiEvent.ref');
  }

  if (value.incomingEvent !== undefined && value.incomingEvent !== null) {
    assertRecord(value.incomingEvent, 'input.incomingEvent');
    assertEnum(value.incomingEvent.type, ['PROVIDER_RESPONSE'], 'input.incomingEvent.type');
    assertNonEmptyString(value.incomingEvent.ref, 'input.incomingEvent.ref');
    if (value.incomingEvent.sessionEpoch !== undefined) {
      assertNonEmptyString(value.incomingEvent.sessionEpoch, 'input.incomingEvent.sessionEpoch');
    }
    if (value.incomingEvent.generationId !== undefined) {
      assertNonNegativeInteger(value.incomingEvent.generationId, 'input.incomingEvent.generationId');
    }
    if (value.incomingEvent.originDecisionId !== undefined) {
      assertNonEmptyString(value.incomingEvent.originDecisionId, 'input.incomingEvent.originDecisionId');
    }
  }

  assertStringArray(value.blockedTopics, 'input.blockedTopics');
  if (!Array.isArray(value.memoryRefs)) throw new TypeError('input.memoryRefs must be an array');
  value.memoryRefs.forEach((memory, index) => {
    assertRecord(memory, `input.memoryRefs[${index}]`);
    assertNonEmptyString(memory.ref, `input.memoryRefs[${index}].ref`);
    assertNonEmptyString(memory.source, `input.memoryRefs[${index}].source`);
    if (typeof memory.text !== 'string') {
      throw new TypeError(`input.memoryRefs[${index}].text must be a string`);
    }
    if (typeof memory.allowedForInterview !== 'boolean') {
      throw new TypeError(`input.memoryRefs[${index}].allowedForInterview must be a boolean`);
    }
  });

  return value as unknown as InterviewPolicyInput;
}

/**
 * Strict live boundary. It deliberately refuses the compatibility reducer's
 * null/unknown epoch and generation fallback.
 */
export function assertLiveInterviewDecisionRequest(value: unknown): LiveInterviewDecisionRequest {
  assertRecord(value, 'request');
  const input = assertInterviewPolicyInput(value.input);
  const identity = assertInterviewLiveIdentity(value.identity);

  assertNonEmptyString(input.sessionEpoch, 'input.sessionEpoch');
  assertNonEmptyString(input.runtime.sessionEpoch, 'input.runtime.sessionEpoch');
  assertNonNegativeInteger(input.runtime.generationId, 'input.runtime.generationId');
  if (input.sessionEpoch !== identity.sessionEpoch || input.runtime.sessionEpoch !== identity.sessionEpoch) {
    throw new Error('live sessionEpoch must match identity.sessionEpoch');
  }
  if (input.runtime.generationId !== identity.generationId) {
    throw new Error('live generationId must match identity.generationId');
  }

  if (input.asr.status !== 'NONE') {
    assertNonEmptyString(input.asr.ref, `input.asr.ref is required for ASR ${input.asr.status}`);
  }
  const runtimeSignalRequiresEvidence = input.runtime.network === 'OFFLINE'
    || input.runtime.provider === 'TIMEOUT'
    || input.runtime.vad === 'SPEAKING'
    || input.runtime.tts === 'PLAYING'
    || input.runtime.silenceSeconds !== undefined
    || input.runtime.waitPreferenceSeconds !== undefined;
  if (runtimeSignalRequiresEvidence) {
    assertNonEmptyString(input.runtime.ref, 'input.runtime.ref is required for decision-affecting runtime signals');
  }

  if (input.incomingEvent) {
    assertNonEmptyString(input.incomingEvent.sessionEpoch, 'input.incomingEvent.sessionEpoch');
    assertNonNegativeInteger(input.incomingEvent.generationId, 'input.incomingEvent.generationId');
    if (input.incomingEvent.sessionEpoch !== identity.sessionEpoch) {
      throw new Error('input.incomingEvent.sessionEpoch must match identity.sessionEpoch');
    }
    if (input.incomingEvent.generationId !== identity.generationId) {
      throw new Error('input.incomingEvent.generationId must match identity.generationId');
    }
  }

  const requiredEvidence: Array<{ field: string; ref: string | null | undefined }> = [
    { field: 'input.asr.ref', ref: input.asr.ref },
    { field: 'input.runtime.ref', ref: input.runtime.ref },
    { field: 'input.uiEvent.ref', ref: input.uiEvent?.ref },
    { field: 'input.incomingEvent.ref', ref: input.incomingEvent?.ref },
    ...input.memoryRefs.map((memory, index) => ({
      field: `input.memoryRefs[${index}].ref`,
      ref: memory.ref,
    })),
  ];
  for (const item of requiredEvidence) {
    if (item.ref !== null && item.ref !== undefined && !identity.evidenceRefs.includes(item.ref)) {
      throw new Error(`identity.evidenceRefs must include ${item.field}`);
    }
  }
  return value as unknown as LiveInterviewDecisionRequest;
}

export function assertInterviewNextAction(value: unknown): InterviewNextAction {
  assertRecord(value, 'nextAction');
  if (value.schemaVersion !== '0.2') throw new TypeError('nextAction.schemaVersion must be 0.2');
  if (typeof value.decisionId !== 'string' || !/^v0\.2:[a-f0-9]{24}$/u.test(value.decisionId)) {
    throw new TypeError('nextAction.decisionId is invalid');
  }
  assertEnum(value.mode, ['DAILY_CHAT', 'FORMAL_INTERVIEW'], 'nextAction.mode');
  assertEnum(
    value.interactionAction,
    ['NONE', 'WAIT', 'PAUSE', 'END', 'TECHNICAL_RECOVERY', 'SAFE_RESPONSE'],
    'nextAction.interactionAction',
  );
  assertEnum(
    value.interviewAction,
    ['NONE', 'ACKNOWLEDGE', 'FOLLOW_UP', 'CLARIFY', 'OFFER_TOPIC', 'SWITCH_TOPIC'],
    'nextAction.interviewAction',
  );
  if ((value.interactionAction === 'NONE') === (value.interviewAction === 'NONE')) {
    throw new Error('exactly one action plane must be active');
  }
  assertStringArray(value.reasonCodes, 'nextAction.reasonCodes');
  if (value.reasonCodes.length === 0) throw new Error('nextAction.reasonCodes must not be empty');
  if (!Array.isArray(value.evidenceRefs)) throw new TypeError('nextAction.evidenceRefs must be an array');
  value.evidenceRefs.forEach((item, index) => {
    assertRecord(item, `nextAction.evidenceRefs[${index}]`);
    assertNonEmptyString(item.ref, `nextAction.evidenceRefs[${index}].ref`);
    assertEnum(item.kind, ['TURN', 'MEMORY', 'UI_EVENT', 'RUNTIME_SIGNAL'], `nextAction.evidenceRefs[${index}].kind`);
    assertNonEmptyString(item.purpose, `nextAction.evidenceRefs[${index}].purpose`);
  });
  assertEnum(value.uncertainty, ['LOW', 'MEDIUM', 'HIGH'], 'nextAction.uncertainty');
  if (!Array.isArray(value.obligations) || value.obligations.length === 0) {
    throw new TypeError('nextAction.obligations must be a non-empty array');
  }
  value.obligations.forEach((item, index) => {
    assertRecord(item, `nextAction.obligations[${index}]`);
    assertEnum(
      item.id,
      [
        'AUTHORITY_BOUNDARY',
        'TERMINAL_GUARD',
        'DELIVERY_SUPPRESSION',
        'GENERATION_CANCEL',
        'SESSION_CONTROL',
        'SAFETY_RESPONSE',
        'TECHNICAL_RECOVERY',
        'TOPIC_GOVERNANCE',
        'RETENTION_NO_SAVE',
        'MEMORY_INPUT_BLOCK',
        'INTERVIEW_MOVE',
      ],
      `nextAction.obligations[${index}].id`,
    );
    assertEnum(
      item.plane,
      ['AUTHORITY', 'RUNTIME', 'SESSION', 'SAFETY', 'TOPIC', 'RETENTION', 'INTERVIEW'],
      `nextAction.obligations[${index}].plane`,
    );
    assertNonEmptyString(item.operation, `nextAction.obligations[${index}].operation`);
    assertStringArray(item.sourceRefs, `nextAction.obligations[${index}].sourceRefs`);
  });
  assertRecord(value.runtimeControl, 'nextAction.runtimeControl');
  assertRecord(value.retentionControl, 'nextAction.retentionControl');
  assertRecord(value.utterancePlan, 'nextAction.utterancePlan');
  assertNonEmptyString(value.utterancePlan.intent, 'nextAction.utterancePlan.intent');
  if (typeof value.utterancePlan.suggestedText !== 'string') {
    throw new TypeError('nextAction.utterancePlan.suggestedText must be a string');
  }
  if (value.utterancePlan.questionCount !== 0 && value.utterancePlan.questionCount !== 1) {
    throw new TypeError('nextAction.utterancePlan.questionCount must be 0 or 1');
  }
  assertStringArray(value.utterancePlan.mustAvoid, 'nextAction.utterancePlan.mustAvoid');

  assertRecord(value.runtimeControl.sessionEpoch, 'nextAction.runtimeControl.sessionEpoch');
  assertStringOrNull(value.runtimeControl.sessionEpoch.current, 'nextAction.runtimeControl.sessionEpoch.current');
  assertStringOrNull(value.runtimeControl.sessionEpoch.incoming, 'nextAction.runtimeControl.sessionEpoch.incoming');
  assertEnum(
    value.runtimeControl.sessionEpoch.relation,
    ['SAME', 'STALE', 'TERMINAL_REJECTED', 'UNKNOWN'],
    'nextAction.runtimeControl.sessionEpoch.relation',
  );
  assertRecord(value.runtimeControl.generation, 'nextAction.runtimeControl.generation');
  for (const field of ['activeGenerationId', 'incomingGenerationId', 'cancelGenerationId'] as const) {
    const candidate = value.runtimeControl.generation[field];
    if (candidate !== null) {
      assertNonNegativeInteger(candidate, `nextAction.runtimeControl.generation.${field}`);
    }
  }
  if (typeof value.runtimeControl.generation.cancelRequested !== 'boolean') {
    throw new TypeError('nextAction.runtimeControl.generation.cancelRequested must be boolean');
  }
  assertEnum(
    value.runtimeControl.generation.cancelScope,
    ['NONE', 'GENERATION_ID', 'ACTIVE_RESPONSE_FALLBACK'],
    'nextAction.runtimeControl.generation.cancelScope',
  );
  const generation = value.runtimeControl.generation;
  if (!generation.cancelRequested && (generation.cancelScope !== 'NONE' || generation.cancelGenerationId !== null)) {
    throw new Error('non-cancelled generation must use NONE/null');
  }
  if (
    generation.cancelScope === 'GENERATION_ID' &&
    (!generation.cancelRequested || generation.cancelGenerationId === null)
  ) {
    throw new Error('GENERATION_ID cancellation requires an explicit id');
  }
  if (
    generation.cancelScope === 'ACTIVE_RESPONSE_FALLBACK' &&
    (!generation.cancelRequested || generation.cancelGenerationId !== null)
  ) {
    throw new Error('ACTIVE_RESPONSE_FALLBACK cancellation requires a null id');
  }
  assertRecord(value.runtimeControl.delivery, 'nextAction.runtimeControl.delivery');
  assertEnum(value.runtimeControl.delivery.mode, ['EMIT', 'SUPPRESS'], 'nextAction.runtimeControl.delivery.mode');
  assertStringOrNull(value.runtimeControl.delivery.reasonCode, 'nextAction.runtimeControl.delivery.reasonCode');
  if (value.runtimeControl.delivery.mode === 'SUPPRESS') {
    if (value.utterancePlan.suggestedText !== '' || value.utterancePlan.questionCount !== 0) {
      throw new Error('suppressed delivery must have empty text and zero questions');
    }
  }

  assertEnum(value.retentionControl.intent, ['DEFAULT', 'NO_SAVE'], 'nextAction.retentionControl.intent');
  assertEnum(
    value.retentionControl.scope,
    ['NONE', 'CURRENT_TURN', 'PREVIOUS_COMPLETED_TURN', 'CURRENT_TOPIC', 'CURRENT_SESSION'],
    'nextAction.retentionControl.scope',
  );
  assertStringArray(value.retentionControl.sourceRefs, 'nextAction.retentionControl.sourceRefs');
  if (typeof value.retentionControl.cancelPendingExtraction !== 'boolean') {
    throw new TypeError('nextAction.retentionControl.cancelPendingExtraction must be boolean');
  }
  if (
    value.retentionControl.intent === 'NO_SAVE' &&
    (value.retentionControl.scope === 'NONE' || !value.retentionControl.cancelPendingExtraction)
  ) {
    throw new Error('NO_SAVE must have a concrete scope and cancel pending extraction');
  }
  assertRecord(value.statePatch, 'nextAction.statePatch');
  if (!Array.isArray(value.memoryCandidates) || !Array.isArray(value.storyCandidateRefs)) {
    throw new TypeError('candidate outputs must be arrays');
  }
  value.memoryCandidates.forEach((candidate, index) => {
    assertRecord(candidate, `nextAction.memoryCandidates[${index}]`);
    assertNonEmptyString(candidate.candidateId, `nextAction.memoryCandidates[${index}].candidateId`);
    assertStringArray(candidate.evidenceRefs, `nextAction.memoryCandidates[${index}].evidenceRefs`);
    if (candidate.evidenceRefs.length === 0 || candidate.status !== 'CANDIDATE') {
      throw new Error(`nextAction.memoryCandidates[${index}] is invalid`);
    }
  });
  assertStringArray(value.storyCandidateRefs, 'nextAction.storyCandidateRefs');
  return value as unknown as InterviewNextAction;
}
