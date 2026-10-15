import { NextResponse } from 'next/server';

import { algorithmHttpService, internalRequestError, internalServerError, jsonBody, requestId,
  withAlgorithmCostContext } from '../../../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: { opaqueSessionHandle: string } },
): Promise<NextResponse> {
  try {
    const blocked = internalRequestError(request);
    if (blocked) return blocked;
    const body = await jsonBody(request);
    const result = await withAlgorithmCostContext(request, context.params.opaqueSessionHandle, () =>
      algorithmHttpService.submitTurn({
        requestId: requestId(request),
        opaqueSessionHandle: context.params.opaqueSessionHandle,
        body,
      }));
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return internalServerError(request);
  }
}
