import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TestWorkspaceStore } from '../../../src/lib/algorithm-service/test-workspace-store.ts';
import {
  publicWorkspaceBoundaryError,
  sessionWorkspaceError,
  workspaceErrorResponse,
  workspaceForRequest,
} from '../../../src/app/api/algorithm/v0.1/_shared/workspace.ts';

const directory = mkdtempSync(join(tmpdir(), 'sgx-workspace-api-'));
const store = new TestWorkspaceStore({ databasePath: join(directory, 'workspace.sqlite') });
const runtimeUrl = pathToFileURL(resolve(
  process.cwd(),
  'src/app/api/algorithm/v0.1/_shared/runtime.ts',
)).href;
let createdAuthority: Record<string, unknown> | null = null;
let createdBody: unknown = null;
let filteredHandles: readonly string[] | undefined;
let deletedAuthority: Record<string, unknown> | null = null;

function internalRequestError(request: Request, options: { allowWorkspaceBootstrap?: boolean } = {}) {
  return publicWorkspaceBoundaryError(request, store,
    { allowBootstrap: options.allowWorkspaceBootstrap === true });
}

mock.module(runtimeUrl, {
  namedExports: {
    internalAlgorithmRuntime: {
      workspaceStore: store,
      budget: () => ({ batchCapCny: 800, reservedCny: 12.5, actualCostCny: null }),
      composition: {
        deleteAuthorityContent: async (authority: Record<string, unknown>) => {
          deletedAuthority = authority;
          return { evidenceCount: 1, withdrawnRecordCount: 1, invalidatedArtifactCount: 0 };
        },
      },
    },
    internalRequestError,
    requestWorkspace: (request: Request) => workspaceForRequest(request, store),
    workspaceRequestError: workspaceErrorResponse,
    jsonBody: async (request: Request) => {
      try { return await request.json(); } catch { return null; }
    },
    requestId: () => 'request_workspace_test',
    internalServerError: () => Response.json({ code: 'internal_error' }, { status: 500 }),
    trustedFakeAuthority: () => ({
      schemaVersion: 'trusted-session-authority-v0.1', actorId: 'legacy-actor',
      subjectId: 'legacy-subject', familySpaceId: 'legacy-family',
      authorizationVersion: 'legacy-auth', visibilityScope: ['elder_only'],
    }),
    subjectBindingFor: () => 'compatibility-binding',
    algorithmHttpService: {
      version: () => ({ status: 200, body: { schemaVersion: 'algorithm-version-v0.1', buildId: 'v26-test' } }),
      createSession: (call: { authority: Record<string, unknown>; body: unknown }) => {
        createdAuthority = call.authority;
        createdBody = call.body;
        return { status: 201, body: { opaqueSessionHandle: 'session_workspace_api_1', replayed: false } };
      },
    },
    algorithmCostTable: (handles?: readonly string[]) => {
      filteredHandles = handles;
      return {
        schemaVersion: 'algorithm-cost-table-v0.1', generatedAt: '2026-10-19T02:00:00.000Z',
        basis: 'provider_reservation_upper_bound', actualCostAvailable: false,
        entries: [], rows: [], ipTotals: [], unattributedEntryCount: 0,
        legacyAggregate: { reservationCount: 0, reservedCny: 0, moduleTotals: {}, moduleCounts: {},
          ipBinding: 'not_recorded', sessionBinding: 'not_recorded', roundBinding: 'not_recorded' },
        note: 'workspace-filtered',
      };
    },
  },
});

function routeUrl(relative: string): string {
  return pathToFileURL(resolve(process.cwd(), relative)).href;
}

function publicRequest(path: string, init: RequestInit = {}, cookie?: string): Request {
  return new Request(`https://public.example${path}`, {
    ...init,
    headers: {
      'x-sgx-public-gateway': '1',
      'x-forwarded-proto': 'https',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const pair = /^sgx_test_workspace=([^;]+)/u.exec(setCookie)?.[0];
  assert.ok(pair, 'workspace cookie must be set');
  return pair;
}

test('public workspace API persists one device, binds sessions, filters export, and deletes safely', async () => {
  const bootstrapRoute = await import(routeUrl(
    'src/app/api/algorithm/v0.1/workspaces/bootstrap/route.ts',
  )) as { POST(request: Request): Promise<Response> };
  const currentRoute = await import(routeUrl(
    'src/app/api/algorithm/v0.1/workspaces/current/route.ts',
  )) as { GET(request: Request): Promise<Response>; PUT(request: Request): Promise<Response>;
    DELETE(request: Request): Promise<Response> };
  const exportRoute = await import(routeUrl(
    'src/app/api/algorithm/v0.1/workspaces/current/export/route.ts',
  )) as { GET(request: Request): Promise<Response> };
  const costsRoute = await import(routeUrl(
    'src/app/api/algorithm/v0.1/costs/route.ts',
  )) as { GET(request: Request): Promise<Response> };
  const sessionsRoute = await import(routeUrl(
    'src/app/api/algorithm/v0.1/sessions/route.ts',
  )) as { POST(request: Request): Promise<Response> };

  const missing = await currentRoute.GET(publicRequest('/api/algorithm/v0.1/workspaces/current'));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json() as { code: string }).code, 'workspace_required');

  const bootstrapped = await bootstrapRoute.POST(publicRequest(
    '/api/algorithm/v0.1/workspaces/bootstrap', { method: 'POST' },
  ));
  assert.equal(bootstrapped.status, 201);
  const cookie = cookieFrom(bootstrapped);
  const setCookie = bootstrapped.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  assert.match(setCookie, /Path=\//u);
  assert.match(setCookie, /Max-Age=3456000/u);
  assert.match(setCookie, /Secure/iu);
  const bootstrapJson = await bootstrapped.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(bootstrapJson).includes(cookie.split('=')[1]), false);

  const saved = await currentRoute.PUT(publicRequest('/api/algorithm/v0.1/workspaces/current', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 'test-workspace-ui-update-v0.1', expectedRevision: 0,
      ui: { conversation: { messages: [{ role: 'user', text: '今天见到了老同学' }] },
        profile: { preferences: ['听越剧'] } },
    }),
  }, cookie));
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json() as { workspace: { revision: number } }).workspace.revision), 1);

  const session = await sessionsRoute.POST(publicRequest('/api/algorithm/v0.1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 'algorithm-session-create-v0.1', idempotencyKey: 'ws-api-1',
      requestedMode: 'DAILY_CHAT', subjectBinding: 12345 }),
  }, cookie));
  assert.equal(session.status, 201);
  const sessionJson = await session.json() as Record<string, unknown>;
  assert.equal(Object.hasOwn(sessionJson, 'subjectBinding'), false);
  assert.equal(createdAuthority?.actorId,
    (await store.require(cookie.split('=')[1]).actorId));
  assert.equal(Object.hasOwn(createdBody as object, 'subjectBinding'), false);
  assert.deepEqual(store.listSessionHandles(cookie.split('=')[1]), ['session_workspace_api_1']);

  const costs = await costsRoute.GET(publicRequest('/api/algorithm/v0.1/costs', {}, cookie));
  assert.equal(costs.status, 200);
  assert.deepEqual(filteredHandles, ['session_workspace_api_1']);

  const exported = await exportRoute.GET(publicRequest(
    '/api/algorithm/v0.1/workspaces/current/export', {}, cookie,
  ));
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment/iu);
  const exportJson = await exported.json() as Record<string, unknown>;
  const exportText = JSON.stringify(exportJson);
  assert.equal(exportText.includes(cookie.split('=')[1]), false);
  assert.equal(/base64Audio|audioUrl|apiKey|serverPath|cost-ledger\.jsonl/iu.test(exportText), false);
  assert.equal((exportJson.version as { buildId: string }).buildId, 'v26-test');
  assert.equal((exportJson.budget as { batchCapCny: number }).batchCapCny, 800);
  assert.deepEqual(filteredHandles, ['session_workspace_api_1']);

  const deleted = await currentRoute.DELETE(publicRequest(
    '/api/algorithm/v0.1/workspaces/current', { method: 'DELETE' }, cookie,
  ));
  assert.equal(deleted.status, 200);
  assert.match(deleted.headers.get('set-cookie') ?? '', /Max-Age=0/u);
  const deletedJson = await deleted.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(deletedJson).includes('今天见到了老同学'), false);
  assert.equal(deletedAuthority?.actorId, createdAuthority?.actorId);
  assert.deepEqual(deletedJson.algorithmContentDeletion,
    { evidenceCount: 1, withdrawnRecordCount: 1, invalidatedArtifactCount: 0 });
});

test('wrong device is denied and every nested session route invokes the owner gate', () => {
  const first = store.bootstrap(undefined, { revealToken: true });
  const second = store.bootstrap(undefined, { revealToken: true });
  store.bindSession(first.token!, 'session_cross_device_1');
  const denied = sessionWorkspaceError(publicRequest('/test', {},
    `sgx_test_workspace=${second.token}`), store, 'session_cross_device_1');
  assert.equal(denied?.status, 403);

  const routes = [
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/asr/[asrStreamId]/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/asr/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/end/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/interrupts/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/stream/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/turns/route.ts',
    'src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/view/route.ts',
  ];
  for (const route of routes) {
    const source = readFileSync(resolve(process.cwd(), route), 'utf8');
    assert.match(source, /sessionRequestError\(request,\s*(?:context\.params\.opaqueSessionHandle|handle)\)/u, route);
  }
});

test.after(() => {
  mock.reset();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
