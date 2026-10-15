import { assertRuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import { validatePcm16AudioChunk } from './audio-chunk-validator.ts';
import type {
  DoubaoInjectedTransportConnection,
  DoubaoStreamingAdapterOptions,
  DoubaoStreamingAsrAdapter,
  DoubaoStreamingAsrSession,
  DoubaoStreamingOpenOptions,
  DoubaoTransportOpenOptions,
} from './contracts.ts';

export type AsrTransportOperation = 'open' | 'send' | 'end' | 'cancel';

/**
 * Public, redacted transport failure. The original exception is deliberately
 * not exposed as `cause`, because provider errors may contain credentials.
 */
export class AsrTransportError extends Error {
  readonly code = 'asr_transport_error' as const;
  readonly operation: AsrTransportOperation;

  constructor(operation: AsrTransportOperation, detail?: string) {
    super(`ASR transport ${operation} failed${detail ? `: ${detail}` : ''}`);
    this.name = 'AsrTransportError';
    this.operation = operation;
  }
}

function nonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function abortError(): Error {
  const error = new Error('ASR session was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function validateHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers must be an explicit string record');
  }
  const cloned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    nonEmpty(key, 'header name');
    if (typeof value !== 'string') throw new Error(`header ${key} must be a string`);
    cloned[key] = value;
  }
  return cloned;
}

function validateConnection(value: unknown): DoubaoInjectedTransportConnection {
  if (!value || typeof value !== 'object') throw new Error('transport returned no connection');
  const connection = value as Partial<DoubaoInjectedTransportConnection>;
  if (
    typeof connection.send !== 'function'
    || typeof connection.end !== 'function'
    || typeof connection.cancel !== 'function'
  ) {
    throw new Error('transport connection must implement send, end and cancel');
  }
  return connection as DoubaoInjectedTransportConnection;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function redactTransportDetail(error: unknown, secrets: readonly string[]): string | undefined {
  if (!(error instanceof Error) || !error.message.trim()) return undefined;

  let detail = error.message;
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    detail = replaceAllLiteral(detail, secret, '[REDACTED]');
  }
  detail = detail
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .trim();

  if (!detail) return undefined;
  return detail.length <= 240 ? detail : `${detail.slice(0, 237)}...`;
}

function normalizeTransportError(
  operation: AsrTransportOperation,
  error: unknown,
  secrets: readonly string[],
): AsrTransportError {
  return new AsrTransportError(operation, redactTransportDetail(error, secrets));
}

export function createDoubaoStreamingAsrAdapter(
  options: DoubaoStreamingAdapterOptions,
): DoubaoStreamingAsrAdapter {
  if (!options || typeof options.transportFactory !== 'function') {
    throw new Error('an injected transportFactory is required');
  }

  return {
    provider: 'doubao-independent-streaming-asr',
    hiddenRetryCapability: false,
    networkCapability: 'injected_transport_only',

    async open(openOptions: DoubaoStreamingOpenOptions): Promise<DoubaoStreamingAsrSession> {
      assertRuntimeIdentity(openOptions.identity);
      nonEmpty(openOptions.requestId, 'requestId');
      if (!openOptions.signal || typeof openOptions.signal.aborted !== 'boolean') {
        throw new Error('an explicit AbortSignal is required');
      }
      if (typeof openOptions.onDecodedPayload !== 'function') {
        throw new Error('onDecodedPayload callback is required');
      }
      if (openOptions.signal.aborted) throw abortError();

      const headers = validateHeaders(openOptions.headers);
      const secretValues = Object.values(headers);
      let connection: DoubaoInjectedTransportConnection;
      let cancelled = false;
      let ended = false;
      let eosSent = false;
      let initialSequence: number | undefined;
      let lastSequence: number | undefined;
      let endInFlight: Promise<void> | undefined;
      let acceptingSends = true;
      let operationTail: Promise<void> = Promise.resolve();
      const cancellationWaiters = new Set<() => void>();

      const deliverDecodedPayload = async (payload: unknown): Promise<void> => {
        if (cancelled || openOptions.signal.aborted) return;
        await openOptions.onDecodedPayload(payload);
      };
      const transportOpenOptions: DoubaoTransportOpenOptions = {
        identity: {
          ...openOptions.identity,
          evidenceRefs: [...openOptions.identity.evidenceRefs],
        },
        requestId: openOptions.requestId,
        headers,
        signal: openOptions.signal,
        onDecodedPayload: deliverDecodedPayload,
      };

      let transport;
      try {
        transport = options.transportFactory();
      } catch (error) {
        throw normalizeTransportError('open', error, secretValues);
      }
      if (!transport || typeof transport.open !== 'function') {
        throw new Error('transportFactory must return an open-capable transport');
      }
      try {
        connection = validateConnection(await transport.open(transportOpenOptions));
      } catch (error) {
        if (openOptions.signal.aborted) throw abortError();
        if (error instanceof Error && (
          error.message === 'transport returned no connection'
          || error.message === 'transport connection must implement send, end and cancel'
        )) {
          throw error;
        }
        throw normalizeTransportError('open', error, secretValues);
      }

      const cancelConnection = async (
        reason: string,
        exposeFailure: boolean,
      ): Promise<void> => {
        if (cancelled) return;
        cancelled = true;
        acceptingSends = false;
        openOptions.signal.removeEventListener('abort', onAbort);
        for (const rejectPendingOperation of cancellationWaiters) {
          rejectPendingOperation();
        }
        cancellationWaiters.clear();
        try {
          await connection.cancel(reason);
        } catch (error) {
          if (exposeFailure) {
            throw normalizeTransportError('cancel', error, secretValues);
          }
        }
      };
      const onAbort = (): void => {
        void cancelConnection('abort_signal', false);
      };
      openOptions.signal.addEventListener('abort', onAbort, { once: true });
      if (openOptions.signal.aborted) {
        await cancelConnection('abort_during_open', false);
        throw abortError();
      }

      const enqueueOperation = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operationTail.then(operation);
        operationTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };

      const awaitTransportOrCancellation = <T>(operation: Promise<T>): Promise<T> => {
        if (cancelled || openOptions.signal.aborted) return Promise.reject(abortError());
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          const rejectForCancellation = (): void => {
            if (settled) return;
            settled = true;
            cancellationWaiters.delete(rejectForCancellation);
            reject(abortError());
          };
          cancellationWaiters.add(rejectForCancellation);
          operation.then(
            value => {
              if (settled) return;
              settled = true;
              cancellationWaiters.delete(rejectForCancellation);
              resolve(value);
            },
            error => {
              if (settled) return;
              settled = true;
              cancellationWaiters.delete(rejectForCancellation);
              reject(error);
            },
          );
          if (cancelled || openOptions.signal.aborted) rejectForCancellation();
        });
      };

      return {
        async send(chunk) {
          if (cancelled || openOptions.signal.aborted) throw abortError();
          if (!acceptingSends || ended) {
            throw new Error('cannot send audio after ASR session end was requested');
          }
          const validated = validatePcm16AudioChunk(chunk);

          return enqueueOperation(async () => {
            if (cancelled || openOptions.signal.aborted) throw abortError();
            if (ended) throw new Error('cannot send audio after ASR session end');
            if (eosSent) throw new Error('cannot send audio after an explicit EOS chunk');
            if (initialSequence === undefined) initialSequence = validated.sequence;
            const expectedSequence = lastSequence === undefined
              ? initialSequence
              : lastSequence + 1;
            if (validated.sequence !== expectedSequence) {
              throw new Error('audio chunk sequence must be contiguous and strictly increasing');
            }

            try {
              await awaitTransportOrCancellation(Promise.resolve(connection.send(validated)));
            } catch (error) {
              if (cancelled || openOptions.signal.aborted || isAbortError(error)) {
                throw abortError();
              }
              throw normalizeTransportError('send', error, secretValues);
            }
            if (cancelled || openOptions.signal.aborted) throw abortError();

            // Commit local provenance only after the injected transport confirms
            // this chunk and the operation has not been cancelled in flight.
            lastSequence = validated.sequence;
            eosSent = validated.endOfStream;
            return validated;
          });
        },

        async end() {
          if (cancelled || openOptions.signal.aborted) throw abortError();
          if (ended) return;
          if (endInFlight) return endInFlight;
          acceptingSends = false;

          const operation = enqueueOperation(async (): Promise<void> => {
            if (cancelled || openOptions.signal.aborted) throw abortError();
            try {
              await awaitTransportOrCancellation(Promise.resolve(connection.end()));
            } catch (error) {
              if (cancelled || openOptions.signal.aborted || isAbortError(error)) {
                throw abortError();
              }
              throw normalizeTransportError('end', error, secretValues);
            }
            if (cancelled || openOptions.signal.aborted) throw abortError();

            ended = true;
            openOptions.signal.removeEventListener('abort', onAbort);
          });
          endInFlight = operation;
          try {
            await operation;
          } finally {
            endInFlight = undefined;
          }
        },

        async cancel(reason: string) {
          nonEmpty(reason, 'cancel reason');
          await cancelConnection(reason, true);
        },
      };
    },
  };
}
