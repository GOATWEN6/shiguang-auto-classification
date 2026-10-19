import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  TEST_ALGORITHM_STATE_MAX_BYTES,
  TEST_WORKSPACE_RETENTION_MS,
  TestWorkspaceStore,
  TestWorkspaceStoreError,
} from '../../../src/lib/algorithm-service/test-workspace-store.ts';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { get(...values: unknown[]): unknown; run(...values: unknown[]): unknown };
    close(): void;
  };
};
const START = Date.parse('2026-10-19T02:00:00.000Z');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sgx-test-workspace-'));
  const databasePath = join(directory, 'workspace.sqlite');
  let now = START;
  const open = () => new TestWorkspaceStore({ databasePath, now: () => now });
  return { directory, databasePath, open, setNow(value: number) { now = value; } };
}

function issued(store: TestWorkspaceStore) {
  const result = store.bootstrap(undefined, { revealToken: true });
  assert.equal(typeof result.token, 'string');
  return { token: result.token!, workspace: result.workspace };
}

function expectStoreError(operation: () => unknown, code: string, status: number): void {
  assert.throws(operation, error => error instanceof TestWorkspaceStoreError
    && error.code === code && error.status === status);
}

test('bootstrap hides the token by default and restart restores stable workspace identity and UI', () => {
  const fx = fixture();
  try {
    const firstStore = fx.open();
    assert.equal(firstStore.bootstrap().token, undefined);
    const first = issued(firstStore);
    const saved = firstStore.saveUi(first.token, first.workspace.revision, {
      activeTab: 'memory',
      memory: { items: [{ label: '喜欢听越剧' }] },
    });
    firstStore.bindSession(first.token, 'session_restart_1');
    firstStore.close();

    const restoredStore = fx.open();
    const restored = restoredStore.bootstrap(first.token).workspace;
    assert.equal(restored.actorId, first.workspace.actorId);
    assert.equal(restored.subjectId, first.workspace.subjectId);
    assert.equal(restored.familySpaceId, first.workspace.familySpaceId);
    assert.deepEqual(restored.ui, saved.ui);
    assert.deepEqual(restored.sessionHandles, ['session_restart_1']);
    assert.equal(statSync(fx.directory).mode & 0o777, 0o700);
    assert.equal(statSync(fx.databasePath).mode & 0o777, 0o600);
    restoredStore.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('two device tokens remain isolated regardless of a shared network or IP', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    const second = issued(store);
    store.saveUi(first.token, first.workspace.revision, { conversation: { messages: ['甲设备内容'] } });
    store.saveUi(second.token, second.workspace.revision, { conversation: { messages: ['乙设备内容'] } });
    assert.deepEqual(store.require(first.token).ui, { conversation: { messages: ['甲设备内容'] } });
    assert.deepEqual(store.require(second.token).ui, { conversation: { messages: ['乙设备内容'] } });
    assert.notEqual(first.workspace.actorId, second.workspace.actorId);
    store.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('database stores only the token SHA-256 and forged tokens fail closed', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    expectStoreError(
      () => store.require(`${first.token.slice(0, -1)}${first.token.endsWith('A') ? 'B' : 'A'}`),
      'TEST_WORKSPACE_UNAUTHORIZED',
      401,
    );
    store.close();
    const bytes = readFileSync(fx.databasePath);
    assert.equal(bytes.includes(Buffer.from(first.token)), false);
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('saveUi uses revision CAS and validates the bounded allow-listed UI document', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    const saved = store.saveUi(first.token, 0, { feedback: { rating: 'good' } });
    assert.equal(saved.revision, 1);
    expectStoreError(
      () => store.saveUi(first.token, 0, { feedback: { rating: 'stale' } }),
      'TEST_WORKSPACE_REVISION_CONFLICT',
      409,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { unknownTopLevel: true }),
      'TEST_WORKSPACE_INVALID_UI',
      400,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { settings: { apiKey: 'secret' } }),
      'TEST_WORKSPACE_INVALID_UI',
      400,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { conversation: { audioUrl: 'https://invalid/audio.mp3' } }),
      'TEST_WORKSPACE_INVALID_UI',
      400,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { metadata: { cookies: 'session=value' } }),
      'TEST_WORKSPACE_INVALID_UI',
      400,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { draft: { serverPath: '/Users/server/private.json' } }),
      'TEST_WORKSPACE_INVALID_UI',
      400,
    );
    expectStoreError(
      () => store.saveUi(first.token, 1, { draft: { text: '甲'.repeat(2 * 1024 * 1024) } }),
      'TEST_WORKSPACE_INVALID_UI',
      413,
    );
    store.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('session handles are idempotent for their owner and rejected across workspaces', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    const second = issued(store);
    const bound = store.bindSession(first.token, 'session_owned_1');
    assert.deepEqual(bound.sessionHandles, ['session_owned_1']);
    const idempotent = store.bindSession(first.token, 'session_owned_1');
    assert.equal(idempotent.revision, bound.revision);
    assert.doesNotThrow(() => store.assertSessionOwner(first.token, 'session_owned_1'));
    expectStoreError(
      () => store.bindSession(second.token, 'session_owned_1'),
      'TEST_WORKSPACE_SESSION_CONFLICT',
      409,
    );
    expectStoreError(
      () => store.assertSessionOwner(second.token, 'session_owned_1'),
      'TEST_WORKSPACE_SESSION_FORBIDDEN',
      403,
    );
    assert.deepEqual(store.listSessionHandles(second.token), []);
    store.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('export contains current user-facing state but no token, hash, cookie, audio, or server path', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    store.saveUi(first.token, 0, {
      profile: { preferences: ['听越剧'] },
      story: { title: '重阳节见老同学' },
    });
    const exported = store.exportCurrent(first.token);
    const json = JSON.stringify(exported);
    assert.equal(json.includes(first.token), false);
    assert.equal(/token_hash|tokenHash|cookie|audio|serverPath|databasePath/iu.test(json), false);
    assert.deepEqual(exported.workspace.ui, {
      profile: { preferences: ['听越剧'] },
      story: { title: '重阳节见老同学' },
    });
    store.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('explicit deletion removes body and sessions while retaining only a no-content audit', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    store.saveUi(first.token, 0, { conversation: { messages: ['不应留在审计中'] } });
    store.bindSession(first.token, 'session_delete_1');
    const audit = store.deleteWorkspace(first.token);
    assert.equal(audit.reason, 'USER_DELETE');
    expectStoreError(() => store.require(first.token), 'TEST_WORKSPACE_UNAUTHORIZED', 401);
    const audits = store.listDeletionAudits();
    assert.deepEqual(audits, [audit]);
    const auditJson = JSON.stringify(audits);
    assert.equal(auditJson.includes('不应留在审计中'), false);
    assert.equal(auditJson.includes('session_delete_1'), false);
    assert.equal(auditJson.includes(first.token), false);
    store.close();
    for (const file of readdirSync(fx.directory)) {
      assert.equal(readFileSync(join(fx.directory, file)).includes(Buffer.from('不应留在审计中')), false);
    }
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('40-day expiry deletes persisted body on restart and keeps a no-content expiry audit', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const first = issued(store);
    store.saveUi(first.token, 0, { memory: { facts: ['只保留四十天'] } });
    store.close();
    fx.setNow(START + TEST_WORKSPACE_RETENTION_MS);
    const expired = fx.open();
    expectStoreError(() => expired.require(first.token), 'TEST_WORKSPACE_UNAUTHORIZED', 401);
    const audits = expired.listDeletionAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].reason, 'RETENTION_40_DAY_EXPIRY');
    assert.equal(JSON.stringify(audits).includes('只保留四十天'), false);
    expired.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('global algorithm snapshot atomically survives restart without any device token', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    const device = issued(store);
    const snapshot = {
      schemaVersion: 'algorithm-snapshot-v0.1',
      evidence: [{ id: 'evidence_1', statement: '喜欢听越剧' }],
      references: [{ id: 'reference_1' }],
      artifacts: [{ id: 'profile_1', kind: 'PROFILE' }],
    };
    store.saveAlgorithmState(snapshot);
    store.close();
    const restored = fx.open();
    assert.deepEqual(restored.loadAlgorithmState(), snapshot);
    const persisted = readFileSync(fx.databasePath);
    assert.equal(persisted.includes(Buffer.from(device.token)), false);
    expectStoreError(
      () => restored.saveAlgorithmState({ schemaVersion: 'bad token snapshot', deviceToken: device.token }),
      'TEST_ALGORITHM_STATE_INVALID',
      400,
    );
    expectStoreError(
      () => restored.saveAlgorithmState({ schemaVersion: '', evidence: [] }),
      'TEST_ALGORITHM_STATE_INVALID',
      400,
    );
    expectStoreError(
      () => restored.saveAlgorithmState({
        schemaVersion: 'algorithm-snapshot-v0.1',
        evidence: 'x'.repeat(TEST_ALGORITHM_STATE_MAX_BYTES),
      }),
      'TEST_ALGORITHM_STATE_INVALID',
      413,
    );
    restored.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('corrupted global algorithm snapshot fails closed instead of returning partial or empty state', () => {
  const fx = fixture();
  try {
    const store = fx.open();
    store.saveAlgorithmState({ schemaVersion: 'algorithm-snapshot-v0.1', evidence: [{ id: 'e1' }] });
    store.close();
    const raw = new DatabaseSync(fx.databasePath);
    raw.prepare("UPDATE test_algorithm_state SET state_json = ? WHERE singleton_id = 1")
      .run('{"schemaVersion":"algorithm-snapshot-v0.1","evidence":');
    raw.close();
    const corrupted = fx.open();
    expectStoreError(
      () => corrupted.loadAlgorithmState(),
      'TEST_ALGORITHM_STATE_CORRUPT',
      500,
    );
    corrupted.close();
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});
