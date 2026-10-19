import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const requireBuiltin = createRequire(import.meta.url);

type SqliteRunResult = { changes: number | bigint };
type SqliteStatement = {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): SqliteRunResult;
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type DatabaseSyncConstructor = new (path: string) => SqliteDatabase;

// @types/node@20 does not yet describe Node 22's built-in SQLite module.
const { DatabaseSync } = requireBuiltin('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };

export const TEST_WORKSPACE_RETENTION_MS = 40 * 86_400_000;
export const TEST_WORKSPACE_UI_MAX_BYTES = 2 * 1024 * 1024;
export const TEST_ALGORITHM_STATE_MAX_BYTES = 10 * 1024 * 1024;

export const TEST_WORKSPACE_UI_TOP_LEVEL_FIELDS = Object.freeze([
  'activeTab',
  'algorithmLab',
  'composer',
  'conversation',
  'display',
  'draft',
  'feedback',
  'interview',
  'memory',
  'metadata',
  'preferences',
  'profile',
  'settings',
  'story',
] as const);

export type TestWorkspaceUi = Readonly<Record<string, unknown>>;

export type TestWorkspaceErrorCode =
  | 'TEST_WORKSPACE_INVALID_TOKEN'
  | 'TEST_WORKSPACE_UNAUTHORIZED'
  | 'TEST_WORKSPACE_EXPIRED'
  | 'TEST_WORKSPACE_INVALID_UI'
  | 'TEST_WORKSPACE_REVISION_CONFLICT'
  | 'TEST_WORKSPACE_INVALID_SESSION'
  | 'TEST_WORKSPACE_SESSION_CONFLICT'
  | 'TEST_WORKSPACE_SESSION_FORBIDDEN'
  | 'TEST_ALGORITHM_STATE_INVALID'
  | 'TEST_ALGORITHM_STATE_CORRUPT';

export class TestWorkspaceStoreError extends Error {
  readonly code: TestWorkspaceErrorCode;
  readonly status: number;

  constructor(code: TestWorkspaceErrorCode, status: number) {
    super(code);
    this.name = 'TestWorkspaceStoreError';
    this.code = code;
    this.status = status;
  }
}

export interface TestWorkspaceView {
  schemaVersion: 'test-workspace-v0.1';
  actorId: string;
  subjectId: string;
  familySpaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ui: TestWorkspaceUi;
  sessionHandles: string[];
}

export interface TestWorkspaceBootstrapResult {
  workspace: TestWorkspaceView;
  /** Present only for a newly created workspace when revealToken is explicitly true. */
  token?: string;
}

export interface TestWorkspaceExport {
  schemaVersion: 'test-workspace-export-v0.1';
  exportedAt: string;
  workspace: TestWorkspaceView;
}

export interface TestWorkspaceDeletionAudit {
  schemaVersion: 'test-workspace-deletion-audit-v0.1';
  auditId: string;
  workspaceRefHash: string;
  reason: 'USER_DELETE' | 'RETENTION_40_DAY_EXPIRY';
  deletedAt: string;
}

export interface TestWorkspaceStoreOptions {
  databasePath: string;
  now?: () => number;
  busyTimeoutMs?: number;
}

export interface TestAlgorithmState {
  schemaVersion: string;
  [key: string]: unknown;
}

type WorkspaceRow = {
  workspace_id: string;
  token_hash: string;
  actor_id: string;
  subject_id: string;
  family_space_id: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
  ui_json: string;
};

type AlgorithmStateRow = {
  schema_version: string;
  state_json: string;
  state_sha256: string;
  updated_at_ms: number;
};

const allowedUiFields = new Set<string>(TEST_WORKSPACE_UI_TOP_LEVEL_FIELDS);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9:._/-]{1,160}$/u;
const SERVER_PATH_VALUE = /^(?:file:\/\/|\/(?:Users|home|private|var|tmp|etc|opt|srv|root)(?:\/|$)|[A-Za-z]:\\)/u;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

function assertJsonValue(value: unknown, mode: 'ui' | 'algorithm-state'): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      if (mode === 'ui' && typeof current === 'string' && SERVER_PATH_VALUE.test(current)) {
        throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_UI', 400);
      }
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TestWorkspaceStoreError(
          mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID',
          400,
        );
      }
      continue;
    }
    if (!current || typeof current !== 'object') {
      throw new TestWorkspaceStoreError(
        mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID',
        400,
      );
    }
    if (seen.has(current)) {
      throw new TestWorkspaceStoreError(
        mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID',
        400,
      );
    }
    seen.add(current);
    if (!Array.isArray(current) && !isPlainObject(current)) {
      throw new TestWorkspaceStoreError(
        mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID',
        400,
      );
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = canonicalKey(key);
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new TestWorkspaceStoreError(
          mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID',
          400,
        );
      }
      if (mode === 'ui'
        && (normalized.includes('audio') || normalized.includes('cookie')
          || normalized.includes('serverpath') || normalized.includes('serverfilepath')
          || normalized.includes('filesystempath') || normalized.includes('databasepath')
          || normalized.endsWith('key'))) {
        throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_UI', 400);
      }
      if (mode === 'algorithm-state'
        && (normalized.includes('devicetoken') || normalized.includes('workspacetoken'))) {
        throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_INVALID', 400);
      }
      stack.push(child);
    }
  }
}

function normalizeJsonObject<T extends Record<string, unknown>>(
  value: unknown,
  mode: 'ui' | 'algorithm-state',
  maxBytes: number,
): { normalized: T; json: string } {
  const invalidCode = mode === 'ui' ? 'TEST_WORKSPACE_INVALID_UI' : 'TEST_ALGORITHM_STATE_INVALID';
  if (!isPlainObject(value)) throw new TestWorkspaceStoreError(invalidCode, 400);
  if (mode === 'ui' && Object.keys(value).some(key => !allowedUiFields.has(key))) {
    throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_UI', 400);
  }
  assertJsonValue(value, mode);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TestWorkspaceStoreError(invalidCode, 400);
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new TestWorkspaceStoreError(invalidCode, 413);
  }
  return { normalized: JSON.parse(json) as T, json };
}

function assertToken(token: string): void {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_TOKEN', 401);
  }
}

function assertSessionHandle(sessionHandle: string): void {
  if (typeof sessionHandle !== 'string' || !SESSION_HANDLE_PATTERN.test(sessionHandle)) {
    throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_SESSION', 400);
  }
}

/**
 * Single-machine persistence for the internal algorithm workbench.
 * This is a server-only primitive: callers must keep the issued token in an HttpOnly cookie.
 */
export class TestWorkspaceStore {
  private readonly database: SqliteDatabase;
  private readonly now: () => number;

  constructor(options: TestWorkspaceStoreOptions) {
    if (!options || typeof options.databasePath !== 'string' || !options.databasePath.trim()) {
      throw new Error('test_workspace_database_path_required');
    }
    const databasePath = resolve(options.databasePath);
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.now = options.now ?? Date.now;
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new Error('invalid_test_workspace_busy_timeout');
    }
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${busyTimeoutMs};
      PRAGMA secure_delete = ON;
      PRAGMA journal_size_limit = 0;
      PRAGMA wal_autocheckpoint = 1;
      CREATE TABLE IF NOT EXISTS test_workspaces (
        workspace_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
        actor_id TEXT NOT NULL UNIQUE,
        subject_id TEXT NOT NULL UNIQUE,
        family_space_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        ui_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS test_workspace_sessions (
        session_handle TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES test_workspaces(workspace_id) ON DELETE CASCADE,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS test_workspace_sessions_by_workspace
        ON test_workspace_sessions(workspace_id, created_at_ms, session_handle);
      CREATE TABLE IF NOT EXISTS test_workspace_deletion_audits (
        audit_id TEXT PRIMARY KEY,
        workspace_ref_hash TEXT NOT NULL CHECK(length(workspace_ref_hash) = 64),
        reason TEXT NOT NULL CHECK(reason IN ('USER_DELETE', 'RETENTION_40_DAY_EXPIRY')),
        deleted_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS test_algorithm_state (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        schema_version TEXT NOT NULL,
        state_json TEXT NOT NULL,
        state_sha256 TEXT NOT NULL CHECK(length(state_sha256) = 64),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    const deletedExpired = this.withTransaction(() => this.deleteExpiredRows(this.clock()).length);
    if (deletedExpired > 0) this.scrubDeletedContent();
  }

  close(): void {
    this.database.close();
  }

  bootstrap(token?: string, options: { revealToken?: boolean } = {}): TestWorkspaceBootstrapResult {
    if (token !== undefined) return { workspace: this.require(token) };
    const issuedToken = randomBytes(32).toString('base64url');
    const now = this.clock();
    const workspaceId = `workspace_${randomUUID()}`;
    const row: WorkspaceRow = {
      workspace_id: workspaceId,
      token_hash: sha256(issuedToken),
      actor_id: `actor_${randomUUID()}`,
      subject_id: `subject_${randomUUID()}`,
      family_space_id: `family_${randomUUID()}`,
      revision: 0,
      created_at_ms: now,
      updated_at_ms: now,
      expires_at_ms: now + TEST_WORKSPACE_RETENTION_MS,
      ui_json: '{}',
    };
    const workspace = this.withTransaction(() => {
      this.deleteExpiredRows(now);
      this.database.prepare(`
        INSERT INTO test_workspaces (
          workspace_id, token_hash, actor_id, subject_id, family_space_id,
          revision, created_at_ms, updated_at_ms, expires_at_ms, ui_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.workspace_id, row.token_hash, row.actor_id, row.subject_id, row.family_space_id,
        row.revision, row.created_at_ms, row.updated_at_ms, row.expires_at_ms, row.ui_json,
      );
      return this.toView(row);
    });
    return { workspace, ...(options.revealToken === true ? { token: issuedToken } : {}) };
  }

  require(token: string): TestWorkspaceView {
    const result = this.withTransaction(() => this.resolveActiveWorkspace(token));
    if (result.kind === 'active') return this.toView(result.row);
    return this.throwAccessError(result.kind);
  }

  saveUi(token: string, expectedRevision: number, ui: unknown): TestWorkspaceView {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TestWorkspaceStoreError('TEST_WORKSPACE_REVISION_CONFLICT', 409);
    }
    const normalized = normalizeJsonObject<Record<string, unknown>>(
      ui,
      'ui',
      TEST_WORKSPACE_UI_MAX_BYTES,
    );
    const result = this.withTransaction(() => {
      const resolved = this.resolveActiveWorkspace(token);
      if (resolved.kind !== 'active') return resolved;
      if (resolved.row.revision !== expectedRevision) return { kind: 'conflict' as const };
      const now = this.clock();
      const update = this.database.prepare(`
        UPDATE test_workspaces
        SET ui_json = ?, revision = revision + 1, updated_at_ms = ?
        WHERE workspace_id = ? AND revision = ?
      `).run(normalized.json, now, resolved.row.workspace_id, expectedRevision);
      if (Number(update.changes) !== 1) return { kind: 'conflict' as const };
      return { kind: 'active' as const, row: this.selectWorkspaceById(resolved.row.workspace_id)! };
    });
    if (result.kind === 'active') return this.toView(result.row);
    if (result.kind === 'conflict') {
      throw new TestWorkspaceStoreError('TEST_WORKSPACE_REVISION_CONFLICT', 409);
    }
    return this.throwAccessError(result.kind);
  }

  bindSession(token: string, sessionHandle: string): TestWorkspaceView {
    assertSessionHandle(sessionHandle);
    const result = this.withTransaction(() => {
      const resolved = this.resolveActiveWorkspace(token);
      if (resolved.kind !== 'active') return resolved;
      const existing = this.database.prepare(`
        SELECT workspace_id FROM test_workspace_sessions WHERE session_handle = ?
      `).get(sessionHandle) as { workspace_id: string } | undefined;
      if (existing && existing.workspace_id !== resolved.row.workspace_id) {
        return { kind: 'session-conflict' as const };
      }
      if (!existing) {
        const now = this.clock();
        this.database.prepare(`
          INSERT INTO test_workspace_sessions (session_handle, workspace_id, created_at_ms)
          VALUES (?, ?, ?)
        `).run(sessionHandle, resolved.row.workspace_id, now);
        this.database.prepare(`
          UPDATE test_workspaces SET revision = revision + 1, updated_at_ms = ? WHERE workspace_id = ?
        `).run(now, resolved.row.workspace_id);
      }
      return { kind: 'active' as const, row: this.selectWorkspaceById(resolved.row.workspace_id)! };
    });
    if (result.kind === 'active') return this.toView(result.row);
    if (result.kind === 'session-conflict') {
      throw new TestWorkspaceStoreError('TEST_WORKSPACE_SESSION_CONFLICT', 409);
    }
    return this.throwAccessError(result.kind);
  }

  assertSessionOwner(token: string, sessionHandle: string): void {
    assertSessionHandle(sessionHandle);
    const result = this.withTransaction(() => {
      const resolved = this.resolveActiveWorkspace(token);
      if (resolved.kind !== 'active') return resolved;
      const owner = this.database.prepare(`
        SELECT workspace_id FROM test_workspace_sessions WHERE session_handle = ?
      `).get(sessionHandle) as { workspace_id: string } | undefined;
      return owner?.workspace_id === resolved.row.workspace_id
        ? { kind: 'owned' as const }
        : { kind: 'forbidden' as const };
    });
    if (result.kind === 'owned') return;
    if (result.kind === 'forbidden') {
      throw new TestWorkspaceStoreError('TEST_WORKSPACE_SESSION_FORBIDDEN', 403);
    }
    return this.throwAccessError(result.kind);
  }

  listSessionHandles(token: string): string[] {
    const result = this.withTransaction(() => {
      const resolved = this.resolveActiveWorkspace(token);
      if (resolved.kind !== 'active') return resolved;
      return {
        kind: 'handles' as const,
        handles: this.sessionHandles(resolved.row.workspace_id),
      };
    });
    if (result.kind === 'handles') return result.handles;
    return this.throwAccessError(result.kind);
  }

  exportCurrent(token: string): TestWorkspaceExport {
    const workspace = this.require(token);
    return {
      schemaVersion: 'test-workspace-export-v0.1',
      exportedAt: new Date(this.clock()).toISOString(),
      workspace,
    };
  }

  deleteWorkspace(token: string): TestWorkspaceDeletionAudit {
    const result = this.withTransaction(() => {
      const resolved = this.resolveActiveWorkspace(token);
      if (resolved.kind !== 'active') return resolved;
      return {
        kind: 'deleted' as const,
        audit: this.deleteWorkspaceRow(resolved.row, 'USER_DELETE', this.clock()),
      };
    });
    if (result.kind === 'deleted') {
      this.scrubDeletedContent();
      return result.audit;
    }
    return this.throwAccessError(result.kind);
  }

  /** Internal diagnostics only. Audits intentionally contain no UI, session, actor, subject, or token data. */
  listDeletionAudits(): TestWorkspaceDeletionAudit[] {
    return (this.database.prepare(`
      SELECT audit_id, workspace_ref_hash, reason, deleted_at_ms
      FROM test_workspace_deletion_audits ORDER BY deleted_at_ms, audit_id
    `).all() as Array<{
      audit_id: string;
      workspace_ref_hash: string;
      reason: TestWorkspaceDeletionAudit['reason'];
      deleted_at_ms: number;
    }>).map(row => ({
      schemaVersion: 'test-workspace-deletion-audit-v0.1',
      auditId: row.audit_id,
      workspaceRefHash: row.workspace_ref_hash,
      reason: row.reason,
      deletedAt: new Date(row.deleted_at_ms).toISOString(),
    }));
  }

  /** Server-only global snapshot. Do not expose this method through the device-workspace HTTP API. */
  saveAlgorithmState(state: TestAlgorithmState): { schemaVersion: string; updatedAt: string } {
    const normalized = normalizeJsonObject<TestAlgorithmState>(
      state,
      'algorithm-state',
      TEST_ALGORITHM_STATE_MAX_BYTES,
    );
    if (typeof normalized.normalized.schemaVersion !== 'string'
      || !VERSION_PATTERN.test(normalized.normalized.schemaVersion)) {
      throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_INVALID', 400);
    }
    const now = this.clock();
    this.withTransaction(() => {
      this.database.prepare(`
        INSERT INTO test_algorithm_state (
          singleton_id, schema_version, state_json, state_sha256, updated_at_ms
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          state_json = excluded.state_json,
          state_sha256 = excluded.state_sha256,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        normalized.normalized.schemaVersion,
        normalized.json,
        sha256(normalized.json),
        now,
      );
    });
    return { schemaVersion: normalized.normalized.schemaVersion, updatedAt: new Date(now).toISOString() };
  }

  /** Server-only global snapshot. Corruption is an error; it never silently becomes an empty snapshot. */
  loadAlgorithmState<T extends TestAlgorithmState = TestAlgorithmState>(): T | null {
    const row = this.database.prepare(`
      SELECT schema_version, state_json, state_sha256, updated_at_ms
      FROM test_algorithm_state WHERE singleton_id = 1
    `).get() as AlgorithmStateRow | undefined;
    if (!row) return null;
    if (sha256(row.state_json) !== row.state_sha256) {
      throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_CORRUPT', 500);
    }
    let value: unknown;
    try {
      value = JSON.parse(row.state_json);
    } catch {
      throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_CORRUPT', 500);
    }
    let normalized: { normalized: TestAlgorithmState; json: string };
    try {
      normalized = normalizeJsonObject<TestAlgorithmState>(
        value,
        'algorithm-state',
        TEST_ALGORITHM_STATE_MAX_BYTES,
      );
    } catch {
      throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_CORRUPT', 500);
    }
    if (normalized.normalized.schemaVersion !== row.schema_version
      || typeof normalized.normalized.schemaVersion !== 'string'
      || !VERSION_PATTERN.test(normalized.normalized.schemaVersion)) {
      throw new TestWorkspaceStoreError('TEST_ALGORITHM_STATE_CORRUPT', 500);
    }
    return normalized.normalized as T;
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_test_workspace_clock');
    return value;
  }

  private withTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* retain the original error */ }
      throw error;
    }
  }

  private throwAccessError(kind: 'expired' | 'missing'): never {
    if (kind === 'expired') this.scrubDeletedContent();
    throw new TestWorkspaceStoreError(
      kind === 'expired' ? 'TEST_WORKSPACE_EXPIRED' : 'TEST_WORKSPACE_UNAUTHORIZED',
      401,
    );
  }

  private scrubDeletedContent(): void {
    // secure_delete clears deleted cells; checkpoint + VACUUM removes prior WAL/free-page copies.
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }

  private resolveActiveWorkspace(token: string):
    | { kind: 'active'; row: WorkspaceRow }
    | { kind: 'expired' }
    | { kind: 'missing' } {
    assertToken(token);
    const row = this.database.prepare(`
      SELECT workspace_id, token_hash, actor_id, subject_id, family_space_id,
        revision, created_at_ms, updated_at_ms, expires_at_ms, ui_json
      FROM test_workspaces WHERE token_hash = ?
    `).get(sha256(token)) as WorkspaceRow | undefined;
    if (!row) return { kind: 'missing' };
    const now = this.clock();
    if (row.expires_at_ms <= now) {
      this.deleteWorkspaceRow(row, 'RETENTION_40_DAY_EXPIRY', now);
      return { kind: 'expired' };
    }
    return { kind: 'active', row };
  }

  private selectWorkspaceById(workspaceId: string): WorkspaceRow | undefined {
    return this.database.prepare(`
      SELECT workspace_id, token_hash, actor_id, subject_id, family_space_id,
        revision, created_at_ms, updated_at_ms, expires_at_ms, ui_json
      FROM test_workspaces WHERE workspace_id = ?
    `).get(workspaceId) as WorkspaceRow | undefined;
  }

  private sessionHandles(workspaceId: string): string[] {
    return (this.database.prepare(`
      SELECT session_handle FROM test_workspace_sessions
      WHERE workspace_id = ? ORDER BY created_at_ms, session_handle
    `).all(workspaceId) as Array<{ session_handle: string }>).map(row => row.session_handle);
  }

  private toView(row: WorkspaceRow): TestWorkspaceView {
    let ui: Record<string, unknown>;
    try {
      ui = normalizeJsonObject<Record<string, unknown>>(
        JSON.parse(row.ui_json),
        'ui',
        TEST_WORKSPACE_UI_MAX_BYTES,
      ).normalized;
    } catch {
      throw new TestWorkspaceStoreError('TEST_WORKSPACE_INVALID_UI', 500);
    }
    return {
      schemaVersion: 'test-workspace-v0.1',
      actorId: row.actor_id,
      subjectId: row.subject_id,
      familySpaceId: row.family_space_id,
      revision: row.revision,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
      expiresAt: new Date(row.expires_at_ms).toISOString(),
      ui,
      sessionHandles: this.sessionHandles(row.workspace_id),
    };
  }

  private deleteWorkspaceRow(
    row: WorkspaceRow,
    reason: TestWorkspaceDeletionAudit['reason'],
    deletedAtMs: number,
  ): TestWorkspaceDeletionAudit {
    const audit: TestWorkspaceDeletionAudit = {
      schemaVersion: 'test-workspace-deletion-audit-v0.1',
      auditId: `audit_${randomUUID()}`,
      workspaceRefHash: sha256(row.workspace_id),
      reason,
      deletedAt: new Date(deletedAtMs).toISOString(),
    };
    this.database.prepare('DELETE FROM test_workspaces WHERE workspace_id = ?').run(row.workspace_id);
    this.database.prepare(`
      INSERT INTO test_workspace_deletion_audits (
        audit_id, workspace_ref_hash, reason, deleted_at_ms
      ) VALUES (?, ?, ?, ?)
    `).run(audit.auditId, audit.workspaceRefHash, audit.reason, deletedAtMs);
    return audit;
  }

  private deleteExpiredRows(now: number): TestWorkspaceDeletionAudit[] {
    const rows = this.database.prepare(`
      SELECT workspace_id, token_hash, actor_id, subject_id, family_space_id,
        revision, created_at_ms, updated_at_ms, expires_at_ms, ui_json
      FROM test_workspaces WHERE expires_at_ms <= ? ORDER BY expires_at_ms, workspace_id
    `).all(now) as WorkspaceRow[];
    return rows.map(row => this.deleteWorkspaceRow(row, 'RETENTION_40_DAY_EXPIRY', now));
  }
}

export function createTestWorkspaceStore(options: TestWorkspaceStoreOptions): TestWorkspaceStore {
  return new TestWorkspaceStore(options);
}
