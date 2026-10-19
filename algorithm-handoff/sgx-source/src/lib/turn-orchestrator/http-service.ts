import {
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertTimestamp,
  type AsrTurnFinalRequest,
  type TrustedSessionAuthority,
} from './contracts.ts';
import {
  TurnOrchestrator,
  type FinalTurnInput,
  type InterruptRequest,
  type OrchestratorAuditRecord,
  type PartialTurnInput,
} from './orchestrator.ts';

export interface AlgorithmHttpMetadata {
  buildId: string;
  manifestSha256: string;
  fixtureSha256: string;
  serviceVersion?: string;
  contractVersion?: string;
  /** Internal algorithm revision used by the session view and paid-run gate. */
  interviewPolicyVersion?: string;
  /** Compatibility alias consumed by older preflight clients. */
  policyVersion?: string;
  /**
   * Credential-free identity of the configured provider and algorithm code.
   * Endpoint URLs, API keys and the raw ASR resource ID are deliberately not
   * representable in this public shape.
   */
  runtimeFingerprint?: AlgorithmRuntimeFingerprint;
}

export interface AlgorithmRuntimeFingerprint {
  schemaVersion: 'algorithm-runtime-fingerprint-v0.1';
  text: {
    model: string;
    temperature: number;
    timeoutMs: number;
  };
  asr: {
    resourceIdSha256: string;
  };
  tts: {
    provider: string;
    model: string;
    voiceId: string;
    outputFormat: string;
    sampleRate: number;
    speed: number;
    volume: number;
    pitch: number;
    synthesisTimeoutMs: number;
  };
  code: {
    promptCodeSha256: string;
    interviewPolicyCodeSha256: string;
    responseGuardCodeSha256: string;
  };
  fingerprintSha256: string;
}

export interface AlgorithmHttpError {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface AlgorithmHttpResult<T = unknown> {
  status: number;
  body: T | AlgorithmHttpError;
}

export interface AlgorithmHttpCall<TBody = unknown> {
  requestId: string;
  body: TBody;
}

export interface AlgorithmSessionHttpCall<TBody = unknown> extends AlgorithmHttpCall<TBody> {
  opaqueSessionHandle: string;
}

export interface AlgorithmCreateSessionCall extends AlgorithmHttpCall {
  authority: TrustedSessionAuthority;
}

export interface AlgorithmHttpService {
  health(): AlgorithmHttpResult;
  version(): AlgorithmHttpResult;
  createSession(call: AlgorithmCreateSessionCall): AlgorithmHttpResult;
  submitTurn(call: AlgorithmSessionHttpCall): Promise<AlgorithmHttpResult>;
  interrupt(call: AlgorithmSessionHttpCall): AlgorithmHttpResult;
  end(call: AlgorithmSessionHttpCall): AlgorithmHttpResult;
  ordinaryLogs(): OrchestratorAuditRecord[];
}

export interface CreateAlgorithmHttpServiceOptions {
  orchestrator: TurnOrchestrator;
  metadata: AlgorithmHttpMetadata;
  ready?: boolean | (() => boolean);
  executionMode?: 'LOCAL_FAKE' | 'REAL_INTERNAL';
  providerStatus?: () => { networkCalls: number; costCny: number | null };
}

function assertRequestId(value: unknown): asserts value is string {
  assertNonEmptyString(value, 'requestId');
}

function error(
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
): AlgorithmHttpResult {
  return { status, body: { requestId, code, message, retryable } };
}

function normalizeFailure(requestId: string, cause: unknown): AlgorithmHttpResult {
  const message = cause instanceof Error ? cause.message : '';
  if (/idempotencyToken reused|operationId reused/u.test(message)) {
    return error(requestId, 409, 'idempotency_conflict', '幂等键已用于不同请求。');
  }
  if (/unknown session|unknown session handle|no longer exists/u.test(message)) {
    return error(requestId, 404, 'session_not_found', '会话不存在或已失效。');
  }
  if (/session is |cannot open a turn while session/u.test(message)) {
    return error(requestId, 409, 'session_not_active', '当前会话不能接收新一轮输入。');
  }
  if (cause instanceof TypeError || /not allowed|must be|is required|is not supported/u.test(message)) {
    return error(requestId, 400, 'invalid_schema', '请求格式不符合 algorithm v0.1 合同。');
  }
  return error(requestId, 500, 'internal_error', '算法服务未能完成请求。', true);
}

function exactUiEvent(value: unknown): { type: 'MEMORY_TOPIC_CLICK'; ref: string } {
  assertPlainRecord(value, 'body.uiEvent');
  assertExactKeys(value, ['type', 'ref'], 'body.uiEvent');
  if (value.type !== 'MEMORY_TOPIC_CLICK') throw new TypeError('body.uiEvent.type is not supported');
  assertNonEmptyString(value.ref, 'body.uiEvent.ref');
  return { type: 'MEMORY_TOPIC_CLICK', ref: value.ref };
}

function sessionBody(value: unknown): {
  idempotencyKey: string;
  requestedMode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW';
} {
  assertPlainRecord(value, 'body');
  assertExactKeys(value, ['schemaVersion', 'idempotencyKey', 'requestedMode'], 'body');
  if (value.schemaVersion !== 'algorithm-session-create-v0.1') {
    throw new TypeError('body.schemaVersion must be algorithm-session-create-v0.1');
  }
  assertNonEmptyString(value.idempotencyKey, 'body.idempotencyKey');
  if (value.requestedMode !== 'DAILY_CHAT' && value.requestedMode !== 'FORMAL_INTERVIEW') {
    throw new TypeError('body.requestedMode is invalid');
  }
  return { idempotencyKey: value.idempotencyKey, requestedMode: value.requestedMode };
}

function turnBody(value: unknown): PartialTurnInput | FinalTurnInput {
  assertPlainRecord(value, 'body');
  if (value.schemaVersion !== 'algorithm-turn-v0.1') {
    throw new TypeError('body.schemaVersion must be algorithm-turn-v0.1');
  }
  assertNonEmptyString(value.idempotencyKey, 'body.idempotencyKey');
  assertTimestamp(value.receivedAt, 'body.receivedAt');
  if (value.event === 'ASR_PARTIAL') {
    assertExactKeys(value, [
      'schemaVersion', 'idempotencyKey', 'event', 'partialId', 'text', 'receivedAt',
    ], 'body');
    assertNonEmptyString(value.partialId, 'body.partialId');
    if (typeof value.text !== 'string') throw new TypeError('body.text must be a string');
    return {
      schemaVersion: 'orchestrated-partial-v0.1',
      idempotencyToken: value.idempotencyKey,
      partialId: value.partialId,
      text: value.text,
      receivedAt: value.receivedAt,
    };
  }
  if (value.event !== 'FINAL') throw new TypeError('body.event is not supported');
  const uiEvent = value.uiEvent === undefined ? undefined : exactUiEvent(value.uiEvent);
  const uiAction = uiEvent === undefined ? undefined : {
    type: 'MEMORY_TOPIC_CLICK' as const,
    eventRef: uiEvent.ref,
    targetMode: 'FORMAL_INTERVIEW' as const,
  };
  if (value.source === 'TYPED_TEXT') {
    assertExactKeys(value, [
      'schemaVersion', 'idempotencyKey', 'event', 'source', 'text', 'receivedAt', 'uiEvent',
    ], 'body');
    assertNonEmptyString(value.text, 'body.text');
    return {
      schemaVersion: 'orchestrated-turn-v0.1',
      idempotencyToken: value.idempotencyKey,
      source: 'TYPED_TEXT',
      text: value.text,
      receivedAt: value.receivedAt,
      ...(uiAction === undefined ? {} : { uiAction }),
    };
  }
  if (value.source === 'ASR_FINAL') {
    assertExactKeys(value, [
      'schemaVersion', 'idempotencyKey', 'event', 'source', 'segments', 'receivedAt', 'uiEvent',
    ], 'body');
    if (!Array.isArray(value.segments) || value.segments.length === 0) {
      throw new TypeError('body.segments must be a non-empty array');
    }
    return {
      schemaVersion: 'orchestrated-turn-v0.1',
      idempotencyToken: value.idempotencyKey,
      source: 'ASR_FINAL',
      segments: structuredClone(value.segments) as AsrTurnFinalRequest['segments'],
      receivedAt: value.receivedAt,
      ...(uiAction === undefined ? {} : { uiAction }),
    } as FinalTurnInput;
  }
  throw new TypeError('body.source is not supported');
}

function interruptBody(value: unknown): InterruptRequest {
  assertPlainRecord(value, 'body');
  assertExactKeys(value, [
    'schemaVersion', 'idempotencyKey', 'interruptTargetHandle', 'reason',
  ], 'body');
  if (value.schemaVersion !== 'algorithm-interrupt-v0.1') {
    throw new TypeError('body.schemaVersion must be algorithm-interrupt-v0.1');
  }
  assertNonEmptyString(value.idempotencyKey, 'body.idempotencyKey');
  assertNonEmptyString(value.interruptTargetHandle, 'body.interruptTargetHandle');
  assertNonEmptyString(value.reason, 'body.reason');
  return {
    schemaVersion: 'orchestrated-interrupt-v0.1',
    idempotencyToken: value.idempotencyKey,
    targetHandle: value.interruptTargetHandle,
    reason: value.reason as InterruptRequest['reason'],
  };
}

function endBody(value: unknown): string {
  assertPlainRecord(value, 'body');
  assertExactKeys(value, ['schemaVersion', 'idempotencyKey'], 'body');
  if (value.schemaVersion !== 'algorithm-session-end-v0.1') {
    throw new TypeError('body.schemaVersion must be algorithm-session-end-v0.1');
  }
  assertNonEmptyString(value.idempotencyKey, 'body.idempotencyKey');
  return value.idempotencyKey;
}

function publicRuntimeFingerprint(
  value: AlgorithmRuntimeFingerprint | undefined,
): AlgorithmRuntimeFingerprint | undefined {
  if (!value) return undefined;
  // Explicit reconstruction is intentional: adding a provider config field
  // can never make it appear in /version without a reviewed contract change.
  return {
    schemaVersion: 'algorithm-runtime-fingerprint-v0.1',
    text: {
      model: value.text.model,
      temperature: value.text.temperature,
      timeoutMs: value.text.timeoutMs,
    },
    asr: { resourceIdSha256: value.asr.resourceIdSha256 },
    tts: {
      provider: value.tts.provider,
      model: value.tts.model,
      voiceId: value.tts.voiceId,
      outputFormat: value.tts.outputFormat,
      sampleRate: value.tts.sampleRate,
      speed: value.tts.speed,
      volume: value.tts.volume,
      pitch: value.tts.pitch,
      synthesisTimeoutMs: value.tts.synthesisTimeoutMs,
    },
    code: {
      promptCodeSha256: value.code.promptCodeSha256,
      interviewPolicyCodeSha256: value.code.interviewPolicyCodeSha256,
      responseGuardCodeSha256: value.code.responseGuardCodeSha256,
    },
    fingerprintSha256: value.fingerprintSha256,
  };
}

export function createAlgorithmHttpService(
  options: CreateAlgorithmHttpServiceOptions,
): AlgorithmHttpService {
  if (!options?.orchestrator) throw new TypeError('orchestrator is required');
  assertNonEmptyString(options.metadata?.buildId, 'metadata.buildId');
  assertNonEmptyString(options.metadata?.manifestSha256, 'metadata.manifestSha256');
  assertNonEmptyString(options.metadata?.fixtureSha256, 'metadata.fixtureSha256');
  const isReady = () => typeof options.ready === 'function' ? options.ready() : options.ready ?? true;
  const serviceVersion = options.metadata.serviceVersion ?? 'g5-local-fake-v0.1';
  const contractVersion = options.metadata.contractVersion ?? 'algorithm-http-v0.1';
  const runtimeFingerprint = publicRuntimeFingerprint(options.metadata.runtimeFingerprint);
  return {
    health() {
      const ready = isReady();
      return {
        status: ready ? 200 : 503,
        body: {
          schemaVersion: 'algorithm-health-v0.1',
          status: ready ? 'ready' : 'not_ready',
          mode: options.executionMode ?? 'LOCAL_FAKE',
          paidExecutionEnabled: options.executionMode === 'REAL_INTERNAL',
          networkCalls: options.providerStatus?.().networkCalls ?? 0,
          costCny: options.executionMode === 'REAL_INTERNAL'
            ? options.providerStatus?.().costCny ?? null : 0,
          components: {
            sessionRegistry: ready ? 'ready' : 'not_ready',
            leaseTree: ready ? 'ready' : 'not_ready',
            evidenceStore: ready ? 'ready' : 'not_ready',
            policy: ready ? 'ready' : 'not_ready',
            responseTts: ready ? 'ready' : 'not_ready',
            asyncJobs: ready ? 'ready' : 'not_ready',
          },
        },
      };
    },
    version() {
      return {
        status: 200,
        body: {
          schemaVersion: 'algorithm-version-v0.1',
          apiVersion: 'v0.1',
          serviceVersion,
          contractVersion,
          buildId: options.metadata.buildId,
          manifestSha256: options.metadata.manifestSha256,
          fixtureSha256: options.metadata.fixtureSha256,
          rollbackCompatibility: 'cancel_or_drain_then_replay_24_turns_10_interrupts',
          paidExecutionEnabled: options.executionMode === 'REAL_INTERNAL',
          ...(options.metadata.interviewPolicyVersion
            ? { interviewPolicyVersion: options.metadata.interviewPolicyVersion } : {}),
          ...(options.metadata.interviewPolicyVersion
            ? { policyVersion: options.metadata.interviewPolicyVersion } : {}),
          ...(runtimeFingerprint ? { runtimeFingerprint: structuredClone(runtimeFingerprint) } : {}),
        },
      };
    },
    createSession(call) {
      try {
        assertRequestId(call?.requestId);
        if (!isReady()) return error(call.requestId, 503, 'service_not_ready', '算法服务尚未就绪。', true);
        const parsed = sessionBody(call.body);
        const result = options.orchestrator.startSession({
          schemaVersion: 'client-session-start-v0.1',
          idempotencyToken: parsed.idempotencyKey,
          requestedMode: parsed.requestedMode,
        }, call.authority);
        return { status: result.replayed ? 200 : 201, body: { requestId: call.requestId, ...result } };
      } catch (cause) {
        return normalizeFailure(typeof call?.requestId === 'string' ? call.requestId : 'invalid_request', cause);
      }
    },
    async submitTurn(call) {
      try {
        assertRequestId(call?.requestId);
        if (!isReady()) return error(call.requestId, 503, 'service_not_ready', '算法服务尚未就绪。', true);
        assertNonEmptyString(call?.opaqueSessionHandle, 'opaqueSessionHandle');
        const parsed = turnBody(call.body);
        if (parsed.schemaVersion === 'orchestrated-partial-v0.1') {
          const result = options.orchestrator.observePartial(call.opaqueSessionHandle, parsed);
          return { status: 200, body: { requestId: call.requestId, ...result } };
        }
        const result = await options.orchestrator.runFinalTurn(call.opaqueSessionHandle, parsed);
        return { status: 200, body: { requestId: call.requestId, ...result } };
      } catch (cause) {
        return normalizeFailure(typeof call?.requestId === 'string' ? call.requestId : 'invalid_request', cause);
      }
    },
    interrupt(call) {
      try {
        assertRequestId(call?.requestId);
        assertNonEmptyString(call?.opaqueSessionHandle, 'opaqueSessionHandle');
        const result = options.orchestrator.interrupt(call.opaqueSessionHandle, interruptBody(call.body));
        if (!result.accepted) {
          return error(call.requestId, 409, 'stale_interrupt_target', '打断目标已失效。');
        }
        return { status: 202, body: { requestId: call.requestId, ...result } };
      } catch (cause) {
        return normalizeFailure(typeof call?.requestId === 'string' ? call.requestId : 'invalid_request', cause);
      }
    },
    end(call) {
      try {
        assertRequestId(call?.requestId);
        assertNonEmptyString(call?.opaqueSessionHandle, 'opaqueSessionHandle');
        const result = options.orchestrator.endSession(
          call.opaqueSessionHandle,
          endBody(call.body),
        );
        return {
          status: 200,
          body: {
            requestId: call.requestId,
            schemaVersion: 'algorithm-session-end-result-v0.1',
            status: result.status,
            sessionEpoch: result.sessionEpoch,
          },
        };
      } catch (cause) {
        return normalizeFailure(typeof call?.requestId === 'string' ? call.requestId : 'invalid_request', cause);
      }
    },
    ordinaryLogs() {
      return options.orchestrator.getAuditRecords();
    },
  };
}
