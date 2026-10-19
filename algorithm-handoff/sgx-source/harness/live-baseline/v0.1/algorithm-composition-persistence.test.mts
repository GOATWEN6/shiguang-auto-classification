import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAlgorithmComposition,
  type AlgorithmCompositionPersistentState,
  type LiveProvider,
} from '../../../src/lib/algorithm-service/index.ts';
import { InMemoryReferenceStore } from '../../../src/lib/memory-runtime/index.ts';
import type { TrustedSessionAuthority } from '../../../src/lib/turn-orchestrator/index.ts';

const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-persistent-A',
  subjectId: 'elder-persistent-A',
  familySpaceId: 'family-persistent-A',
  authorizationVersion: 'auth-persistent-v1',
  visibilityScope: ['elder_only'],
};

function provider(): LiveProvider {
  return {
    async json(_system, input, options) {
      const data = input as any;
      if (options.module === 'memory') {
        const source = data.evidence[0];
        return { proposals: [{
          providerProposalId: 'persistent-memory-1',
          contentType: 'preference',
          normalizedClaim: '老人平时喜欢听越剧。',
          query: '越剧',
          sourceEvidenceRefs: [source.ref],
          sourceSpans: [{ evidenceRef: source.ref, quote: '我平时喜欢听越剧' }],
          eventTime: null,
          validFrom: null,
          validTo: null,
          sensitivityLevel: 'S0',
          signals: {
            shortTerm: false,
            temporalState: 'CURRENT',
            conflict: false,
            ambiguousSubject: false,
            purposeExpansion: false,
            visibilityExpansion: false,
          },
        }] };
      }
      if (options.module === 'profile_draft') {
        const source = data.sources[0];
        return { schemaVersion: '0.3', fields: [{
          fieldId: 'music-1',
          path: 'preferences.music',
          value: '喜欢听越剧',
          temporalScope: 'CURRENT',
          recordIds: [source.recordId],
          evidenceRefs: source.evidenceRefs,
          claimMode: 'DIRECT',
          uncertainty: 'NONE',
        }] };
      }
      return { text: '越剧承载了不少熟悉的声音，我会按您说的内容整理画像。', questions: [] };
    },
    async synthesize() {
      return { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' };
    },
    async transcribe() {
      return { text: '我平时喜欢听越剧。', payloadCount: 1 };
    },
  };
}

function start(
  composition: ReturnType<typeof createAlgorithmComposition>,
  authority: TrustedSessionAuthority,
  token: string,
) {
  return composition.orchestrator.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: token,
    requestedMode: 'DAILY_CHAT',
  }, authority).opaqueSessionHandle;
}

test('persistent composition restores governed Memory and artifacts into a new session only within authority scope', async () => {
  const saved: AlgorithmCompositionPersistentState[] = [];
  const first = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    conversationPurposes: ['daily_chat'],
    onPersistentStateChange: state => saved.push(state),
  });
  const firstHandle = start(first, AUTHORITY, 'first-session');
  const result = await first.orchestrator.runFinalTurn(firstHandle, {
    schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: 'persistent-source-turn',
    source: 'TYPED_TEXT',
    text: '我平时喜欢听越剧，请整理我的爱好画像。',
    receivedAt: '2026-10-19T08:00:00.000Z',
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.asyncJobs.map(job => [job.kind, job.status]), [
    ['MEMORY', 'success'],
    ['PROFILE', 'success'],
  ]);
  assert.ok(saved.length >= 3, 'evidence, Memory and artifact mutations should reach the backing hook');
  const persistentState = saved.at(-1)!;
  assert.equal(persistentState.referenceStore.records.some(record => record.status === 'ACTIVE'), true);
  assert.equal(persistentState.evidenceStore.activeEvidence.length, 1);
  assert.equal(persistentState.derivedArtifacts.length, 1);
  assert.deepEqual(Object.keys(persistentState).sort(), [
    'derivedArtifacts', 'evidenceStore', 'referenceStore', 'schemaVersion',
  ]);

  const oldEpoch = persistentState.derivedArtifacts[0]!.sessionEpoch;
  const secondSaved: AlgorithmCompositionPersistentState[] = [];
  const second = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    persistentState,
    onPersistentStateChange: state => secondSaved.push(state),
  });
  const secondHandle = start(second, AUTHORITY, 'second-session');
  const secondSession = second.orchestrator.getSessionSnapshot(secondHandle);
  assert.notEqual(secondSession.sessionEpoch, oldEpoch, 'in-flight session state must not be restored');
  assert.equal(second.view(secondHandle).memory.length, 1);
  assert.equal(second.view(secondHandle).artifacts.length, 1);
  assert.deepEqual(second.view(secondHandle).storage, {
    durable: true,
    canonicalWriteCapability: false,
  });
  assert.deepEqual(second.audioFor(result.turnId), [], 'audio must not be included in persistent state');
  assert.throws(() => second.view(firstHandle), /unknown session handle/);

  const otherFamily = start(second, {
    ...AUTHORITY,
    actorId: 'actor-other-family',
    familySpaceId: 'family-persistent-B',
  }, 'other-family');
  assert.equal(second.view(otherFamily).memory.length, 0);
  assert.equal(second.view(otherFamily).artifacts.length, 0);

  const otherAuthorization = start(second, {
    ...AUTHORITY,
    actorId: 'actor-other-authorization',
    authorizationVersion: 'auth-persistent-v2',
  }, 'other-authorization');
  assert.equal(second.view(otherAuthorization).memory.length, 0);
  assert.equal(second.view(otherAuthorization).artifacts.length, 0);

  const readOnlyRestore = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    persistentState,
  });
  const readOnlyHandle = start(readOnlyRestore, AUTHORITY, 'read-only-session');
  assert.equal(readOnlyRestore.view(readOnlyHandle).memory.length, 1);
  assert.equal(readOnlyRestore.view(readOnlyHandle).artifacts.length, 1);
  assert.deepEqual(readOnlyRestore.view(readOnlyHandle).storage, {
    durable: false,
    canonicalWriteCapability: false,
  });
  assert.equal(secondSaved.length, 0, 'restoration alone is not a mutation');
});

test('Reference Store onMutation is optional, constructor-compatible and emits after a real mutation', async () => {
  const states: AlgorithmCompositionPersistentState[] = [];
  const composition = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    onPersistentStateChange: state => states.push(state),
  });
  const handle = start(composition, AUTHORITY, 'reference-source');
  await composition.orchestrator.runFinalTurn(handle, {
    schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: 'reference-source-turn',
    source: 'TYPED_TEXT',
    text: '我平时喜欢听越剧。',
    receivedAt: '2026-10-19T08:30:00.000Z',
  });
  const snapshot = composition.memoryStore.exportSnapshot();
  const active = snapshot.records.find(record => record.status === 'ACTIVE');
  assert.ok(active && active.status !== 'DELETED');

  const mutations: typeof snapshot[] = [];
  const restored = new InMemoryReferenceStore(snapshot, {
    onMutation: state => mutations.push(state),
  });
  assert.equal(mutations.length, 0);
  restored.revoke(active.recordId, {
    actionId: 'reference-revoke',
    actorId: AUTHORITY.actorId,
    actorRole: 'elder',
    occurredAt: '2026-10-19T09:00:00.000Z',
    reasonCode: 'ELDER_WITHDRAWN',
  });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]!.records.find(record => record.recordId === active.recordId)?.status,
    'REVOKED');

  const legacyConstructor = new InMemoryReferenceStore(snapshot);
  assert.equal(legacyConstructor.get(active.recordId)?.status, 'ACTIVE');
});

test('deleting a test-workspace authority removes evidence, Memory and artifacts across restart', async () => {
  let persistentState: AlgorithmCompositionPersistentState | null = null;
  const composition = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    conversationPurposes: ['daily_chat'],
    onPersistentStateChange: state => { persistentState = state; },
  });
  const handle = start(composition, AUTHORITY, 'delete-authority-session');
  const result = await composition.orchestrator.runFinalTurn(handle, {
    schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: 'delete-authority-turn',
    source: 'TYPED_TEXT',
    text: '我平时喜欢听越剧，请整理我的爱好画像。',
    receivedAt: '2026-10-19T10:00:00.000Z',
  });
  assert.equal(result.status, 'completed');
  assert.equal(composition.view(handle).memory.length, 1);
  assert.equal(composition.view(handle).artifacts.length, 1);

  const deleted = await composition.deleteAuthorityContent(AUTHORITY, '2026-10-19T10:05:00.000Z');
  assert.deepEqual(deleted, {
    evidenceCount: 1,
    withdrawnRecordCount: 1,
    invalidatedArtifactCount: 1,
  });
  assert.equal(composition.view(handle).memory.length, 0);
  assert.equal(composition.view(handle).artifacts.length, 0);
  assert.ok(persistentState);
  assert.equal(persistentState!.evidenceStore.activeEvidence.length, 0);
  assert.equal(persistentState!.derivedArtifacts.length, 0);
  assert.equal(persistentState!.referenceStore.records.every(record => record.status === 'DELETED'), true);

  const restored = createAlgorithmComposition({
    provider: provider(),
    derivedPurposes: ['profile_draft'],
    persistentState: persistentState!,
    onPersistentStateChange: () => undefined,
  });
  const restoredHandle = start(restored, AUTHORITY, 'delete-authority-restored-session');
  assert.equal(restored.view(restoredHandle).memory.length, 0);
  assert.equal(restored.view(restoredHandle).artifacts.length, 0);
});
