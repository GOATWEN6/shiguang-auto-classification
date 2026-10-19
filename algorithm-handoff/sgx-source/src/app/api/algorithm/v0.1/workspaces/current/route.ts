import { NextResponse } from 'next/server';

import {
  internalAlgorithmRuntime as runtime,
  internalRequestError,
  jsonBody,
  requestWorkspace,
  workspaceRequestError,
} from '../../_shared/runtime.ts';
import {
  clearWorkspaceCookie,
  workspaceAuthority,
  workspaceJsonError,
  workspaceNoStoreHeaders,
  workspaceTokenFromRequest,
} from '../../_shared/workspace.ts';

export const dynamic = 'force-dynamic';

function requiredToken(request: Request): string | NextResponse {
  return workspaceTokenFromRequest(request)
    ?? workspaceJsonError(401, 'workspace_required', '需要先建立此设备的测试工作区。');
}

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  try {
    const workspace = requestWorkspace(request);
    if (!workspace) return workspaceJsonError(401, 'workspace_required', '需要先建立此设备的测试工作区。');
    return NextResponse.json({ workspace }, { headers: workspaceNoStoreHeaders });
  } catch (error) { return workspaceRequestError(error); }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  const token = requiredToken(request);
  if (token instanceof NextResponse) return token;
  const body = await jsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'expectedRevision,schemaVersion,ui'
    || (body as { schemaVersion?: unknown }).schemaVersion !== 'test-workspace-ui-update-v0.1'
    || !Number.isSafeInteger((body as { expectedRevision?: unknown }).expectedRevision)) {
    return workspaceJsonError(400, 'invalid_schema', '请求格式不符合工作区更新合同。');
  }
  try {
    const workspace = runtime.workspaceStore.saveUi(
      token,
      (body as { expectedRevision: number }).expectedRevision,
      (body as { ui?: unknown }).ui,
    );
    return NextResponse.json({ workspace }, { headers: workspaceNoStoreHeaders });
  } catch (error) { return workspaceRequestError(error); }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  const token = requiredToken(request);
  if (token instanceof NextResponse) return token;
  try {
    const workspace = runtime.workspaceStore.require(token);
    const authority = workspaceAuthority(workspace);
    const algorithmContentDeletion = runtime.composition
      ? await runtime.composition.deleteAuthorityContent(authority)
      : { evidenceCount: 0, withdrawnRecordCount: 0, invalidatedArtifactCount: 0 };
    const audit = runtime.workspaceStore.deleteWorkspace(token);
    const response = NextResponse.json({ deleted: true, audit, algorithmContentDeletion },
      { headers: workspaceNoStoreHeaders });
    clearWorkspaceCookie(response, request);
    return response;
  } catch (error) { return workspaceRequestError(error); }
}
