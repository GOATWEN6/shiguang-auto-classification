import { NextResponse } from 'next/server';

import { TestWorkspaceStoreError } from '../../../../../../lib/algorithm-service/test-workspace-store.ts';
import {
  internalAlgorithmRuntime as runtime,
  internalRequestError,
  workspaceRequestError,
} from '../../_shared/runtime.ts';
import {
  setWorkspaceCookie,
  workspaceNoStoreHeaders,
  workspaceTokenFromRequest,
} from '../../_shared/workspace.ts';

export const dynamic = 'force-dynamic';

/** Establish or restore the opaque device workspace. The token is returned only as an HttpOnly cookie. */
export async function POST(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request, { allowWorkspaceBootstrap: true });
  if (blocked) return blocked;
  try {
    const token = workspaceTokenFromRequest(request);
    if (token) {
      try {
        const restored = runtime.workspaceStore.bootstrap(token);
        return NextResponse.json({ workspace: restored.workspace, restored: true },
          { headers: workspaceNoStoreHeaders });
      } catch (error) {
        if (!(error instanceof TestWorkspaceStoreError)
          || !['TEST_WORKSPACE_INVALID_TOKEN', 'TEST_WORKSPACE_UNAUTHORIZED', 'TEST_WORKSPACE_EXPIRED']
            .includes(error.code)) return workspaceRequestError(error);
      }
    }
    const created = runtime.workspaceStore.bootstrap(undefined, { revealToken: true });
    if (!created.token) return workspaceRequestError(new Error('workspace_token_issue_failed'));
    const response = NextResponse.json({ workspace: created.workspace, restored: false },
      { status: 201, headers: workspaceNoStoreHeaders });
    setWorkspaceCookie(response, request, created.token);
    return response;
  } catch (error) {
    return workspaceRequestError(error);
  }
}
