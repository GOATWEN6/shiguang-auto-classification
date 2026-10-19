import { NextResponse } from 'next/server';

import type { TrustedSessionAuthority } from '../../../../../lib/turn-orchestrator/index.ts';
import {
  TEST_WORKSPACE_RETENTION_MS,
  TestWorkspaceStoreError,
  type TestWorkspaceStore,
  type TestWorkspaceView,
} from '../../../../../lib/algorithm-service/test-workspace-store.ts';

export const TEST_WORKSPACE_COOKIE = 'sgx_test_workspace';
export const TEST_WORKSPACE_COOKIE_MAX_AGE_SECONDS = Math.floor(TEST_WORKSPACE_RETENTION_MS / 1_000);
export const PUBLIC_GATEWAY_HEADER = 'x-sgx-public-gateway';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function isPublicGatewayRequest(request: Request): boolean {
  return request.headers.get(PUBLIC_GATEWAY_HEADER) === '1';
}

export function workspaceTokenFromRequest(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== TEST_WORKSPACE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

export function workspaceForRequest(request: Request, store: TestWorkspaceStore): TestWorkspaceView | null {
  const token = workspaceTokenFromRequest(request);
  return token ? store.require(token) : null;
}

export function publicWorkspaceBoundaryError(
  request: Request,
  store: TestWorkspaceStore,
  options: { allowBootstrap?: boolean } = {},
): NextResponse | null {
  if (!isPublicGatewayRequest(request) || options.allowBootstrap === true) return null;
  if (!workspaceTokenFromRequest(request)) {
    return workspaceJsonError(401, 'workspace_required', '需要先建立此设备的测试工作区。');
  }
  try {
    store.require(workspaceTokenFromRequest(request)!);
    return null;
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}

export function sessionWorkspaceError(
  request: Request,
  store: TestWorkspaceStore,
  opaqueSessionHandle: string,
): NextResponse | null {
  const token = workspaceTokenFromRequest(request);
  if (!token) {
    return isPublicGatewayRequest(request)
      ? workspaceJsonError(401, 'workspace_required', '需要先建立此设备的测试工作区。')
      : null;
  }
  try {
    store.assertSessionOwner(token, opaqueSessionHandle);
    return null;
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}

export function workspaceAuthority(workspace: TestWorkspaceView): TrustedSessionAuthority {
  return {
    schemaVersion: 'trusted-session-authority-v0.1',
    actorId: workspace.actorId,
    subjectId: workspace.subjectId,
    familySpaceId: workspace.familySpaceId,
    authorizationVersion: 'auth-test-workspace-v0.1',
    visibilityScope: ['elder_only'],
  };
}

function forwardedHttps(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true;
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https') return true;
  try {
    const visitor = JSON.parse(request.headers.get('cf-visitor') ?? '{}') as { scheme?: unknown };
    return visitor.scheme === 'https';
  } catch { return false; }
}

/** The raw token is written only to the HttpOnly device cookie, never to a JSON response. */
export function setWorkspaceCookie(response: NextResponse, request: Request, token: string): void {
  response.cookies.set({
    name: TEST_WORKSPACE_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: TEST_WORKSPACE_COOKIE_MAX_AGE_SECONDS,
    secure: isPublicGatewayRequest(request) && forwardedHttps(request),
  });
}

export function clearWorkspaceCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: TEST_WORKSPACE_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    secure: isPublicGatewayRequest(request) && forwardedHttps(request),
  });
}

export function workspaceJsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ code, message, retryable: false }, { status, headers: NO_STORE_HEADERS });
}

/** Stable external mapping: never serialize the exception message or SQLite details. */
export function workspaceErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof TestWorkspaceStoreError)) {
    return workspaceJsonError(500, 'internal_error', '测试工作区暂时不可用。');
  }
  switch (error.code) {
    case 'TEST_WORKSPACE_INVALID_TOKEN':
    case 'TEST_WORKSPACE_UNAUTHORIZED':
    case 'TEST_WORKSPACE_EXPIRED':
      return workspaceJsonError(401, 'workspace_unauthorized', '此设备的测试工作区已失效，请重新建立。');
    case 'TEST_WORKSPACE_REVISION_CONFLICT':
      return workspaceJsonError(409, 'workspace_revision_conflict', '资料已在其他页面更新，请刷新后重试。');
    case 'TEST_WORKSPACE_INVALID_UI':
      return workspaceJsonError(error.status === 413 ? 413 : 400, 'workspace_invalid_ui', '工作区资料格式或大小不符合要求。');
    case 'TEST_WORKSPACE_INVALID_SESSION':
      return workspaceJsonError(400, 'workspace_invalid_session', '会话标识格式不符合要求。');
    case 'TEST_WORKSPACE_SESSION_CONFLICT':
    case 'TEST_WORKSPACE_SESSION_FORBIDDEN':
      return workspaceJsonError(403, 'workspace_session_forbidden', '此会话不属于当前设备工作区。');
    default:
      return workspaceJsonError(500, 'internal_error', '测试工作区暂时不可用。');
  }
}

export const workspaceNoStoreHeaders = NO_STORE_HEADERS;
