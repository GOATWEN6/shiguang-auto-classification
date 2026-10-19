import { randomUUID } from 'node:crypto';

export type InternalErrorBody = {
  requestId: string;
  code: 'internal_error';
  message: string;
  retryable: true;
};

/**
 * Request identifiers are an observability boundary.  A malformed adapter or
 * test double must not throw while we are already handling another failure.
 */
export function requestId(request: Request): string {
  try {
    return request?.headers?.get('x-request-id')?.trim() || `request_${randomUUID()}`;
  } catch {
    return `request_${randomUUID()}`;
  }
}

/** Keep framework error responses correlated without exposing exception text. */
export function internalErrorBody(request: Request): InternalErrorBody {
  return { requestId: requestId(request), code: 'internal_error',
    message: '算法服务未能完成请求。', retryable: true };
}
