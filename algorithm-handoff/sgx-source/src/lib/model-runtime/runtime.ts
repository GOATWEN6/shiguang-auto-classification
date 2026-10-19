import {
  assertRuntimeIdentity,
  type CancellationCleanupStatus,
  type NormalizedRuntimeError,
  type ProviderUsage,
  type RuntimeIdentity,
} from '../algorithm-runtime/contracts.ts';
import type {
  BorrowedGenerationExecutionPermit,
  GenerationExecutionLease,
} from '../algorithm-runtime/cancellation-registry.ts';
import type {
  AuditedTextRunInput,
  AuditedTextRunResult,
  AuditedTextRuntime,
  AuditedTextRuntimeOptions,
  AuditedTtsRunInput,
  AuditedTtsRunResult,
  AuditedTtsRuntime,
  AuditedTtsRuntimeOptions,
  BillingVerificationRequest,
  ExecuteRuntimeRequest,
  ProviderAttemptTelemetry,
  ProviderBillingState,
  TextRuntimeModule,
} from './contracts.ts';

const TEXT_MODULES = new Set<TextRuntimeModule>([
  'daily_chat',
  'formal_interview',
  'story_draft',
  'profile_draft',
]);
const TEXT_USAGE_KEYS = new Set<keyof ProviderUsage>([
  'inputTokens',
  'outputTokens',
  'totalTokens',
]);
const TTS_USAGE_KEYS = new Set<keyof ProviderUsage>([
  'inputCharacters',
  'outputAudioMs',
]);
const MAX_ID_LENGTH = 512;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TTS_TEXT_LENGTH = 100_000;
const DEFAULT_SINK_ACKNOWLEDGEMENT_TIMEOUT_MS = 1_000;

type MutableTrace = {
  queuedAt: string;
  providerStartedAt: string | null;
  firstOutputAt: string | null;
  completedAt: string | null;
  usage: ProviderUsage | null;
  costCny: number | null;
  billingState: ProviderBillingState;
  runtimeGateExecutionCount: number;
  cancellationCleanupStatus: CancellationCleanupStatus;
};

type SettledOrAborted<T> =
  | { kind: 'fulfilled'; value: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'aborted' };

class OneShotRuntimeRequestGate {
  private count = 0;
  private violation = false;
  private readonly signal: AbortSignal;
  private readonly onStart: () => void;

  constructor(
    signal: AbortSignal,
    onStart: () => void,
  ) {
    this.signal = signal;
    this.onStart = onStart;
  }

  readonly execute: ExecuteRuntimeRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (typeof operation !== 'function') {
      this.violation = true;
      throw new Error('runtime request operation must be a function');
    }
    if (this.count !== 0) {
      this.violation = true;
      throw new Error('runtime request gate permits exactly one execution');
    }
    if (this.signal.aborted) {
      throw new DOMException('provider invocation was cancelled', 'AbortError');
    }

    this.count = 1;
    this.onStart();
    return operation();
  };

  get requestCount(): number {
    return this.count;
  }

  get wasViolated(): boolean {
    return this.violation;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionEpoch === right.sessionEpoch
    && left.turnId === right.turnId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId
    && left.responseId === right.responseId
    && left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((item, index) => item === right.evidenceRefs[index]);
}

function readEventIdentity(value: unknown): RuntimeIdentity | null {
  if (!isRecord(value)) return null;
  const evidenceRefs = value.evidenceRefs;
  if (
    typeof value.sessionEpoch !== 'string'
    || typeof value.turnId !== 'string'
    || !Number.isInteger(value.generationId)
    || typeof value.invocationId !== 'string'
    || (value.responseId !== undefined && typeof value.responseId !== 'string')
    || !Array.isArray(evidenceRefs)
    || !evidenceRefs.every(item => typeof item === 'string')
  ) return null;
  return {
    sessionEpoch: value.sessionEpoch,
    turnId: value.turnId,
    generationId: value.generationId as number,
    invocationId: value.invocationId,
    ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
    evidenceRefs: [...evidenceRefs] as string[],
  };
}

function normalizeUsage(
  value: unknown,
  allowedKeys: ReadonlySet<keyof ProviderUsage>,
  requiredKeys: readonly (keyof ProviderUsage)[],
): ProviderUsage | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== allowedKeys.size) return null;
  const usage: ProviderUsage = {};
  for (const [key, amount] of entries) {
    if (
      !allowedKeys.has(key as keyof ProviderUsage)
      || typeof amount !== 'number'
      || !Number.isFinite(amount)
      || !Number.isInteger(amount)
      || amount < 0
    ) return null;
    usage[key as keyof ProviderUsage] = amount;
  }
  if (requiredKeys.some(key => usage[key] === undefined)) return null;
  return usage;
}

function millisecondsBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error('runtime clock must return monotonic ISO timestamps');
  }
  return endMs - startMs;
}

function finishTrace(trace: MutableTrace, completedAt: string): ProviderAttemptTelemetry {
  trace.completedAt = completedAt;
  return {
    queuedAt: trace.queuedAt,
    providerStartedAt: trace.providerStartedAt,
    firstOutputAt: trace.firstOutputAt,
    completedAt,
    firstOutputLatencyMs: trace.firstOutputAt === null
      ? null
      : millisecondsBetween(trace.queuedAt, trace.firstOutputAt),
    totalLatencyMs: millisecondsBetween(trace.queuedAt, completedAt),
    usage: trace.usage === null ? null : { ...trace.usage },
    costCny: trace.costCny,
    billingState: trace.billingState,
    sdkRetryPolicy: 'DISABLED',
    runtimeGateExecutionCount: trace.runtimeGateExecutionCount,
    cancellationCleanupStatus: trace.cancellationCleanupStatus,
  };
}

function initialTrace(now: () => string): MutableTrace {
  return {
    queuedAt: now(),
    providerStartedAt: null,
    firstOutputAt: null,
    completedAt: null,
    usage: null,
    costCny: 0,
    billingState: 'UNBILLED',
    runtimeGateExecutionCount: 0,
    cancellationCleanupStatus: 'NOT_REQUIRED',
  };
}

function cancelledError(): NormalizedRuntimeError {
  return {
    code: 'cancelled',
    message: 'provider invocation was cancelled',
    retryable: false,
  };
}

function invalidConfig(message: string): NormalizedRuntimeError {
  return { code: 'invalid_config', message, retryable: false };
}

function invalidSchema(message: string): NormalizedRuntimeError {
  return { code: 'invalid_schema', message, retryable: false };
}

function pricingCatalogInvalid(message: string): NormalizedRuntimeError {
  return { code: 'pricing_catalog_invalid', message, retryable: false };
}

function transportFailure(kind: 'text' | 'tts'): NormalizedRuntimeError {
  return {
    code: 'unknown',
    message: `${kind} transport failed`,
    retryable: false,
  };
}

function assertBoundedNonEmptyString(value: unknown, field: string, maxLength: number): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${field} exceeds the supported length`);
}

function validateTextIdentityAndModule(input: unknown): NormalizedRuntimeError | null {
  try {
    if (!isRecord(input)) throw new Error('text runtime input must be an object');
    assertRuntimeIdentity(input.identity as RuntimeIdentity);
    if (typeof input.module !== 'string' || !TEXT_MODULES.has(input.module as TextRuntimeModule)) {
      throw new Error('module is not a supported text runtime module');
    }
    return null;
  } catch {
    return invalidConfig('text runtime identity or module is invalid');
  }
}

function validateTextFields(input: AuditedTextRunInput): NormalizedRuntimeError | null {
  try {
    assertBoundedNonEmptyString(input.attemptId, 'attemptId', MAX_ID_LENGTH);
    assertBoundedNonEmptyString(input.requestId, 'requestId', MAX_ID_LENGTH);
    assertBoundedNonEmptyString(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    if (input.onVisibleText !== undefined && typeof input.onVisibleText !== 'function') {
      throw new Error('onVisibleText must be a function');
    }
    return null;
  } catch {
    return invalidConfig('text runtime fields are invalid');
  }
}

function validateTtsIdentity(input: unknown): NormalizedRuntimeError | null {
  try {
    if (!isRecord(input)) throw new Error('TTS runtime input must be an object');
    assertRuntimeIdentity(input.identity as RuntimeIdentity);
    return null;
  } catch {
    return invalidConfig('TTS runtime identity is invalid');
  }
}

function validateTtsFields(input: AuditedTtsRunInput): NormalizedRuntimeError | null {
  try {
    assertBoundedNonEmptyString(input.attemptId, 'attemptId', MAX_ID_LENGTH);
    assertBoundedNonEmptyString(input.requestId, 'requestId', MAX_ID_LENGTH);
    assertBoundedNonEmptyString(input.text, 'text', MAX_TTS_TEXT_LENGTH);
    if (input.onAudio !== undefined && typeof input.onAudio !== 'function') {
      throw new Error('onAudio must be a function');
    }
    return null;
  } catch {
    return invalidConfig('TTS runtime fields are invalid');
  }
}

type GenerationExecutionContext = GenerationExecutionLease | BorrowedGenerationExecutionPermit;

function activeFor(lease: GenerationExecutionContext): boolean {
  return !lease.signal.aborted && lease.accepts().accepted;
}

async function settleOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<SettledOrAborted<T>> {
  const settled = promise.then<SettledOrAborted<T>, SettledOrAborted<T>>(
    value => ({ kind: 'fulfilled', value }),
    error => ({ kind: 'rejected', error }),
  );
  if (signal.aborted) return { kind: 'aborted' };

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<SettledOrAborted<T>>(resolve => {
    onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function sinkAcknowledgementTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SINK_ACKNOWLEDGEMENT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > 30_000) {
    throw new TypeError('sinkAcknowledgementTimeoutMs must be an integer between 1 and 30000');
  }
  return value;
}

async function waitForSinkAcknowledgements(
  queue: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(resolve => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = queue.then(() => true as const);
  const result = await Promise.race([settled, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

function cancellationSinkCleanupStatus(
  sinksSettled: boolean,
  sinkCleanupFailed: boolean,
): Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'> {
  if (!sinksSettled) return 'TIMED_OUT';
  return sinkCleanupFailed ? 'FAILED' : 'JOINED';
}

function validateCompletion(
  value: unknown,
  kind: 'text' | 'tts',
):
  | { ok: true; usage: ProviderUsage; reportedCostCny: number }
  | { ok: false; error: NormalizedRuntimeError } {
  if (!isRecord(value)) {
    return { ok: false, error: invalidSchema('transport completion must be an object') };
  }
  const completionKeys = Reflect.ownKeys(value);
  if (
    completionKeys.length !== 2
    || !completionKeys.includes('usage')
    || !completionKeys.includes('costCny')
    || typeof value.costCny !== 'number'
    || !Number.isFinite(value.costCny)
    || value.costCny < 0
  ) {
    return {
      ok: false,
      error: invalidSchema('transport completion must include only usage and a non-negative cost claim'),
    };
  }
  const usage = kind === 'text'
    ? normalizeUsage(value.usage, TEXT_USAGE_KEYS, ['inputTokens', 'outputTokens', 'totalTokens'])
    : normalizeUsage(value.usage, TTS_USAGE_KEYS, ['inputCharacters', 'outputAudioMs']);
  if (!usage) {
    return {
      ok: false,
      error: invalidSchema(`${kind} transport completion contains invalid usage`),
    };
  }
  if (
    kind === 'text'
    && usage.totalTokens !== (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  ) {
    return {
      ok: false,
      error: invalidSchema('text totalTokens must equal inputTokens plus outputTokens'),
    };
  }
  return { ok: true, usage, reportedCostCny: value.costCny };
}

function verifyBilling(
  verifier: AuditedTextRuntimeOptions['billingVerifier'],
  request: BillingVerificationRequest,
): { ok: true; costCny: number } | { ok: false; error: NormalizedRuntimeError } {
  let result: unknown;
  try {
    result = verifier.verify({
      ...request,
      identity: { ...request.identity, evidenceRefs: [...request.identity.evidenceRefs] },
      usage: { ...request.usage },
    });
  } catch {
    return { ok: false, error: pricingCatalogInvalid('billing verification failed') };
  }
  if (
    !isRecord(result)
    || Reflect.ownKeys(result).length !== 1
    || typeof result.costCny !== 'number'
    || !Number.isFinite(result.costCny)
    || result.costCny < 0
  ) {
    return { ok: false, error: pricingCatalogInvalid('billing claim was not verified') };
  }
  return { ok: true, costCny: result.costCny };
}

function markRuntimeRequestStarted(
  trace: MutableTrace,
  now: () => string,
): void {
  trace.runtimeGateExecutionCount = 1;
  trace.providerStartedAt = now();
  trace.costCny = null;
  trace.billingState = 'UNKNOWN';
}

export function createAuditedTextRuntime(
  options: AuditedTextRuntimeOptions,
): AuditedTextRuntime {
  if (!options?.billingVerifier || typeof options.billingVerifier.verify !== 'function') {
    throw new TypeError('billingVerifier.verify is required');
  }
  const now = options.now ?? defaultNow;
  const sinkAckTimeoutMs = sinkAcknowledgementTimeout(options.sinkAcknowledgementTimeoutMs);

  const runText = async (
    input: AuditedTextRunInput,
    borrowedPermit?: BorrowedGenerationExecutionPermit,
  ): Promise<AuditedTextRunResult> => {
      const trace = initialTrace(now);
      const inputError = validateTextIdentityAndModule(input);
      if (inputError) {
        return {
          status: 'failed',
          text: '',
          error: inputError,
          telemetry: finishTrace(trace, now()),
        };
      }

      let lease: GenerationExecutionContext | null = null;
      let ownedLease: GenerationExecutionLease | null = null;
      let borrowedPermitConsumed = false;
      try {
        if (borrowedPermit) {
          if (!options.cancellationRegistry.consumeBorrowedPermit(
            borrowedPermit,
            input.identity,
            input.module,
          )) {
            return {
              status: 'failed',
              text: '',
              error: invalidConfig('borrowed execution permit is invalid'),
              telemetry: finishTrace(trace, now()),
            };
          }
          borrowedPermitConsumed = true;
          lease = borrowedPermit;
        } else {
          ownedLease = options.cancellationRegistry.acquireLease(input.identity, input.module);
          lease = ownedLease;
        }
        const fieldsError = validateTextFields(input);
        if (fieldsError) {
          return {
            status: 'failed',
            text: '',
            error: fieldsError,
            telemetry: finishTrace(trace, now()),
          };
        }
        if (!lease || !activeFor(lease)) {
          return {
            status: 'cancelled',
            text: '',
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }

        const gate = new OneShotRuntimeRequestGate(
          lease.signal,
          () => markRuntimeRequestStarted(trace, now),
        );
        let text = '';
        let eventError: NormalizedRuntimeError | null = null;
        let sinkCleanupFailed = false;
        let acceptingEvents = true;
        let eventQueue = Promise.resolve();

        const emit = (event: unknown): Promise<void> => {
          const current = eventQueue.then(async () => {
            if (!acceptingEvents || eventError || !activeFor(lease!)) return;
            if (gate.requestCount !== 1 || gate.wasViolated) {
              eventError = invalidConfig('text output was emitted outside the runtime request gate');
              return;
            }
            if (!isRecord(event) || event.kind !== 'text_delta') {
              eventError = invalidSchema('text transport emitted an unknown event');
              return;
            }
            const eventIdentity = readEventIdentity(event.identity);
            if (!eventIdentity) {
              eventError = invalidSchema('text event is missing a valid identity');
              return;
            }
            if (!sameIdentity(eventIdentity, lease!.identity) || !activeFor(lease!)) return;
            if (typeof event.text !== 'string') {
              eventError = invalidSchema('text_delta.text must be a string');
              return;
            }
            if (event.text.length === 0) return;

            let commit: unknown = 'COMMITTED';
            try {
              if (input.onVisibleText) {
                commit = await input.onVisibleText(event.text, {
                  identity: { ...lease!.identity, evidenceRefs: [...lease!.identity.evidenceRefs] },
                  signal: lease!.signal,
                });
              }
            } catch {
              if (!activeFor(lease!)) sinkCleanupFailed = true;
              eventError = transportFailure('text');
              return;
            }
            if (commit !== 'COMMITTED' && commit !== 'DROPPED') {
              if (!activeFor(lease!)) sinkCleanupFailed = true;
              eventError = invalidConfig('text sink must acknowledge COMMITTED or DROPPED');
              return;
            }
            if (commit === 'DROPPED') return;
            if (!activeFor(lease!)) {
              sinkCleanupFailed = true;
              eventError = invalidConfig('text sink committed after cancellation');
              return;
            }
            if (!acceptingEvents) return;
            text += event.text;
            if (trace.firstOutputAt === null) trace.firstOutputAt = now();
          });
          eventQueue = current.catch(() => {
            eventError ??= transportFailure('text');
          });
          return current;
        };

        const transportPromise = Promise.resolve().then(() => options.transport.invoke({
          module: input.module,
          identity: lease!.identity,
          signal: lease!.signal,
          attemptId: input.attemptId,
          requestId: input.requestId,
          prompt: input.prompt,
          sdkRetryPolicy: 'DISABLED',
        }, emit, gate.execute));
        const transportOutcome = await settleOrAbort(transportPromise, lease.signal);

        if (transportOutcome.kind === 'aborted') {
          acceptingEvents = false;
          const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
          trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(
            sinksSettled,
            sinkCleanupFailed,
          );
          return {
            status: 'cancelled',
            text,
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (transportOutcome.kind === 'rejected') {
          acceptingEvents = false;
          const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
          if (!activeFor(lease)) {
            trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(
              sinksSettled,
              sinkCleanupFailed,
            );
            return {
              status: 'cancelled',
              text,
              error: cancelledError(),
              telemetry: finishTrace(trace, now()),
            };
          }
          if (!sinksSettled) {
            return {
              status: 'failed',
              text,
              error: invalidConfig('text sink acknowledgement timed out'),
              telemetry: finishTrace(trace, now()),
            };
          }
          return {
            status: 'failed',
            text,
            error: transportFailure('text'),
            telemetry: finishTrace(trace, now()),
          };
        }

        acceptingEvents = false;
        const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
        if (!sinksSettled) {
          if (!activeFor(lease)) {
            trace.cancellationCleanupStatus = 'TIMED_OUT';
            return {
              status: 'cancelled',
              text,
              error: cancelledError(),
              telemetry: finishTrace(trace, now()),
            };
          }
          return {
            status: 'failed',
            text,
            error: invalidConfig('text sink acknowledgement timed out'),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (!activeFor(lease)) {
          trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(true, sinkCleanupFailed);
          return {
            status: 'cancelled',
            text,
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (gate.requestCount !== 1 || gate.wasViolated) {
          return {
            status: 'failed',
            text,
            error: invalidConfig('one runtime attempt must use the runtime request gate exactly once'),
            telemetry: finishTrace(trace, now()),
          };
        }

        const completion = validateCompletion(transportOutcome.value, 'text');
        if (!completion.ok) {
          return {
            status: 'failed',
            text,
            error: completion.error,
            telemetry: finishTrace(trace, now()),
          };
        }
        const billing = verifyBilling(options.billingVerifier, {
          module: input.module,
          identity: lease.identity,
          attemptId: input.attemptId,
          requestId: input.requestId,
          usage: completion.usage,
          reportedCostCny: completion.reportedCostCny,
        });
        if (!billing.ok) {
          return {
            status: 'failed',
            text,
            error: billing.error,
            telemetry: finishTrace(trace, now()),
          };
        }
        trace.usage = { ...completion.usage };
        trace.costCny = billing.costCny;
        trace.billingState = 'VALIDATED';
        if (eventError) {
          return {
            status: 'failed',
            text,
            error: eventError,
            telemetry: finishTrace(trace, now()),
          };
        }
        if (text.length === 0) {
          return {
            status: 'failed',
            text: '',
            error: invalidSchema('text transport completed without visible text'),
            telemetry: finishTrace(trace, now()),
          };
        }
        return {
          status: 'success',
          text,
          telemetry: finishTrace(trace, now()),
        };
      } finally {
        if (borrowedPermit && borrowedPermitConsumed) {
          options.cancellationRegistry.completeBorrowedPermit(
            borrowedPermit,
            trace.cancellationCleanupStatus,
          );
        }
        ownedLease?.finalize();
      }
  };

  return {
    run: input => runText(input),
    runBorrowed: (input, permit) => runText(input, permit),
  };
}

export function createAuditedTtsRuntime(
  options: AuditedTtsRuntimeOptions,
): AuditedTtsRuntime {
  if (!options?.billingVerifier || typeof options.billingVerifier.verify !== 'function') {
    throw new TypeError('billingVerifier.verify is required');
  }
  const now = options.now ?? defaultNow;
  const sinkAckTimeoutMs = sinkAcknowledgementTimeout(options.sinkAcknowledgementTimeoutMs);

  const runTts = async (
    input: AuditedTtsRunInput,
    borrowedPermit?: BorrowedGenerationExecutionPermit,
  ): Promise<AuditedTtsRunResult> => {
      const trace = initialTrace(now);
      const preservedText = isRecord(input) && typeof input.text === 'string' ? input.text : '';
      const inputError = validateTtsIdentity(input);
      if (inputError) {
        return {
          status: 'audio_unavailable',
          text: preservedText,
          audioChunks: [],
          error: inputError,
          telemetry: finishTrace(trace, now()),
        };
      }

      let lease: GenerationExecutionContext | null = null;
      let ownedLease: GenerationExecutionLease | null = null;
      let borrowedPermitConsumed = false;
      try {
        if (borrowedPermit) {
          if (!options.cancellationRegistry.consumeBorrowedPermit(
            borrowedPermit,
            input.identity,
            'tts',
          )) {
            return {
              status: 'audio_unavailable',
              text: input.text,
              audioChunks: [],
              error: invalidConfig('borrowed execution permit is invalid'),
              telemetry: finishTrace(trace, now()),
            };
          }
          borrowedPermitConsumed = true;
          lease = borrowedPermit;
        } else {
          ownedLease = options.cancellationRegistry.acquireLease(input.identity, 'tts');
          lease = ownedLease;
        }
        const fieldsError = validateTtsFields(input);
        if (fieldsError) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: [],
            error: fieldsError,
            telemetry: finishTrace(trace, now()),
          };
        }
        if (!lease || !activeFor(lease)) {
          return {
            status: 'cancelled',
            text: input.text,
            audioChunks: [],
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }

        const gate = new OneShotRuntimeRequestGate(
          lease.signal,
          () => markRuntimeRequestStarted(trace, now),
        );
        const delivered: Uint8Array[] = [];
        let eventError: NormalizedRuntimeError | null = null;
        let sinkCleanupFailed = false;
        let acceptingEvents = true;
        let eventQueue = Promise.resolve();

        const emit = (event: unknown): Promise<void> => {
          const current = eventQueue.then(async () => {
            if (!acceptingEvents || eventError || !activeFor(lease!)) return;
            if (gate.requestCount !== 1 || gate.wasViolated) {
              eventError = invalidConfig('TTS output was emitted outside the runtime request gate');
              return;
            }
            if (!isRecord(event) || event.kind !== 'audio_chunk') {
              eventError = invalidSchema('TTS transport emitted an unknown event');
              return;
            }
            const eventIdentity = readEventIdentity(event.identity);
            if (!eventIdentity) {
              eventError = invalidSchema('audio event is missing a valid identity');
              return;
            }
            if (!sameIdentity(eventIdentity, lease!.identity) || !activeFor(lease!)) return;
            if (!(event.audio instanceof Uint8Array)) {
              eventError = invalidSchema('audio_chunk.audio must be a Uint8Array');
              return;
            }
            if (event.audio.byteLength === 0) return;

            const copy = new Uint8Array(event.audio);
            let commit: unknown = 'COMMITTED';
            try {
              if (input.onAudio) {
                commit = await input.onAudio(copy, {
                  identity: { ...lease!.identity, evidenceRefs: [...lease!.identity.evidenceRefs] },
                  signal: lease!.signal,
                });
              }
            } catch {
              if (!activeFor(lease!)) sinkCleanupFailed = true;
              eventError = transportFailure('tts');
              return;
            }
            if (commit !== 'COMMITTED' && commit !== 'DROPPED') {
              if (!activeFor(lease!)) sinkCleanupFailed = true;
              eventError = invalidConfig('TTS sink must acknowledge COMMITTED or DROPPED');
              return;
            }
            if (commit === 'DROPPED') return;
            if (!activeFor(lease!)) {
              sinkCleanupFailed = true;
              eventError = invalidConfig('TTS sink committed after cancellation');
              return;
            }
            if (!acceptingEvents) return;
            delivered.push(copy);
            if (trace.firstOutputAt === null) trace.firstOutputAt = now();
          });
          eventQueue = current.catch(() => {
            eventError ??= transportFailure('tts');
          });
          return current;
        };

        const transportPromise = Promise.resolve().then(() => options.transport.synthesize({
          identity: lease!.identity,
          signal: lease!.signal,
          attemptId: input.attemptId,
          requestId: input.requestId,
          text: input.text,
          sdkRetryPolicy: 'DISABLED',
        }, emit, gate.execute));
        const transportOutcome = await settleOrAbort(transportPromise, lease.signal);

        if (transportOutcome.kind === 'aborted') {
          acceptingEvents = false;
          const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
          trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(
            sinksSettled,
            sinkCleanupFailed,
          );
          return {
            status: 'cancelled',
            text: input.text,
            audioChunks: delivered,
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (transportOutcome.kind === 'rejected') {
          acceptingEvents = false;
          const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
          if (!activeFor(lease)) {
            trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(
              sinksSettled,
              sinkCleanupFailed,
            );
            return {
              status: 'cancelled',
              text: input.text,
              audioChunks: delivered,
              error: cancelledError(),
              telemetry: finishTrace(trace, now()),
            };
          }
          if (!sinksSettled) {
            return {
              status: 'audio_unavailable',
              text: input.text,
              audioChunks: delivered,
              error: invalidConfig('TTS sink acknowledgement timed out'),
              telemetry: finishTrace(trace, now()),
            };
          }
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: transportFailure('tts'),
            telemetry: finishTrace(trace, now()),
          };
        }

        acceptingEvents = false;
        const sinksSettled = await waitForSinkAcknowledgements(eventQueue, sinkAckTimeoutMs);
        if (!sinksSettled) {
          if (!activeFor(lease)) {
            trace.cancellationCleanupStatus = 'TIMED_OUT';
            return {
              status: 'cancelled',
              text: input.text,
              audioChunks: delivered,
              error: cancelledError(),
              telemetry: finishTrace(trace, now()),
            };
          }
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: invalidConfig('TTS sink acknowledgement timed out'),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (!activeFor(lease)) {
          trace.cancellationCleanupStatus = cancellationSinkCleanupStatus(true, sinkCleanupFailed);
          return {
            status: 'cancelled',
            text: input.text,
            audioChunks: delivered,
            error: cancelledError(),
            telemetry: finishTrace(trace, now()),
          };
        }
        if (gate.requestCount !== 1 || gate.wasViolated) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: invalidConfig('one runtime attempt must use the runtime request gate exactly once'),
            telemetry: finishTrace(trace, now()),
          };
        }

        const completion = validateCompletion(transportOutcome.value, 'tts');
        if (!completion.ok) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: completion.error,
            telemetry: finishTrace(trace, now()),
          };
        }
        const billing = verifyBilling(options.billingVerifier, {
          module: 'tts',
          identity: lease.identity,
          attemptId: input.attemptId,
          requestId: input.requestId,
          usage: completion.usage,
          reportedCostCny: completion.reportedCostCny,
        });
        if (!billing.ok) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: billing.error,
            telemetry: finishTrace(trace, now()),
          };
        }
        trace.usage = { ...completion.usage };
        trace.costCny = billing.costCny;
        trace.billingState = 'VALIDATED';
        if (eventError) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: delivered,
            error: eventError,
            telemetry: finishTrace(trace, now()),
          };
        }
        if (delivered.length === 0) {
          return {
            status: 'audio_unavailable',
            text: input.text,
            audioChunks: [],
            error: invalidSchema('TTS transport completed without non-empty audio'),
            telemetry: finishTrace(trace, now()),
          };
        }
        return {
          status: 'success',
          text: input.text,
          audioChunks: delivered,
          telemetry: finishTrace(trace, now()),
        };
      } finally {
        if (borrowedPermit && borrowedPermitConsumed) {
          options.cancellationRegistry.completeBorrowedPermit(
            borrowedPermit,
            trace.cancellationCleanupStatus,
          );
        }
        ownedLease?.finalize();
      }
  };

  return {
    run: input => runTts(input),
    runBorrowed: (input, permit) => runTts(input, permit),
  };
}
