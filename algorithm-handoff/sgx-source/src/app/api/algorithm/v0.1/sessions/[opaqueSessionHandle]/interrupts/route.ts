import { NextResponse } from 'next/server';

import {
  algorithmHttpService, internalAlgorithmRuntime, sessionRequestError, internalServerError, jsonBody, requestId,
} from '../../../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: { opaqueSessionHandle: string } },
): Promise<NextResponse> {
  try {
    const blocked = sessionRequestError(request, context.params.opaqueSessionHandle);
    if (blocked) return blocked;
    const body = await jsonBody(request);
    const pending = internalAlgorithmRuntime.pendingAudio.get(context.params.opaqueSessionHandle);
    const command = body as { schemaVersion?: string; interruptTargetHandle?: string; idempotencyKey?: string; reason?: string } | null;
    if (pending && command?.schemaVersion === 'algorithm-interrupt-v0.1'
      && command.interruptTargetHandle === pending.target
      && typeof command.idempotencyKey === 'string' && typeof command.reason === 'string') {
      pending.controller.abort('user_interrupt');
      return NextResponse.json({ schemaVersion: 'algorithm-audio-interrupt-v0.2',
        accepted: true, targetHandle: pending.target, stage: 'ASR' }, { status: 202 });
    }
    const result = algorithmHttpService.interrupt({
      requestId: requestId(request),
      opaqueSessionHandle: context.params.opaqueSessionHandle,
      body,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return internalServerError(request);
  }
}
