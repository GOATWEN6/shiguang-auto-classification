import { NextResponse } from 'next/server';

import { algorithmHttpService, internalRequestError } from '../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  const result = algorithmHttpService.version();
  return NextResponse.json(result.body, { status: result.status });
}
