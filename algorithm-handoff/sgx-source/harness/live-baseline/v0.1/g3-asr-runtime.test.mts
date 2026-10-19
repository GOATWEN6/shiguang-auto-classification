import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  GenerationCancellationRegistry,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/index.ts';
import {
  AsrStreamReducer,
  createDoubaoStreamingAsrAdapter,
  decodeDoubaoServerFrame,
  translateDoubaoDecodedPayload,
  validatePcm16AudioChunk,
} from '../../../src/lib/asr-runtime/index.ts';

function serverFrameWithoutSequence(payload: Record<string, unknown>): Uint8Array {
  const compressed = gzipSync(new TextEncoder().encode(JSON.stringify(payload)));
  const frame = new Uint8Array(8 + compressed.byteLength);
  frame.set([0x11, 0x90, 0x11, 0x00], 0);
  new DataView(frame.buffer).setUint32(4, compressed.byteLength, false);
  frame.set(compressed, 8);
  return frame;
}

type FixtureEvent = {
  kind: string;
  providerSequence?: number;
  segmentIndex?: number;
  revision?: number;
  text?: string;
  usage?: Record<string, number>;
  ignoreAbort?: boolean;
};

type FixtureChunk = {
  sequence: number;
  durationMs: number;
  endOfStream: boolean;
};

type G3Fixture = {
  id: string;
  chunks?: FixtureChunk[];
  asrEvents?: FixtureEvent[];
  attempts?: Array<{
    connectionId?: string;
    events?: FixtureEvent[];
    outcome: Record<string, unknown>;
  }>;
  lateOldConnectionEvent?: FixtureEvent;
  conflictingEvent?: FixtureEvent;
  expected: Record<string, unknown>;
};

type G3FixtureFile = {
  audioFormat: {
    codec: string;
    sampleRateHz: number;
    bitsPerSample: number;
    channels: number;
    bytesPerMillisecond: number;
  };
  cases: G3Fixture[];
};

const fixtures = JSON.parse(readFileSync(
  new URL('./g3-fixtures.json', import.meta.url),
  'utf8',
)) as G3FixtureFile;

const RECEIVED_AT = '2026-10-03T11:00:00.000Z';

function fixture(id: string): G3Fixture {
  const found = fixtures.cases.find(item => item.id === id);
  assert.ok(found, `missing G3 fixture ${id}`);
  return structuredClone(found);
}

function identity(
  generationId: number,
  invocationId: string,
  responseId = `asr-response-${generationId}-${invocationId}`,
): RuntimeIdentity {
  return {
    sessionEpoch: 'g3-asr-session-epoch',
    turnId: `g3-asr-turn-${generationId}`,
    generationId,
    invocationId,
    responseId,
    evidenceRefs: [`g3-audio-source-${generationId}`],
  };
}

function activate(
  registry: GenerationCancellationRegistry,
  generationId: number,
  invocationId: string,
): RuntimeIdentity {
  const withResponse = identity(generationId, invocationId);
  const withoutResponse = { ...withResponse, responseId: undefined };
  registry.begin(withoutResponse, 'asr');
  return registry.bindResponse(withoutResponse, 'asr', withResponse.responseId!);
}

function audioChunk(durationMs: number, sequence: number, endOfStream: boolean) {
  return {
    sequence,
    audio: Buffer.alloc(durationMs * fixtures.audioFormat.bytesPerMillisecond),
    format: {
      codec: 'pcm16' as const,
      sampleRateHz: 16000,
      bitsPerSample: 16,
      channels: 1,
    },
    endOfStream,
  };
}

function canonicalEvent(
  event: FixtureEvent,
  context: {
    identity: RuntimeIdentity;
    attemptId: string;
    connectionId: string;
  },
) {
  return {
    ...structuredClone(event),
    ...context,
    receivedAt: RECEIVED_AT,
  };
}

function makeReducer(registry: GenerationCancellationRegistry) {
  const partials: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const memoryCandidates: Array<Record<string, unknown>> = [];
  const reducer = new AsrStreamReducer({
    cancellationRegistry: registry,
    onPartial: (event: Record<string, unknown>) => partials.push(structuredClone(event)),
    onEvidence: (item: Record<string, unknown>) => evidence.push(structuredClone(item)),
    onMemoryCandidate: (item: Record<string, unknown>) => memoryCandidates.push(structuredClone(item)),
  });
  return { reducer, partials, evidence, memoryCandidates };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function rejectionMessage(action: () => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'operation must reject with an Error');
  return caught.message;
}

test('PCM16 chunk validation derives duration from bytes and enforces 100/150/200ms plus a short explicit EOS tail', () => {
  const testCase = fixture('G3-01-HAPPY-BOUNDARIES');
  assert.deepEqual(testCase.chunks?.map(item => item.durationMs), [100, 150, 200, 80]);

  for (const item of testCase.chunks ?? []) {
    const validated = validatePcm16AudioChunk(audioChunk(
      item.durationMs,
      item.sequence,
      item.endOfStream,
    ));
    assert.equal(validated.durationMs, item.durationMs);
    assert.equal(validated.byteLength, item.durationMs * 32);
  }

  assert.throws(
    () => validatePcm16AudioChunk(audioChunk(99, 10, false)),
    /100.*200|chunk duration/,
  );
  assert.throws(
    () => validatePcm16AudioChunk(audioChunk(201, 11, false)),
    /100.*200|chunk duration/,
  );
  assert.throws(
    () => validatePcm16AudioChunk(audioChunk(80, 12, false)),
    /100.*200|tail|EOS/,
  );
  assert.throws(
    () => validatePcm16AudioChunk(audioChunk(0, 13, true)),
    /non-empty|audio/,
  );
  assert.throws(
    () => validatePcm16AudioChunk({
      ...audioChunk(100, 14, false),
      audio: Buffer.alloc(3199),
    }),
    /PCM|frame|byte|duration/,
  );
});

test('Doubao server frames may omit provider sequence and remain decodable for connection-level ordering', () => {
  const decoded = decodeDoubaoServerFrame(serverFrameWithoutSequence({
    code: 0,
    result: { text: '测试' },
  }));

  assert.equal(decoded.sequence, undefined);
  assert.equal(decoded.payload.payload_sequence, undefined);
  assert.deepEqual(decoded.payload.result, { text: '测试' });
});

test('partial events remain ephemeral while one accepted segment final creates one TranscriptEvidence and zero Memory candidates', () => {
  const testCase = fixture('G3-01-HAPPY-BOUNDARIES');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 1, 'happy-attempt-1');
  const state = makeReducer(registry);
  state.reducer.beginAttempt({
    identity: active,
    attemptId: 'happy-attempt-1',
    connectionId: 'happy-connection-1',
  });

  for (const event of testCase.asrEvents ?? []) {
    state.reducer.accept(canonicalEvent(event, {
      identity: active,
      attemptId: 'happy-attempt-1',
      connectionId: 'happy-connection-1',
    }));
    if (event.kind === 'partial') {
      assert.equal(state.evidence.length, 0);
      assert.equal(state.memoryCandidates.length, 0);
    }
  }

  assert.equal(state.partials.length, 2);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].kind, 'transcript_final');
  assert.equal(state.evidence[0].text, '我一九七八年结婚。');
  assert.equal(state.memoryCandidates.length, 0);
  assert.deepEqual(state.reducer.snapshot().usage, { inputAudioMs: 530 });
  assert.equal(state.reducer.snapshot().streamFinal, true);
});

test('out-of-order segments are emitted in order while exact duplicates, stale revisions and post-final partials are no-ops', () => {
  const testCase = fixture('G3-02-SEGMENT-REORDER-DEDUP');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 2, 'ordering-attempt-1');
  const state = makeReducer(registry);
  state.reducer.beginAttempt({
    identity: active,
    attemptId: 'ordering-attempt-1',
    connectionId: 'ordering-connection-1',
  });

  for (const event of testCase.asrEvents ?? []) {
    state.reducer.accept(canonicalEvent(event, {
      identity: active,
      attemptId: 'ordering-attempt-1',
      connectionId: 'ordering-connection-1',
    }));
  }

  assert.deepEqual(state.evidence.map(item => item.segmentIndex), [0, 1]);
  assert.deepEqual(state.evidence.map(item => item.text), [
    '我先在纺织厂工作。',
    '后来我们搬到了苏州。',
  ]);
  assert.equal(state.evidence.length, 2);
  assert.equal(state.memoryCandidates.length, 0);
});

test('same sequence or revision with conflicting content fails closed as invalid_schema', () => {
  const testCase = fixture('G3-02-SEGMENT-REORDER-DEDUP');
  assert.ok(testCase.asrEvents?.[0]);
  assert.ok(testCase.conflictingEvent);
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 3, 'conflict-attempt-1');
  const state = makeReducer(registry);
  const context = {
    identity: active,
    attemptId: 'conflict-attempt-1',
    connectionId: 'conflict-connection-1',
  };
  state.reducer.beginAttempt(context);
  assert.equal(state.reducer.accept(canonicalEvent(testCase.asrEvents[0], context)).accepted, true);
  const conflict = state.reducer.accept(canonicalEvent(testCase.conflictingEvent, context));

  assert.equal(conflict.accepted, false);
  assert.equal(conflict.errorCode, 'invalid_schema');
  assert.equal(conflict.fatal, true);
  assert.equal(state.evidence.length, 0);
  assert.equal(state.memoryCandidates.length, 0);
});

test('reconnect accepts only the new invocation and rejects a late final from the old connection', () => {
  const testCase = fixture('G3-03-RECONNECT-LATE-OLD-CONNECTION');
  assert.ok(testCase.attempts?.[0]?.events?.[0]);
  assert.ok(testCase.attempts?.[1]?.events);
  assert.ok(testCase.lateOldConnectionEvent);
  const registry = new GenerationCancellationRegistry();
  const oldIdentity = activate(registry, 4, 'reconnect-attempt-1');
  const state = makeReducer(registry);
  const oldContext = {
    identity: oldIdentity,
    attemptId: 'reconnect-attempt-1',
    connectionId: 'connection-old',
  };
  state.reducer.beginAttempt(oldContext);
  state.reducer.accept(canonicalEvent(testCase.attempts[0].events[0], oldContext));

  const newIdentity = activate(registry, 4, 'reconnect-attempt-2');
  const newContext = {
    identity: newIdentity,
    attemptId: 'reconnect-attempt-2',
    connectionId: 'connection-new',
  };
  state.reducer.beginAttempt(newContext);
  const late = state.reducer.accept(canonicalEvent(testCase.lateOldConnectionEvent, oldContext));
  for (const event of testCase.attempts[1].events ?? []) {
    state.reducer.accept(canonicalEvent(event, newContext));
  }

  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'stale_connection');
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].text, '新连接的最终转写。');
  const acceptedIdentity = state.evidence[0].identity;
  assert.ok(acceptedIdentity && typeof acceptedIdentity === 'object');
  assert.equal(
    (acceptedIdentity as { invocationId?: unknown }).invocationId,
    'reconnect-attempt-2',
  );
  assert.equal(state.memoryCandidates.length, 0);
});

test('old-generation and cancelled late finals are rejected without blocking the next generation', () => {
  const registry = new GenerationCancellationRegistry();
  const generationOne = activate(registry, 5, 'generation-5-attempt');
  const state = makeReducer(registry);
  const contextOne = {
    identity: generationOne,
    attemptId: 'generation-5-attempt',
    connectionId: 'generation-5-connection',
  };
  state.reducer.beginAttempt(contextOne);
  state.reducer.accept(canonicalEvent({
    kind: 'partial', providerSequence: 1, segmentIndex: 0, revision: 1, text: '旧代 partial',
  }, contextOne));

  const generationTwo = activate(registry, 6, 'generation-6-attempt');
  const contextTwo = {
    identity: generationTwo,
    attemptId: 'generation-6-attempt',
    connectionId: 'generation-6-connection',
  };
  state.reducer.beginAttempt(contextTwo);
  const oldFinal = state.reducer.accept(canonicalEvent({
    kind: 'segment_final', providerSequence: 2, segmentIndex: 0, revision: 2, text: '旧 generation final',
  }, contextOne));
  assert.equal(registry.cancel(generationTwo, 'asr', 'user_interrupt'), true);
  const cancelledFinal = state.reducer.accept(canonicalEvent({
    kind: 'segment_final', providerSequence: 2, segmentIndex: 0, revision: 2, text: '取消后 final',
  }, contextTwo));

  const generationThree = activate(registry, 7, 'generation-7-attempt');
  const contextThree = {
    identity: generationThree,
    attemptId: 'generation-7-attempt',
    connectionId: 'generation-7-connection',
  };
  state.reducer.beginAttempt(contextThree);
  const freshFinal = state.reducer.accept(canonicalEvent({
    kind: 'segment_final', providerSequence: 1, segmentIndex: 0, revision: 1, text: '新 generation final',
  }, contextThree));

  assert.equal(oldFinal.accepted, false);
  assert.match(oldFinal.reason, /stale_connection|generation_mismatch/);
  assert.equal(cancelledFinal.accepted, false);
  assert.equal(cancelledFinal.reason, 'cancelled');
  assert.equal(freshFinal.accepted, true);
  assert.deepEqual(state.evidence.map(item => item.text), ['新 generation final']);
  assert.equal(state.memoryCandidates.length, 0);
});

test('Doubao decoded payload maps only definite utterances to segment_final and only last to stream_final', () => {
  const active = identity(8, 'doubao-translate-attempt');
  const context = {
    identity: active,
    attemptId: 'doubao-translate-attempt',
    connectionId: 'doubao-translate-connection',
    receivedAt: RECEIVED_AT,
  };
  const translate = (definite: boolean, last: boolean, payloadSequence: number) => (
    translateDoubaoDecodedPayload({
      payload_sequence: payloadSequence,
      last,
      result: {
        text: '花市里的兰花。',
        utterances: [{
          id: 'provider-utterance-0',
          index: 0,
          definite,
          text: '花市里的兰花。',
          start_time: 0,
          end_time: 900,
        }],
      },
    }, context)
  );

  const partialOnly = translate(false, false, 1);
  assert.equal(partialOnly.some((event: { kind: string }) => event.kind === 'partial'), true);
  assert.equal(partialOnly.some((event: { kind: string }) => event.kind === 'segment_final'), false);
  assert.equal(partialOnly.some((event: { kind: string }) => event.kind === 'stream_final'), false);

  const segmentFinalOnly = translate(true, false, 2);
  assert.equal(segmentFinalOnly.some((event: { kind: string }) => event.kind === 'segment_final'), true);
  assert.equal(segmentFinalOnly.some((event: { kind: string }) => event.kind === 'stream_final'), false);

  const streamFinalOnly = translate(false, true, 3);
  assert.equal(streamFinalOnly.some((event: { kind: string }) => event.kind === 'segment_final'), false);
  assert.equal(streamFinalOnly.some((event: { kind: string }) => event.kind === 'stream_final'), true);

  const bothFinals = translate(true, true, 4);
  assert.equal(bothFinals.some((event: { kind: string }) => event.kind === 'segment_final'), true);
  assert.equal(bothFinals.some((event: { kind: string }) => event.kind === 'stream_final'), true);
});

test('Doubao Adapter opens only the injected transport with explicit signal, headers and requestId', async () => {
  const opened: Array<Record<string, unknown>> = [];
  const sent: Array<unknown> = [];
  let ended = 0;
  let cancelled = 0;
  const connection = {
    async send(value: unknown) { sent.push(value); },
    async end() { ended += 1; },
    async cancel() { cancelled += 1; },
  };
  const transportFactory = () => ({
    async open(options: Record<string, unknown>) {
      opened.push(options);
      return connection;
    },
  });
  const controller = new AbortController();
  const explicitHeaders = { 'x-g3-fixture': 'offline-only' };
  const adapter = createDoubaoStreamingAsrAdapter({ transportFactory });
  const session = await adapter.open({
    identity: identity(9, 'adapter-attempt'),
    requestId: 'g3-adapter-request-001',
    headers: explicitHeaders,
    signal: controller.signal,
    onDecodedPayload: () => undefined,
  });

  await session.send(audioChunk(100, 0, false));
  await session.end();
  await session.cancel('fixture_cleanup');

  assert.equal(opened.length, 1);
  assert.equal(opened[0].requestId, 'g3-adapter-request-001');
  assert.equal(opened[0].signal, controller.signal);
  assert.deepEqual(opened[0].headers, explicitHeaders);
  assert.equal(sent.length, 1);
  assert.equal(ended, 1);
  assert.equal(cancelled, 1);
});

test('an Evidence callback failure leaves the final replayable with one stable evidenceId', () => {
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 10, 'evidence-retry-attempt');
  const context = {
    identity: active,
    attemptId: 'evidence-retry-attempt',
    connectionId: 'evidence-retry-connection',
  };
  const callbackEvidenceIds: string[] = [];
  let memoryCandidateCalls = 0;
  let failFirstDelivery = true;
  const reducer = new AsrStreamReducer({
    cancellationRegistry: registry,
    onEvidence: (item: Record<string, unknown>) => {
      assert.equal(typeof item.evidenceId, 'string');
      callbackEvidenceIds.push(item.evidenceId as string);
      if (failFirstDelivery) {
        failFirstDelivery = false;
        throw new Error('durable Evidence sink unavailable');
      }
    },
    onMemoryCandidate: () => { memoryCandidateCalls += 1; },
  });
  reducer.beginAttempt(context);
  const finalEvent = canonicalEvent({
    kind: 'segment_final',
    providerSequence: 1,
    segmentIndex: 0,
    revision: 1,
    text: '同一条最终转写。',
  }, context);
  let firstResult: ReturnType<AsrStreamReducer['accept']> | undefined;
  let firstError: unknown;

  try {
    firstResult = reducer.accept(finalEvent);
  } catch (error) {
    firstError = error;
  }

  assert.ok(firstError !== undefined || firstResult?.accepted === false);
  assert.equal(reducer.snapshot().emittedSegmentCount, 0);
  assert.deepEqual(reducer.snapshot().pendingSegmentIndexes, [0]);
  const retry = reducer.accept(finalEvent);
  assert.equal(retry.accepted, true);
  assert.equal(reducer.snapshot().emittedSegmentCount, 1);
  assert.deepEqual(reducer.snapshot().pendingSegmentIndexes, []);
  assert.equal(callbackEvidenceIds.length, 2);
  assert.equal(callbackEvidenceIds[0], callbackEvidenceIds[1]);
  assert.equal(memoryCandidateCalls, 0);
});

test('stream_final fails as incomplete_stream while a non-empty partial remains uncommitted', () => {
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 11, 'incomplete-stream-attempt');
  const context = {
    identity: active,
    attemptId: 'incomplete-stream-attempt',
    connectionId: 'incomplete-stream-connection',
  };
  let memoryCandidateCalls = 0;
  const reducer = new AsrStreamReducer({
    cancellationRegistry: registry,
    onMemoryCandidate: () => { memoryCandidateCalls += 1; },
  });
  reducer.beginAttempt(context);
  const partial = reducer.accept(canonicalEvent({
    kind: 'partial',
    providerSequence: 1,
    segmentIndex: 0,
    revision: 1,
    text: '这段非空文字还没有 final。',
  }, context));
  assert.equal(partial.accepted, true);

  const streamFinal = reducer.accept(canonicalEvent({
    kind: 'stream_final',
    providerSequence: 2,
  }, context));
  assert.equal(streamFinal.accepted, false);
  assert.equal(
    (streamFinal as { errorCode?: string }).errorCode,
    'incomplete_stream',
  );
  assert.equal(reducer.snapshot().streamFinal, false);
  assert.equal(reducer.snapshot().emittedSegmentCount, 0);
  assert.equal(memoryCandidateCalls, 0);
});

test('abort during pending send rejects with AbortError, cancels transport and never reports success', async () => {
  const sendGate = deferred<void>();
  let cancelCalls = 0;
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open() {
        return {
          async send() { await sendGate.promise; },
          async end() {},
          async cancel() { cancelCalls += 1; },
        };
      },
    }),
  });
  const controller = new AbortController();
  const session = await adapter.open({
    identity: identity(12, 'abort-pending-send'),
    requestId: 'abort-pending-send-request',
    headers: {},
    signal: controller.signal,
    onDecodedPayload: () => undefined,
  });
  const pendingSend = session.send(audioChunk(100, 0, false));

  controller.abort('cancel_pending_send');
  sendGate.resolve();
  await assert.rejects(pendingSend, isAbortError);
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
  await assert.rejects(session.send(audioChunk(100, 1, false)), isAbortError);
});

test('abort during pending end rejects with AbortError and still cancels transport', async () => {
  const endGate = deferred<void>();
  let cancelCalls = 0;
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open() {
        return {
          async send() {},
          async end() { await endGate.promise; },
          async cancel() { cancelCalls += 1; },
        };
      },
    }),
  });
  const controller = new AbortController();
  const session = await adapter.open({
    identity: identity(13, 'abort-pending-end'),
    requestId: 'abort-pending-end-request',
    headers: {},
    signal: controller.signal,
    onDecodedPayload: () => undefined,
  });
  const pendingEnd = session.end();

  controller.abort('cancel_pending_end');
  endGate.resolve();
  await assert.rejects(pendingEnd, isAbortError);
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
});

test('a transport end failure does not permanently commit the session end state', async () => {
  let endCalls = 0;
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open() {
        return {
          async send() {},
          async end() {
            endCalls += 1;
            if (endCalls === 1) throw new Error('first end failed');
          },
          async cancel() {},
        };
      },
    }),
  });
  const session = await adapter.open({
    identity: identity(14, 'retry-end-after-failure'),
    requestId: 'retry-end-after-failure-request',
    headers: {},
    signal: new AbortController().signal,
    onDecodedPayload: () => undefined,
  });

  await assert.rejects(session.end(), /first end failed/);
  await session.end();
  assert.equal(endCalls, 2);
});

test('transport open errors are normalized without exposing private header values', async () => {
  const token = 'Bearer G3-PRIVATE-OPEN-TOKEN';
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open(options) {
        throw new Error(`open failed with ${options.headers.Authorization}`);
      },
    }),
  });
  const message = await rejectionMessage(() => adapter.open({
    identity: identity(15, 'redact-open-error'),
    requestId: 'redact-open-error-request',
    headers: { Authorization: token },
    signal: new AbortController().signal,
    onDecodedPayload: () => undefined,
  }));

  assert.equal(message.includes(token), false);
});

test('transport send errors are normalized without exposing private header values', async () => {
  const token = 'Bearer G3-PRIVATE-SEND-TOKEN';
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open(options) {
        return {
          async send() { throw new Error(`send failed with ${options.headers.Authorization}`); },
          async end() {},
          async cancel() {},
        };
      },
    }),
  });
  const session = await adapter.open({
    identity: identity(16, 'redact-send-error'),
    requestId: 'redact-send-error-request',
    headers: { Authorization: token },
    signal: new AbortController().signal,
    onDecodedPayload: () => undefined,
  });
  const message = await rejectionMessage(() => session.send(audioChunk(100, 0, false)));

  assert.equal(message.includes(token), false);
  await session.cancel('redaction_test_cleanup');
});

test('transport end errors are normalized without exposing private header values', async () => {
  const token = 'Bearer G3-PRIVATE-END-TOKEN';
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open(options) {
        return {
          async send() {},
          async end() { throw new Error(`end failed with ${options.headers.Authorization}`); },
          async cancel() {},
        };
      },
    }),
  });
  const session = await adapter.open({
    identity: identity(17, 'redact-end-error'),
    requestId: 'redact-end-error-request',
    headers: { Authorization: token },
    signal: new AbortController().signal,
    onDecodedPayload: () => undefined,
  });
  const message = await rejectionMessage(() => session.end());

  assert.equal(message.includes(token), false);
  await session.cancel('redaction_test_cleanup');
});

test('concurrent sends remain ordered, reverse resolution cannot commit sequence one first, and abort rejects the queue', async () => {
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const transportStarts: number[] = [];
  const adapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open() {
        return {
          async send(value) {
            transportStarts.push(value.sequence);
            await (value.sequence === 0 ? firstGate.promise : secondGate.promise);
          },
          async end() {},
          async cancel() {},
        };
      },
    }),
  });
  const session = await adapter.open({
    identity: identity(18, 'concurrent-send-order'),
    requestId: 'concurrent-send-order-request',
    headers: {},
    signal: new AbortController().signal,
    onDecodedPayload: () => undefined,
  });
  let firstSettled = false;
  let secondSettled = false;
  const firstSend = session.send(audioChunk(100, 0, false)).finally(() => {
    firstSettled = true;
  });
  const secondSend = session.send(audioChunk(100, 1, false)).finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  const startsBeforeFirstConfirmation = [...transportStarts];

  // Resolve sequence one first. A correct adapter has not exposed it to the
  // transport yet, so this cannot settle or commit it ahead of sequence zero.
  secondGate.resolve();
  await Promise.resolve();
  const secondSettledBeforeFirst = secondSettled;
  firstGate.resolve();
  const orderedResults = await Promise.allSettled([firstSend, secondSend]);

  assert.deepEqual(startsBeforeFirstConfirmation, [0]);
  assert.equal(secondSettledBeforeFirst, false);
  assert.deepEqual(transportStarts, [0, 1]);
  assert.deepEqual(orderedResults.map(item => item.status), ['fulfilled', 'fulfilled']);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);

  const abortFirstGate = deferred<void>();
  const abortSecondGate = deferred<void>();
  const abortTransportStarts: number[] = [];
  let abortCancelCalls = 0;
  const abortAdapter = createDoubaoStreamingAsrAdapter({
    transportFactory: () => ({
      async open() {
        return {
          async send(value) {
            abortTransportStarts.push(value.sequence);
            await (value.sequence === 0
              ? abortFirstGate.promise
              : abortSecondGate.promise);
          },
          async end() {},
          async cancel() { abortCancelCalls += 1; },
        };
      },
    }),
  });
  const abortController = new AbortController();
  const abortSession = await abortAdapter.open({
    identity: identity(19, 'concurrent-send-abort'),
    requestId: 'concurrent-send-abort-request',
    headers: {},
    signal: abortController.signal,
    onDecodedPayload: () => undefined,
  });
  const abortedFirst = abortSession.send(audioChunk(100, 0, false));
  const abortedSecond = abortSession.send(audioChunk(100, 1, false));
  await Promise.resolve();
  abortController.abort('abort_send_queue');
  abortSecondGate.resolve();
  abortFirstGate.resolve();
  const abortedResults = await Promise.allSettled([abortedFirst, abortedSecond]);
  await Promise.resolve();

  assert.deepEqual(abortTransportStarts, [0]);
  assert.ok(abortedResults.every(item => (
    item.status === 'rejected' && isAbortError(item.reason)
  )));
  assert.equal(abortCancelCalls, 1);
});

test('providerPacketFingerprint binds one payload sequence to one legal multi-event batch', () => {
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 20, 'packet-fingerprint-attempt');
  const state = makeReducer(registry);
  const reducerContext = {
    identity: active,
    attemptId: 'packet-fingerprint-attempt',
    connectionId: 'packet-fingerprint-connection',
  };
  const translationContext = {
    ...reducerContext,
    receivedAt: RECEIVED_AT,
  };
  state.reducer.beginAttempt(reducerContext);
  const firstPayload = {
    payload_sequence: 77,
    result: {
      utterances: [
        { id: 'segment-0', index: 0, definite: true, text: '第一段。' },
        { id: 'segment-1', index: 1, definite: true, text: '第二段。' },
      ],
    },
  };
  const firstBatch = translateDoubaoDecodedPayload(firstPayload, translationContext);
  const samePayloadAgain = translateDoubaoDecodedPayload(
    structuredClone(firstPayload),
    translationContext,
  );
  const secondBatch = translateDoubaoDecodedPayload({
    payload_sequence: 77,
    result: {
      utterances: [
        { id: 'segment-2', index: 2, definite: true, text: '伪造的新第三段。' },
      ],
    },
  }, translationContext);
  const fingerprintOf = (event: unknown): unknown => (
    event as { providerPacketFingerprint?: unknown }
  ).providerPacketFingerprint;
  const firstFingerprint = fingerprintOf(firstBatch[0]);
  const secondFingerprint = fingerprintOf(secondBatch[0]);

  assert.equal(typeof firstFingerprint, 'string');
  assert.ok((firstFingerprint as string).length > 0);
  assert.ok(firstBatch.every(event => fingerprintOf(event) === firstFingerprint));
  assert.ok(samePayloadAgain.every(event => fingerprintOf(event) === firstFingerprint));
  assert.equal(typeof secondFingerprint, 'string');
  assert.notEqual(secondFingerprint, firstFingerprint);
  for (const event of firstBatch) {
    assert.equal(state.reducer.accept(event).accepted, true);
  }
  const reusedSequence = state.reducer.accept(secondBatch[0]);
  assert.equal(reusedSequence.accepted, false);
  assert.equal(reusedSequence.errorCode, 'invalid_schema');
  assert.equal(reusedSequence.fatal, true);
  assert.deepEqual(state.evidence.map(item => item.text), ['第一段。', '第二段。']);
  assert.equal(state.memoryCandidates.length, 0);
});
