import type { RuntimeChannel, RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import type { GenerationCancellationRegistry } from '../algorithm-runtime/cancellation-registry.ts';
import type { AuditedTtsRuntime } from '../model-runtime/contracts.ts';
import type {
  DailyChatResponseRuntime,
  InterviewRealizer,
} from '../response-runtime/contracts.ts';
import type {
  AsyncJobRequest,
} from './async-jobs.ts';
import type {
  TurnProcessingAdapter,
  TurnResponseRequest,
  TurnResponseResult,
  TurnTtsResult,
} from './orchestrator.ts';

export interface CreateG4TurnProcessingAdapterOptions {
  cancellationRegistry: GenerationCancellationRegistry;
  daily: DailyChatResponseRuntime;
  interview: InterviewRealizer;
  tts?: AuditedTtsRuntime;
  synthesize?: TurnProcessingAdapter['synthesize'];
  planAsyncJobs(request: {
    mode: TurnResponseRequest['mode'];
    identity: RuntimeIdentity;
    response: TurnResponseResult;
  }): AsyncJobRequest[];
  nextAttemptId?: (module: 'tts', identity: RuntimeIdentity) => string;
  nextRequestId?: (module: 'tts', identity: RuntimeIdentity) => string;
  onAudio?: (identity: RuntimeIdentity, audio: Uint8Array, signal: AbortSignal) => void;
}

function linkCancellation(
  signal: AbortSignal,
  registry: GenerationCancellationRegistry,
  identity: RuntimeIdentity,
  channel: RuntimeChannel,
): () => void {
  const cancel = () => registry.cancel(identity, channel, 'turn_root_cancelled');
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
}

function mapDaily(result: Awaited<ReturnType<DailyChatResponseRuntime['run']>>): TurnResponseResult {
  return {
    status: result.status,
    text: result.text,
    policyEngine: 'DailyChatPolicy',
    action: result.intent,
    questionCount: result.questionCount,
    evidenceRefs: [...result.evidenceRefs],
    retentionIntent: 'DEFAULT',
    retentionScope: 'NONE',
    sessionControl: 'CONTINUE',
  };
}

function mapInterview(
  result: Awaited<ReturnType<InterviewRealizer['run']>>,
): TurnResponseResult {
  return {
    status: result.status,
    text: result.text,
    policyEngine: 'InterviewPolicyV0.2',
    action: result.action,
    questionCount: result.questionCount,
    evidenceRefs: [...result.evidenceRefs],
    retentionIntent: result.retentionControl.intent,
    retentionScope: result.retentionControl.scope,
    sessionControl: result.action === 'END' ? 'END' : result.action === 'PAUSE' ? 'PAUSE' : 'CONTINUE',
  };
}

function mapTts(result: Awaited<ReturnType<AuditedTtsRuntime['run']>>): TurnTtsResult {
  return {
    status: result.status,
    audioChunkCount: result.audioChunks.length,
  };
}

/**
 * Thin bridge from the G5 lifecycle tree to the already-tested G4 runtimes.
 * It passes only server-bound identity; G4 resolvers recover governed content.
 */
export function createG4TurnProcessingAdapter(
  options: CreateG4TurnProcessingAdapterOptions,
): TurnProcessingAdapter {
  if (!options?.cancellationRegistry) throw new TypeError('cancellationRegistry is required');
  if (!options.daily || !options.interview || (!options.tts && !options.synthesize)) {
    throw new TypeError('daily, interview, and tts runtimes are required');
  }
  const nextAttemptId = options.nextAttemptId
    ?? ((module: 'tts', identity: RuntimeIdentity) => `${module}:${identity.invocationId}:attempt:1`);
  const nextRequestId = options.nextRequestId
    ?? ((module: 'tts', identity: RuntimeIdentity) => `${module}:${identity.invocationId}:request:1`);
  return {
    async respond(request) {
      const channel: RuntimeChannel = request.mode === 'DAILY_CHAT' ? 'daily_chat' : 'formal_interview';
      const unlink = linkCancellation(
        request.signal,
        options.cancellationRegistry,
        request.identity,
        channel,
      );
      try {
        return request.mode === 'DAILY_CHAT'
          ? mapDaily(await options.daily.run({
              schemaVersion: 'daily-chat-decision-v0.1',
              identity: request.identity,
              intent: 'RESPOND',
            }))
          : mapInterview(await options.interview.run({
              schemaVersion: 'interview-realizer-request-v0.1',
              identity: request.identity,
            }));
      } finally {
        unlink();
      }
    },
    async synthesize(request) {
      if (options.synthesize) return options.synthesize(request);
      options.cancellationRegistry.begin(request.identity, 'tts');
      const unlink = linkCancellation(
        request.signal,
        options.cancellationRegistry,
        request.identity,
        'tts',
      );
      try {
        return mapTts(await options.tts!.run({
          identity: request.identity,
          attemptId: nextAttemptId('tts', request.identity),
          requestId: nextRequestId('tts', request.identity),
          text: request.text,
          onAudio: options.onAudio === undefined ? undefined : (audio, context) => {
            if (context.signal.aborted || request.signal.aborted) return 'DROPPED';
            options.onAudio?.(context.identity, audio, context.signal);
            return 'COMMITTED';
          },
        }));
      } finally {
        unlink();
      }
    },
    planAsyncJobs: options.planAsyncJobs,
  };
}
