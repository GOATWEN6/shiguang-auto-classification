import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Maintenance failures must remain observable without allowing an operational
 * error to become a user-facing request failure.  Keep this schema deliberately
 * small: it must never contain paths, raw messages, stack traces, evidence
 * references, provider output, or any other user/model content.
 */
export type RetentionSweepOperation = 'content_sweep' | 'diagnostic_sweep';

export interface RetentionSweepDiagnostic {
  schemaVersion: 'retention-sweep-diagnostic-v0.1';
  occurredAt: string;
  operation: RetentionSweepOperation;
  errorCode: string;
  retryable: boolean;
}

const SAFE_ERROR_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EINVAL',
  'diagnostic_retention_lock_unavailable', 'invalid_diagnostic_retention_index',
  'invalid_internal_retention_clock',
]);
const RETRYABLE_CODES = new Set(['EAGAIN', 'EBUSY', 'EEXIST', 'EMFILE', 'ENFILE', 'ENOSPC']);

function safeErrorCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object') return 'unknown';
    // Node filesystem errors normally expose `code`; our own bounded
    // retention errors are plain Error instances whose message is the stable
    // symbolic code.  Accept only exact allowlisted values from either field,
    // never arbitrary text.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && SAFE_ERROR_CODES.has(message) ? message : 'unknown';
  } catch {
    // Proxies and custom error objects may throw while reading properties.
    return 'unknown';
  }
}

function safeTimestamp(now: () => number): string {
  try {
    const value = now();
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  } catch {
    // Fall through to the process clock. Diagnostics must not become a new
    // source of failures when a test or injected clock is invalid.
  }
  return new Date().toISOString();
}

/** Convert an arbitrary thrown value into a bounded, non-sensitive record. */
export function sanitizeRetentionSweepError(operation: RetentionSweepOperation,
  error: unknown, now = () => Date.now()): RetentionSweepDiagnostic {
  const errorCode = safeErrorCode(error);
  return {
    schemaVersion: 'retention-sweep-diagnostic-v0.1',
    occurredAt: safeTimestamp(now),
    operation,
    errorCode,
    retryable: RETRYABLE_CODES.has(errorCode),
  };
}

/**
 * Run best-effort maintenance without allowing it to escape a timer or startup
 * path. The reporter is also guarded: a full or unwritable diagnostics volume
 * must not take down the algorithm service.
 */
export function runRetentionSweepSafely(operation: RetentionSweepOperation,
  sweep: () => unknown, report: (diagnostic: RetentionSweepDiagnostic) => void,
  now = () => Date.now()): boolean {
  try {
    sweep();
    return true;
  } catch (error) {
    try { report(sanitizeRetentionSweepError(operation, error, now)); } catch { /* best effort */ }
    return false;
  }
}

/**
 * Append no-content maintenance diagnostics to the current run. The enclosing
 * diagnostic-retention sweep applies the normal forty-day file expiry because
 * the record contains no content keys or evidence references.
 */
export function createRetentionSweepDiagnostics(directory: string,
  now = () => Date.now()) {
  const path = join(directory, 'retention-errors.jsonl');
  const record = (diagnostic: RetentionSweepDiagnostic): RetentionSweepDiagnostic => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
    } catch {
      // Diagnostics are strictly secondary. Do not mask the original cleanup
      // failure or disrupt the request process when the log cannot be written.
    }
    return diagnostic;
  };
  return { path, record };
}
