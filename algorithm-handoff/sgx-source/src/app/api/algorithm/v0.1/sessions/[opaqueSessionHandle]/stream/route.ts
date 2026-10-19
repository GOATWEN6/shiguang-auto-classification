import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  internalAlgorithmRuntime as runtime, sessionRequestError, internalServerError, jsonBody, requestId, retainTurnResult,
  withAlgorithmCostContext,
} from '../../../_shared/runtime.ts';
import type { AlgorithmOutputEvent } from '../../../../../../../lib/algorithm-service/index.ts';
import type { TurnRunResult } from '../../../../../../../lib/turn-orchestrator/index.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const common = { schemaVersion: z.literal('algorithm-stream-turn-v0.2'),
  idempotencyKey: z.string().min(1).max(160),
  uiEvent: z.object({ type: z.literal('MEMORY_TOPIC_CLICK'), ref: z.string().min(1) }).strict().optional() };
const schema = z.discriminatedUnion('source', [
  z.object({ ...common, source: z.literal('TYPED_TEXT'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ ...common, source: z.literal('PCM16'), base64Audio: z.string().min(4).max(2_560_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict(),
  z.object({ ...common, source: z.literal('ASR_STREAM'), asrStreamId: z.string().min(1).max(100) }).strict(),
]);

async function postStream(request: Request, context: { params: { opaqueSessionHandle: string } }) {
  if (runtime.service.health().status !== 200) return NextResponse.json({ code: 'service_not_ready',
    message: '模型配置或真实调用预算尚未就绪。', retryable: false }, { status: 503 });
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_schema' }, { status: 400 });
  const input = parsed.data;
  const handle = context.params.opaqueSessionHandle;
  try { runtime.orchestrator.getSessionSnapshot(handle); }
  catch { return NextResponse.json({ code: 'session_not_found' }, { status: 404 }); }
  const key = `${handle}:${input.idempotencyKey}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior = runtime.streamOperations.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return NextResponse.json({ code: 'idempotency_conflict' }, { status: 409 });
    const result = await prior.result;
    const sanitized = result && typeof result === 'object' && 'evidenceId' in result
      ? runtime.orchestrator.sanitizeReplayResult(result as TurnRunResult) : result;
    if (sanitized !== result) prior.result = Promise.resolve(sanitized);
    return NextResponse.json({ replayed: true, result: sanitized });
  }
  const asrState = input.source === 'ASR_STREAM' ? runtime.asrStreams.get(input.asrStreamId) : undefined;
  if (input.source === 'ASR_STREAM' && (!asrState || asrState.handle !== handle
    || asrState.controller.signal.aborted || !asrState.eos)) {
    return NextResponse.json({ code: 'asr_stream_not_finalizable' }, { status: 409 });
  }
  if ((runtime.pendingAudio.has(handle) && !asrState) || runtime.orchestrator.getCurrentTarget(handle)) {
    return NextResponse.json({ code: 'turn_in_progress', retryable: true }, { status: 409 });
  }
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let settle!: (value: unknown) => void;
  const resultPromise = new Promise<unknown>(resolve => { settle = resolve; });
  runtime.streamOperations.set(key, { fingerprint, result: resultPromise });
  let finished = false;
  let ownedTarget: string | null = null;
  const cancel = () => {
    if (finished) return;
    controller.abort('client_disconnected');
    asrState?.controller.abort('client_disconnected');
    const pendingAudio = runtime.pendingAudio.get(handle);
    if (pendingAudio?.controller === controller) pendingAudio.controller.abort('client_disconnected');
    if (ownedTarget) runtime.orchestrator.interrupt(handle, { schemaVersion: 'orchestrated-interrupt-v0.1',
      idempotencyToken: `disconnect:${input.idempotencyKey}`, targetHandle: ownedTarget, reason: 'explicit_cancel' });
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed || controller.signal.aborted) return;
        try { sink.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { closed = true; cancel(); }
      };
      const listener = (event: AlgorithmOutputEvent) => {
        if (event.type === 'phase') {
          ownedTarget = event.targetHandle;
          if (controller.signal.aborted && !finished) {
            runtime.orchestrator.interrupt(handle, { schemaVersion: 'orchestrated-interrupt-v0.1',
              idempotencyToken: `disconnect:${input.idempotencyKey}`, targetHandle: ownedTarget, reason: 'explicit_cancel' });
          }
        }
        send(event);
      };
      const listeners = runtime.listeners.get(handle) ?? new Set();
      listeners.add(listener);
      runtime.listeners.set(handle, listeners);
      void (async () => {
        let finalResult: unknown = { status: 'error', errorCode: 'stream_failed' };
        let rawAudio: Uint8Array | undefined;
        try {
          if (request.signal.aborted) cancel();
          if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const receivedAt = new Date().toISOString();
          if (input.source === 'PCM16' || input.source === 'ASR_STREAM') {
            if (!runtime.provider) throw new Error('real_asr_unavailable');
            const target = asrState?.target ?? `asr_target_${randomUUID()}`;
            if (!asrState) runtime.pendingAudio.set(handle, { target, controller });
            send({ type: 'ready', targetHandle: target, phase: 'ASR' });
            const asrRequestId = asrState?.requestId ?? randomUUID();
            rawAudio = input.source === 'PCM16' ? new Uint8Array(Buffer.from(input.base64Audio, 'base64'))
              : new Uint8Array(Buffer.concat(asrState!.pcm));
            const transcript = asrState ? await asrState.session.finish()
              : await runtime.provider.transcribe(rawAudio, { requestId: asrRequestId, signal: controller.signal,
                onPartial: text => send({ type: 'transcript', text, final: false }) });
            runtime.pendingAudio.delete(handle);
            if (controller.signal.aborted || asrState?.controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
            send({ type: 'transcript', text: transcript.text, final: true });
            finalResult = await runtime.orchestrator.runFinalTurn(handle, {
              schemaVersion: 'orchestrated-turn-v0.1', idempotencyToken: input.idempotencyKey,
              source: 'SERVER_ASR_FINAL', text: transcript.text, asrRequestId, receivedAt,
              ...(input.uiEvent ? { uiAction: { type: 'MEMORY_TOPIC_CLICK', eventRef: input.uiEvent.ref,
                targetMode: 'FORMAL_INTERVIEW' } as const } : {}),
            });
          } else {
            const result = await runtime.service.submitTurn({ requestId: requestId(request),
              opaqueSessionHandle: handle, body: { schemaVersion: 'algorithm-turn-v0.1',
                idempotencyKey: input.idempotencyKey, event: 'FINAL', source: 'TYPED_TEXT', text: input.text,
                receivedAt, ...(input.uiEvent ? { uiEvent: input.uiEvent } : {}) } });
            finalResult = result.body;
          }
          retainTurnResult(finalResult, rawAudio);
          send({ type: 'result', result: finalResult });
        } catch {
          finalResult = { status: controller.signal.aborted ? 'interrupted' : 'error',
            errorCode: controller.signal.aborted ? 'cancelled' : 'asr_or_stream_failed' };
          if (!closed) {
            try { sink.enqueue(encoder.encode(`${JSON.stringify({ type: 'result', result: finalResult })}\n`)); }
            catch { /* Disconnected client has no delivery sink. */ }
          }
        } finally {
          finished = true;
          const sanitized = finalResult && typeof finalResult === 'object' && 'evidenceId' in finalResult
            ? runtime.orchestrator.sanitizeReplayResult(finalResult as TurnRunResult) : finalResult;
          const operation = runtime.streamOperations.get(key);
          if (operation) operation.completedResult = sanitized;
          settle(sanitized);
          listeners.delete(listener);
          if (!listeners.size) runtime.listeners.delete(handle);
          if (runtime.pendingAudio.get(handle)?.controller === controller
            || asrState && runtime.pendingAudio.get(handle)?.controller === asrState.controller) runtime.pendingAudio.delete(handle);
          if (input.source === 'ASR_STREAM') {
            runtime.asrStreams.delete(input.asrStreamId);
            if (asrState) asrState.pcm.length = 0;
          }
          request.signal.removeEventListener('abort', cancel);
          if (!closed) { closed = true; try { sink.close(); } catch { /* Already closed. */ } }
        }
      })();
    },
    cancel,
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * Keep failures that happen before the NDJSON stream is constructed inside the
 * algorithm contract. Without this boundary Next.js emits a generic HTML 500,
 * which loses the request identity and makes a paid baseline impossible to
 * diagnose. The response deliberately contains no exception text or input.
 */
export async function POST(request: Request, context: { params: { opaqueSessionHandle: string } }) {
  try {
    // Keep request-shape/host validation inside the same boundary as stream
    // construction. A malformed or partially mocked Request must not escape
    // to Next.js's generic HTML 500 page either.
    const blocked = sessionRequestError(request, context.params.opaqueSessionHandle);
    if (blocked) return blocked;
    return await withAlgorithmCostContext(request, context.params.opaqueSessionHandle,
      () => postStream(request, context));
  } catch {
    return internalServerError(request);
  }
}
