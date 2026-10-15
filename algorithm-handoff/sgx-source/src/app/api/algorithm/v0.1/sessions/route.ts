import { NextResponse } from 'next/server';

import {
  algorithmHttpService,
  jsonBody,
  requestId,
  trustedFakeAuthority,
  internalRequestError, internalServerError,
  subjectBindingFor,
} from '../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const blocked = internalRequestError(request);
    if (blocked) return blocked;
    const body = await jsonBody(request);
    const idempotencyKey = (body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    const binding = (body as { subjectBinding?: unknown } | null)?.subjectBinding;
    if (binding !== undefined && typeof binding !== 'string') return NextResponse.json({ code: 'invalid_schema' }, { status: 400 });
    let authority;
    try { authority = trustedFakeAuthority(typeof idempotencyKey === 'string' ? idempotencyKey : undefined, binding as string | undefined); }
    catch { return NextResponse.json({ code: 'subject_binding_invalid' }, { status: 403 }); }
    const contractBody = body && typeof body === 'object' ? { ...body } : body;
    if (contractBody && typeof contractBody === 'object') delete (contractBody as Record<string, unknown>).subjectBinding;
    const result = algorithmHttpService.createSession({
      requestId: requestId(request),
      authority,
      body: contractBody,
    });
    return NextResponse.json({ ...result.body as object,
      ...(result.status < 300 ? { subjectBinding: subjectBindingFor(authority) } : {}) }, { status: result.status });
  } catch {
    return internalServerError(request);
  }
}
