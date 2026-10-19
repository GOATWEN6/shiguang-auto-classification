import assert from 'node:assert/strict';
import test from 'node:test';

import { internalErrorBody, requestId } from '../../../src/app/api/algorithm/v0.1/_shared/http-error-boundary.ts';

test('requestId preserves a usable caller id and falls back safely', () => {
  const request = new Request('http://127.0.0.1', { headers: { 'x-request-id': '  fault-001  ' } });
  assert.equal(requestId(request), 'fault-001');

  const generated = requestId(new Request('http://127.0.0.1'));
  assert.match(generated, /^request_[0-9a-f-]{36}$/u);

  const malformed = { headers: { get() { throw new Error('adapter detail must not escape'); } } } as unknown as Request;
  const recovered = requestId(malformed);
  assert.match(recovered, /^request_[0-9a-f-]{36}$/u);
});

test('internalErrorBody is a fixed redacted contract', () => {
  const body = internalErrorBody(new Request('http://127.0.0.1', {
    headers: { 'x-request-id': 'fault-redacted' },
  }));
  assert.deepEqual(body, {
    requestId: 'fault-redacted', code: 'internal_error',
    message: '算法服务未能完成请求。', retryable: true,
  });
  assert.doesNotMatch(JSON.stringify(body), /stack|<html>|adapter detail|injected_route_failure/iu);
});
