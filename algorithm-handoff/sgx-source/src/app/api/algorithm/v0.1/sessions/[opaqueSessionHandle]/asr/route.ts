import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { internalAlgorithmRuntime as runtime, internalRequestError, jsonBody,
  withAlgorithmCostContext } from '../../../_shared/runtime.ts';

export const dynamic = 'force-dynamic';
const schema = z.object({ schemaVersion: z.literal('algorithm-asr-open-v0.1'),
  idempotencyKey: z.string().min(1).max(160) }).strict();

export async function POST(request: Request, context: { params: { opaqueSessionHandle: string } }) {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  if (!runtime.real || runtime.service.health().status !== 200) {
    return NextResponse.json({ code: 'real_asr_not_ready' }, { status: 503 });
  }
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_schema' }, { status: 400 });
  const handle = context.params.opaqueSessionHandle;
  try {
    if (runtime.orchestrator.getSessionSnapshot(handle).status !== 'ACTIVE') {
      return NextResponse.json({ code: 'session_not_active' }, { status: 409 });
    }
  } catch { return NextResponse.json({ code: 'session_not_found' }, { status: 404 }); }
  const key = `${handle}:${parsed.data.idempotencyKey}`;
  const previousId = runtime.asrStartKeys.get(key);
  if (previousId) {
    const previous = runtime.asrStreams.get(previousId);
    return previous && !previous.controller.signal.aborted
      ? NextResponse.json({ asrStreamId: previousId, targetHandle: previous.target, replayed: true })
      : NextResponse.json({ code: 'asr_stream_expired' }, { status: 410 });
  }
  if (runtime.pendingAudio.has(handle) || runtime.orchestrator.getCurrentTarget(handle)) {
    return NextResponse.json({ code: 'turn_in_progress' }, { status: 409 });
  }
  const id = `asr_stream_${randomUUID()}`;
  runtime.asrStartKeys.set(key, id);
  const controller = new AbortController();
  const target = `asr_target_${randomUUID()}`;
  const requestId = randomUUID();
  let partial = '';
  runtime.pendingAudio.set(handle, { target, controller });
  controller.signal.addEventListener('abort', () => {
    const current = runtime.asrStreams.get(id);
    if (current?.controller === controller) {
      current.pcm.length = 0; runtime.asrStreams.delete(id);
    }
    if (runtime.pendingAudio.get(handle)?.controller === controller) runtime.pendingAudio.delete(handle);
  }, { once: true });
  try {
    const session = await withAlgorithmCostContext(request, handle, () => runtime.openStreamingAsr(requestId, controller.signal, text => {
        partial = text;
        const state = runtime.asrStreams.get(id);
        if (state && !controller.signal.aborted) state.partial = text;
      }));
    runtime.asrStreams.set(id, { handle, target, requestId, controller, session,
      partial, pcm: [], createdAt: Date.now(), nextSequence: 0, eos: false });
    const expiry = setTimeout(() => {
      controller.abort('asr_stream_expired');
      runtime.asrStreams.delete(id);
      if (runtime.pendingAudio.get(handle)?.controller === controller) runtime.pendingAudio.delete(handle);
    }, 75_000);
    expiry.unref();
    return NextResponse.json({ asrStreamId: id, targetHandle: target, sampleRate: 16_000,
      chunkDurationMs: { minimum: 100, maximum: 200 }, expiresInMs: 75_000 }, { status: 201 });
  } catch {
    controller.abort('asr_open_failed');
    if (runtime.pendingAudio.get(handle)?.controller === controller) runtime.pendingAudio.delete(handle);
    return NextResponse.json({ code: 'asr_open_failed', retryable: true }, { status: 502 });
  }
}
