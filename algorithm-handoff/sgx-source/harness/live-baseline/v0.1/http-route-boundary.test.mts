import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Zero-cost fault-injection check for the route-handler outer boundaries.
 *
 * The runtime is mocked to throw before a business response. The test checks
 * that the five protected POST handlers return one redacted JSON 500 instead
 * of a rejected promise, HTML, a stack, or provider output. It needs the
 * test-only loader because Node cannot resolve Next's bundler-only bare
 * `next/server` entry directly.
 */

function runtimeModuleUrl(): string {
  return pathToFileURL(resolve(process.cwd(), 'src/app/api/algorithm/v0.1/_shared/runtime.ts')).href;
}

function routeUrl(relativePath: string): string {
  return pathToFileURL(resolve(process.cwd(), relativePath)).href;
}

function redactedInternalError(request: Request): Response {
  const id = request.headers.get('x-request-id') || 'request_mock_fallback';
  return new Response(JSON.stringify({ requestId: id, code: 'internal_error',
    message: '算法服务未能完成请求。', retryable: true }), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-ID': id },
  });
}

function installRuntimeMock(): void {
  mock.module(runtimeModuleUrl(), {
    namedExports: {
      internalRequestError() { throw new Error('injected_route_failure'); },
      sessionRequestError() { throw new Error('injected_route_failure'); },
      internalServerError: redactedInternalError,
      jsonBody: async () => null,
      requestId: () => 'request_unused',
      retainTurnResult: () => undefined,
      internalAlgorithmRuntime: {
        workspaceStore: {},
        pendingAudio: new Map(), asrStreams: new Map(), streamOperations: new Map(),
        listeners: new Map(), provider: null, service: { health: () => ({ status: 200 }) },
        orchestrator: {},
      },
      algorithmHttpService: {},
      trustedFakeAuthority: () => ({ actorId: 'actor', subjectId: 'subject' }),
      subjectBindingFor: () => 'binding',
      requestWorkspace: () => null,
      workspaceRequestError: redactedInternalError,
      withAlgorithmCostContext: <T>(_request: Request, _handle: string, operation: () => T): T => operation(),
    },
  });
}

async function assertBoundary(routePath: string): Promise<void> {
  const route = await import(routeUrl(routePath)) as {
    POST: (request: Request, context?: unknown) => Promise<Response>;
  };
  const request = new Request('http://127.0.0.1/api/algorithm/v0.1/test', {
    method: 'POST',
    headers: { 'x-request-id': `fault-${routePath.replaceAll('/', '_')}` },
    body: '{}',
  });
  const response = await route.POST(request, { params: { opaqueSessionHandle: 'session-fault' } });
  assert.equal(response.status, 500);
  assert.match(response.headers.get('content-type') || '', /^application\/json/u);
  assert.equal(response.headers.get('x-request-id'), request.headers.get('x-request-id'));
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'requestId', 'retryable']);
  assert.equal(body.code, 'internal_error');
  assert.equal(body.retryable, true);
  assert.equal(typeof body.requestId, 'string');
  assert.doesNotMatch(JSON.stringify(body), /stack|injected_route_failure|<html>/iu);
}

test('algorithm route outer boundaries redact injected runtime failures', async () => {
  installRuntimeMock();
  try {
    await assertBoundary('src/app/api/algorithm/v0.1/sessions/route.ts');
    await assertBoundary('src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/end/route.ts');
    await assertBoundary('src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/turns/route.ts');
    await assertBoundary('src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/interrupts/route.ts');
    await assertBoundary('src/app/api/algorithm/v0.1/sessions/[opaqueSessionHandle]/stream/route.ts');
  } finally {
    mock.reset();
  }
});
