import { NextResponse } from 'next/server';

import {
  algorithmHttpService,
  jsonBody,
  requestId,
  trustedFakeAuthority,
  internalRequestError, internalServerError,
  subjectBindingFor,
  internalAlgorithmRuntime, requestWorkspace, workspaceRequestError,
} from '../_shared/runtime.ts';
import { workspaceAuthority, workspaceTokenFromRequest } from '../_shared/workspace.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const blocked = internalRequestError(request);
    if (blocked) return blocked;
    const body = await jsonBody(request);
    const idempotencyKey = (body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    const binding = (body as { subjectBinding?: unknown } | null)?.subjectBinding;
    let workspace;
    try { workspace = requestWorkspace(request); }
    catch (error) { return workspaceRequestError(error); }
    if (!workspace && binding !== undefined && typeof binding !== 'string') {
      return NextResponse.json({ code: 'invalid_schema' }, { status: 400 });
    }
    let authority;
    try {
      authority = workspace
        ? workspaceAuthority(workspace)
        : trustedFakeAuthority(typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
          binding as string | undefined);
    }
    catch { return NextResponse.json({ code: 'subject_binding_invalid' }, { status: 403 }); }
    const contractBody = body && typeof body === 'object' ? { ...body } : body;
    if (contractBody && typeof contractBody === 'object') delete (contractBody as Record<string, unknown>).subjectBinding;
    const result = algorithmHttpService.createSession({
      requestId: requestId(request),
      authority,
      body: contractBody,
    });
    let workspaceRevision: number | undefined;
    if (workspace && result.status < 300) {
      const handle = (result.body as { opaqueSessionHandle?: unknown }).opaqueSessionHandle;
      if (typeof handle !== 'string') return internalServerError(request);
      try {
        workspaceRevision = internalAlgorithmRuntime.workspaceStore
          .bindSession(workspaceTokenFromRequest(request)!, handle).revision;
      }
      catch (error) { return workspaceRequestError(error); }
    }
    return NextResponse.json({ ...result.body as object,
      // Device workspaces already carry their authority in an HttpOnly cookie.
      // Do not expose the legacy subject capability to public/browser clients.
      ...(result.status < 300 && !workspace ? { subjectBinding: subjectBindingFor(authority) } : {}),
      ...(workspaceRevision === undefined ? {} : { workspaceRevision }),
    }, { status: result.status });
  } catch {
    return internalServerError(request);
  }
}
