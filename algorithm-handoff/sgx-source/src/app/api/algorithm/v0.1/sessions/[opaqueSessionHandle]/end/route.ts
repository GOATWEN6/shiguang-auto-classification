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
    internalAlgorithmRuntime.pendingAudio.get(context.params.opaqueSessionHandle)?.controller.abort('session_end');
    const result = algorithmHttpService.end({
      requestId: requestId(request),
      opaqueSessionHandle: context.params.opaqueSessionHandle,
      body: await jsonBody(request),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return internalServerError(request);
  }
}
