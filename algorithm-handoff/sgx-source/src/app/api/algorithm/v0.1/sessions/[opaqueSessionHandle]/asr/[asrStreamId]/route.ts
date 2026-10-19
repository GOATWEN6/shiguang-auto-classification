import { NextResponse } from 'next/server';
import { z } from 'zod';
import { internalAlgorithmRuntime as runtime, sessionRequestError, jsonBody } from '../../../../_shared/runtime.ts';

export const dynamic = 'force-dynamic';
const schema = z.object({ schemaVersion: z.literal('algorithm-asr-chunk-v0.1'),
  sequence: z.number().int().nonnegative(), endOfStream: z.boolean(),
  base64Audio: z.string().min(4).max(8600).regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict();

export async function POST(request: Request, context: { params: { opaqueSessionHandle: string; asrStreamId: string } }) {
  const blocked = sessionRequestError(request, context.params.opaqueSessionHandle);
  if (blocked) return blocked;
  const state = runtime.asrStreams.get(context.params.asrStreamId);
  if (!state || state.handle !== context.params.opaqueSessionHandle || state.controller.signal.aborted) {
    return NextResponse.json({ code: 'asr_stream_expired' }, { status: 410 });
  }
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_schema' }, { status: 400 });
  if (state.eos || parsed.data.sequence !== state.nextSequence) {
    return NextResponse.json({ code: 'asr_sequence_conflict' }, { status: 409 });
  }
  const pcm = new Uint8Array(Buffer.from(parsed.data.base64Audio, 'base64'));
  // Validate before changing sequencing, so invalid inputs never poison a live connection.
  const duration = pcm.byteLength / 32;
  if (pcm.byteLength % 2 || duration <= 0 || duration > 200 || (!parsed.data.endOfStream && duration < 100)) {
    return NextResponse.json({ code: 'invalid_pcm_chunk' }, { status: 400 });
  }
  state.nextSequence += 1;
  state.eos = parsed.data.endOfStream;
  try {
    await state.session.send({ sequence: parsed.data.sequence, audio: pcm,
      format: { codec: 'pcm16', sampleRateHz: 16_000, bitsPerSample: 16, channels: 1 },
      endOfStream: parsed.data.endOfStream });
    state.pcm.push(pcm);
    return NextResponse.json({ accepted: true, sequence: parsed.data.sequence,
      transcript: { text: state.partial, final: false } });
  } catch {
    state.controller.abort('asr_send_failed');
    runtime.asrStreams.delete(context.params.asrStreamId);
    if (runtime.pendingAudio.get(state.handle)?.controller === state.controller) runtime.pendingAudio.delete(state.handle);
    return NextResponse.json({ code: 'asr_send_failed', retryable: true }, { status: 502 });
  }
}
