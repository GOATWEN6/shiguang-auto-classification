import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  GenerationCancellationRegistry,
  type AlgorithmModule,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/index.ts';
import {
  createProfileDraftRuntime,
  createStoryDraftRuntime,
} from '../../../src/lib/derived-artifact-runtime/index.ts';
import {
  InMemoryReferenceStore,
  type MemoryCandidate,
} from '../../../src/lib/memory-runtime/index.ts';
import { createAuditedTextRuntime } from '../../../src/lib/model-runtime/index.ts';

const T0 = '2026-10-03T08:00:00.000Z';
const T1 = '2026-10-03T08:01:00.000Z';
const T2 = '2026-10-03T08:02:00.000Z';
const expectedExecutedIds = [
  'ST01-ORDINARY-SOURCES', 'ST01B-LIFE-EVENT-DETAIL', 'ST02-UNKNOWN-YEAR', 'ST03-PRIVATE-PHOTO', 'ST04-CONFLICT',
  'ST05-BLOCKED-TOPIC', 'ST06-NO-SAVE', 'ST07-SOURCE-CONFLICT', 'ST08-REVOKE-DELETE',
  'PF01-PREFERENCE', 'PF02-EVENT-NOT-TRAIT', 'PF03-RELATION', 'PF04-TEMPORAL',
  'PF05-BLOCKED-TOPIC', 'PF06-PROTECTED-HEALTH', 'PF07-CONFLICT', 'PF08-DELETE',
  'X03-STORY-FAILURE', 'X04-PROFILE-FAILURE',
] as const;
const executedIds = new Set<string>();

after(() => {
  assert.deepEqual([...executedIds].sort(), [...expectedExecutedIds].sort());
});

function mark(id: typeof expectedExecutedIds[number]): void {
  assert.equal(executedIds.has(id), false, `${id} executed more than once`);
  executedIds.add(id);
}

function candidate(
  id: string,
  text: string,
  purpose: 'story_draft' | 'profile_draft',
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate {
  return {
    claimId: id,
    proposalId: `proposal:${id}`,
    subjectId: 'elder-fiction-001',
    familySpaceId: 'family-fiction-001',
    purpose,
    authorizationVersion: 'auth-v1',
    contentType: purpose === 'story_draft' ? 'story_assertion' : 'preference',
    normalizedClaim: text,
    evidenceRefs: [`evidence:${id}`],
    sourceActor: { actorId: 'elder-fiction-001', actorRole: 'elder' },
    eventTime: null,
    validFrom: null,
    validTo: null,
    authorityState: 'ELDER_SELF_ASSERTED',
    conflictState: 'NONE',
    handlingProfile: 'ordinary',
    retentionPolicy: 'long_term',
    importanceReasons: ['fixture'],
    sensitivityLevel: 'S0',
    sensitivityCategories: [],
    disposition: 'AUTO_WRITE',
    confirmationBasis: 'deterministic_business_rule',
    allowedUses: [purpose],
    forbiddenUses: [],
    visibilityScope: ['elder_only'],
    reviewTrigger: 'on_change',
    expiryOrSupersedeRule: 'supersede_on_correction',
    mustNotHappen: [],
    policyVersion: 'memory-policy-v0.2',
    algorithmVersion: 'memory-runtime-v0.2',
    temporalState: 'CURRENT',
    usageStatus: 'ACTIVE',
    relationships: [],
    reasonCodes: ['G4_FIXTURE'],
    writeEligibility: 'ELIGIBLE_FOR_BUSINESS_GATE',
    canonicalWritePerformed: false,
    ...structuredClone(overrides),
  };
}

function activateCandidate(
  store: InMemoryReferenceStore,
  item: MemoryCandidate,
  suffix = item.claimId,
) {
  const submitted = store.submitCandidate(item, {
    operationId: `submit:${suffix}`,
    submittedAt: T0,
  });
  if (item.disposition === 'SOURCED_ONLY') {
    return store.acceptSourced(submitted.recordId, {
      decisionId: `accept:${suffix}`,
      actorId: 'elder-fiction-001',
      actorRole: 'elder',
      acceptedAt: T1,
    });
  }
  return store.approveAutoWrite(submitted.recordId, {
    decisionId: `approve:${suffix}`,
    approved: true,
    deterministic: true,
    policyVersion: item.policyVersion,
    reasonCodes: ['G4_FIXTURE_APPROVAL'],
    decidedAt: T1,
  });
}

function sourceRequest(purpose: 'story_draft' | 'profile_draft', visibilityScope = ['elder_only']) {
  return {
    subjectId: 'elder-fiction-001',
    familySpaceId: 'family-fiction-001',
    purpose,
    authorizationVersion: 'auth-v1',
    visibilityScope,
    mode: 'ORDINARY' as const,
  };
}

function active(
  registry: GenerationCancellationRegistry,
  module: Extract<AlgorithmModule, 'story_draft' | 'profile_draft'>,
  generationId: number,
): RuntimeIdentity {
  const base: RuntimeIdentity = {
    sessionEpoch: 'g4-derived-session',
    turnId: `g4-derived-turn-${generationId}`,
    generationId,
    invocationId: `g4-derived-invocation-${generationId}`,
    evidenceRefs: [`g4-derived-evidence-${generationId}`],
  };
  registry.begin(base, module);
  return registry.bindResponse(base, module, `g4-derived-response-${generationId}`);
}

function storyOutput(
  recordId: string,
  evidenceRefs: string[],
  text: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: '0.3',
    sentences: [{
      sentenceId: 'sentence-1',
      text,
      recordIds: [recordId],
      evidenceRefs,
      claimMode: 'DIRECT',
      uncertainty: 'NONE',
      ...overrides,
    }],
  };
}

function profileOutput(
  recordId: string,
  evidenceRefs: string[],
  path: string,
  value: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: '0.3',
    fields: [{
      fieldId: 'field-1',
      path,
      value,
      temporalScope: 'CURRENT',
      recordIds: [recordId],
      evidenceRefs,
      claimMode: 'DIRECT',
      uncertainty: 'NONE',
      ...overrides,
    }],
  };
}

function auditedJsonRuntime(
  registry: GenerationCancellationRegistry,
  payload: () => string,
) {
  return createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: {
      verify(request) {
        return request.reportedCostCny === 0 ? { costCny: 0 } : null;
      },
    },
    transport: {
      async invoke(request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: request.identity, text: payload() });
          return {
            usage: { inputTokens: 9, outputTokens: 5, totalTokens: 14 },
            costCny: 0,
          };
        });
      },
    },
  });
}

test('ST01-ORDINARY-SOURCES: every sentence keeps governed record/evidence provenance', async () => {
  mark('ST01-ORDINARY-SOURCES');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('story-orchid', '周日去花市看兰花', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 1);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(record.recordId, record.candidate.evidenceRefs, '周日，他去花市看了兰花。', {
      uncertainty: 'UNKNOWN_TIME',
    }),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.artifact.sentences[0].recordIds, [record.recordId]);
  assert.deepEqual(result.artifact.sourceGovernance[0].sourceActor, record.candidate.sourceActor);
  assert.equal(result.canonicalWritePerformed, false);
  assert.equal(registry.accepts(identity, 'story_draft').accepted, false);
});

test('ST01B-LIFE-EVENT-DETAIL: detailed interview facts are eligible story sources', async () => {
  mark('ST01B-LIFE-EVENT-DETAIL');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate(
    'story-life-event-detail', '每天很早到车间打扫机器旁边的地', 'story_draft',
    { contentType: 'life_event_detail' },
  ));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 1001);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(record.recordId, record.candidate.evidenceRefs,
      '那段工作日子里，他每天很早到车间打扫机器旁边的地。'),
  });
  const result = await runtime.run({
    identity, sourceRequest: sourceRequest('story_draft'), noSave: false,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.artifact.sourceRecordIds, [record.recordId]);
});

test('Story runtime lends its owner lease to AuditedTextRuntime without suppressing success', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('story-nested-model', '周日去花市看兰花', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 101);
  let payload = '';
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    async generate(input) {
      payload = JSON.stringify(storyOutput(
        record.recordId,
        record.candidate.evidenceRefs,
        '周日去花市看兰花。',
      ));
      const result = await modelRuntime.runBorrowed({
        module: 'story_draft',
        identity: input.identity,
        attemptId: 'nested-story-attempt',
        requestId: 'nested-story-request',
        prompt: 'render story draft',
      }, input.executionPermit);
      assert.equal(result.status, 'success');
      return JSON.parse(result.text);
    },
  });

  const result = await runtime.run({
    identity,
    sourceRequest: sourceRequest('story_draft'),
    noSave: false,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(registry.accepts(identity, 'story_draft'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('Story cancellation joins an already-entered model sink before finalizing its owner', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate(
    'story-nested-cancel', '周日去花市看兰花', 'story_draft',
  ));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 102);
  let payload = '';
  let markSinkEntered!: () => void;
  let releaseSink!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const sinkRelease = new Promise<void>(resolve => { releaseSink = resolve; });
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    cancellationCleanupTimeoutMs: 200,
    async generate(input) {
      payload = JSON.stringify(storyOutput(
        record.recordId, record.candidate.evidenceRefs, '周日去花市看兰花。',
      ));
      const result = await modelRuntime.runBorrowed({
        module: 'story_draft', identity: input.identity,
        attemptId: 'nested-story-cancel-attempt', requestId: 'nested-story-cancel-request',
        prompt: 'render story draft',
        async onVisibleText(_text, context) {
          markSinkEntered();
          await sinkRelease;
          return context.signal.aborted ? 'DROPPED' : 'COMMITTED';
        },
      }, input.executionPermit);
      assert.equal(result.status, 'cancelled');
      return storyOutput(record.recordId, record.candidate.evidenceRefs, '周日去花市看兰花。');
    },
  });

  const running = runtime.run({
    identity, sourceRequest: sourceRequest('story_draft'), noSave: false,
  });
  let outerSettled = false;
  void running.then(() => { outerSettled = true; }, () => { outerSettled = true; });
  await sinkEntered;
  assert.equal(registry.cancel(identity, 'story_draft', 'user_interrupt'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(outerSettled, false);
  releaseSink();
  const result = await running;
  assert.equal(result.status, 'suppressed');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'JOINED');
});

test('ST02-UNKNOWN-YEAR: a year absent from all cited sources fails closed', async () => {
  mark('ST02-UNKNOWN-YEAR');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('story-unknown-year', '第一次进纺织厂，具体年份不确定', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 2);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(record.recordId, record.candidate.evidenceRefs, '她在1978年第一次进纺织厂。'),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_schema');
});

test('story source uncertainty cannot be flattened into a certain sentence', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate(
    'story-vague-decade',
    '大概是八十年代初，我开始在街道图书室帮忙。',
    'story_draft',
    { temporalState: 'HISTORICAL' },
  ));
  const registry = new GenerationCancellationRegistry();
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      '大概是八十年代初，她开始在街道图书室帮忙。',
      { uncertainty: 'NONE' },
    ),
  });
  const result = await runtime.run({
    identity: active(registry, 'story_draft', 202),
    sourceRequest: sourceRequest('story_draft'),
    noSave: false,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_schema');
});

test('story and profile display text reject internal identifiers', async () => {
  const storyStore = new InMemoryReferenceStore();
  const storyRecord = activateCandidate(storyStore, candidate(
    'story-internal-id', '年轻时在社区学校教过书。', 'story_draft',
  ));
  const storyRegistry = new GenerationCancellationRegistry();
  const story = createStoryDraftRuntime({
    cancellationRegistry: storyRegistry,
    sourceStore: storyStore,
    generate: () => storyOutput(
      storyRecord.recordId,
      storyRecord.candidate.evidenceRefs,
      `fictional-elder-001（${storyRecord.recordId}）年轻时在社区学校教过书。`,
    ),
  });
  const storyResult = await story.run({
    identity: active(storyRegistry, 'story_draft', 203),
    sourceRequest: sourceRequest('story_draft'),
    noSave: false,
  });
  assert.equal(storyResult.status, 'failed');
  assert.equal(storyResult.error.code, 'invalid_schema');

  const profileStore = new InMemoryReferenceStore();
  const profileRecord = activateCandidate(profileStore, candidate(
    'profile-internal-id', '喜欢听越剧。', 'profile_draft',
  ));
  const profileRegistry = new GenerationCancellationRegistry();
  const profile = createProfileDraftRuntime({
    cancellationRegistry: profileRegistry,
    sourceStore: profileStore,
    generate: () => profileOutput(
      profileRecord.recordId,
      profileRecord.candidate.evidenceRefs,
      'preferences.music',
      'subjectId=fictional-elder-001，喜欢听越剧',
    ),
  });
  const profileResult = await profile.run({
    identity: active(profileRegistry, 'profile_draft', 204),
    sourceRequest: sourceRequest('profile_draft'),
    noSave: false,
  });
  assert.equal(profileResult.status, 'failed');
  assert.equal(profileResult.error.code, 'invalid_schema');
});

test('ST03-PRIVATE-PHOTO: source visibility is enforced and preserved in output governance', async () => {
  mark('ST03-PRIVATE-PHOTO');
  const store = new InMemoryReferenceStore();
  const item = candidate('story-private-photo', '1978年婚礼照片', 'story_draft', {
    contentType: 'photo_metadata',
    eventTime: '1978',
    visibilityScope: ['elder_only', 'private_photo'],
  });
  const record = activateCandidate(store, item);
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 3);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(record.recordId, record.candidate.evidenceRefs, '这张照片拍于1978年。'),
  });
  const result = await runtime.run({
    identity,
    sourceRequest: sourceRequest('story_draft', ['elder_only', 'private_photo']),
    noSave: false,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.artifact.sourceGovernance[0].visibilityScope, ['elder_only', 'private_photo']);
});

test('ST04-CONFLICT: ordinary story retrieval cannot flatten an open year conflict', async () => {
  mark('ST04-CONFLICT');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('story-year-conflict', '搬家年份可能是1981或1982', 'story_draft', {
    conflictState: 'OPEN',
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 4);
  let providerCalls = 0;
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { providerCalls += 1; return {}; },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'authorization_withdrawn');
  assert.equal(providerCalls, 0);
});

test('ST05-BLOCKED-TOPIC: must-not-happen surface forms cannot reappear', async () => {
  mark('ST05-BLOCKED-TOPIC');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('story-boat', '老人想讲河边修船', 'story_draft', {
    mustNotHappen: ['旧屋失火'],
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 5);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => storyOutput(record.recordId, record.candidate.evidenceRefs, '老人先讲旧屋失火，再讲修船。'),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_schema');
});

test('ST06-NO-SAVE: no-save performs zero retrieval/generation and yields no artifact', async () => {
  mark('ST06-NO-SAVE');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('story-no-save', '不应进入模型', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 6);
  let providerCalls = 0;
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { providerCalls += 1; return {}; },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: true });
  assert.equal(result.status, 'suppressed');
  assert.equal(result.reason, 'no_save');
  assert.equal(providerCalls, 0);
});

test('ST07-SOURCE-CONFLICT: open conflict is omitted while a safe source remains usable', async () => {
  mark('ST07-SOURCE-CONFLICT');
  const store = new InMemoryReferenceStore();
  const safe = activateCandidate(store, candidate('story-safe', '老人说女儿喜欢京剧', 'story_draft'));
  activateCandidate(store, candidate('story-open-conflict', '女儿说老人不喜欢京剧', 'story_draft', {
    conflictState: 'OPEN',
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 7);
  let seenIds: string[] = [];
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: input => {
      seenIds = input.sources.map(source => source.recordId);
      return storyOutput(safe.recordId, safe.candidate.evidenceRefs, '老人说女儿喜欢京剧。', {
        claimMode: 'DIRECT',
      });
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.deepEqual(seenIds, [safe.recordId]);
});

test('ST08-REVOKE-DELETE: withdrawal anywhere in the exposed bundle blocks commit', async () => {
  mark('ST08-REVOKE-DELETE');
  const store = new InMemoryReferenceStore();
  const first = activateCandidate(store, candidate('story-withdrawn', '合唱队照片', 'story_draft'));
  activateCandidate(store, candidate('story-second', '照片里还有钢琴', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 8);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => {
      store.withdrawEvidence('evidence:story-second', {
        actionId: 'withdraw:story-second', actorId: 'elder-fiction-001', actorRole: 'elder',
        occurredAt: T2, reasonCode: 'OWNER_WITHDRAWAL',
      });
      return storyOutput(first.recordId, first.candidate.evidenceRefs, '这是一张合唱队照片。');
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'authorization_withdrawn');
});

test('PF01-PREFERENCE: an ordinary preference produces only an exact-path sourced draft patch', async () => {
  mark('PF01-PREFERENCE');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('profile-orchid', '喜欢兰花', 'profile_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 9);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => profileOutput(record.recordId, record.candidate.evidenceRefs, 'interests.objects', '兰花'),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.equal(result.artifact.kind, 'DRAFT_PATCH');
  assert.deepEqual(result.artifact.fields[0].recordIds, [record.recordId]);
});

test('Profile runtime lends its owner lease to AuditedTextRuntime without cancelling the draft', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('profile-nested-model', '喜欢兰花', 'profile_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 102);
  let payload = '';
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    async generate(input) {
      payload = JSON.stringify(profileOutput(
        record.recordId,
        record.candidate.evidenceRefs,
        'interests.objects',
        '兰花',
      ));
      const result = await modelRuntime.runBorrowed({
        module: 'profile_draft',
        identity: input.identity,
        attemptId: 'nested-profile-attempt',
        requestId: 'nested-profile-request',
        prompt: 'render profile draft',
      }, input.executionPermit);
      assert.equal(result.status, 'success');
      return JSON.parse(result.text);
    },
  });

  const result = await runtime.run({
    identity,
    sourceRequest: sourceRequest('profile_draft'),
    noSave: false,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(registry.accepts(identity, 'profile_draft'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('Profile cancellation joins an already-entered model sink before finalizing its owner', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate(
    'profile-nested-cancel', '喜欢兰花', 'profile_draft',
  ));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 103);
  let payload = '';
  let markSinkEntered!: () => void;
  let releaseSink!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const sinkRelease = new Promise<void>(resolve => { releaseSink = resolve; });
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    cancellationCleanupTimeoutMs: 200,
    async generate(input) {
      payload = JSON.stringify(profileOutput(
        record.recordId, record.candidate.evidenceRefs, 'interests.objects', '兰花',
      ));
      const result = await modelRuntime.runBorrowed({
        module: 'profile_draft', identity: input.identity,
        attemptId: 'nested-profile-cancel-attempt', requestId: 'nested-profile-cancel-request',
        prompt: 'render profile draft',
        async onVisibleText(_text, context) {
          markSinkEntered();
          await sinkRelease;
          return context.signal.aborted ? 'DROPPED' : 'COMMITTED';
        },
      }, input.executionPermit);
      assert.equal(result.status, 'cancelled');
      return profileOutput(record.recordId, record.candidate.evidenceRefs, 'interests.objects', '兰花');
    },
  });

  const running = runtime.run({
    identity, sourceRequest: sourceRequest('profile_draft'), noSave: false,
  });
  let outerSettled = false;
  void running.then(() => { outerSettled = true; }, () => { outerSettled = true; });
  await sinkEntered;
  assert.equal(registry.cancel(identity, 'profile_draft', 'user_interrupt'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(outerSettled, false);
  releaseSink();
  const result = await running;
  assert.equal(result.status, 'suppressed');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'JOINED');
});

test('PF02-EVENT-NOT-TRAIT: a single life event is not eligible as a profile source', async () => {
  mark('PF02-EVENT-NOT-TRAIT');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('profile-single-event', '第一次进入纺织厂', 'profile_draft', {
    contentType: 'life_event',
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 10);
  let providerCalls = 0;
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { providerCalls += 1; return {}; },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(providerCalls, 0);
});

test('PF03-RELATION: a private relationship field preserves source visibility and attribution', async () => {
  mark('PF03-RELATION');
  const store = new InMemoryReferenceStore();
  const item = candidate('profile-relation', '家人说老人是合唱队成员', 'profile_draft', {
    contentType: 'photo_person_relation',
    authorityState: 'SOURCED_CLAIM',
    sourceActor: { actorId: 'family-fiction-001', actorRole: 'family' },
    disposition: 'SOURCED_ONLY',
    confirmationBasis: 'sourced_acceptance',
    writeEligibility: 'NOT_ELIGIBLE',
    visibilityScope: ['elder_only', 'private_photo'],
  });
  const record = activateCandidate(store, item);
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 11);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => profileOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      'relationships.socialRole',
      '曾是合唱队成员',
      { claimMode: 'ATTRIBUTED', uncertainty: 'SOURCE_ATTRIBUTION' },
    ),
  });
  const result = await runtime.run({
    identity,
    sourceRequest: sourceRequest('profile_draft', ['elder_only', 'private_photo']),
    noSave: false,
  });
  assert.equal(result.status, 'success');
  assert.equal(result.artifact.sourceGovernance[0].attributedOnly, true);
  assert.deepEqual(result.artifact.sourceGovernance[0].visibilityScope, ['elder_only', 'private_photo']);
  assert.deepEqual(result.artifact.fields[0].attribution, {
    kind: 'SOURCE_ACTORS',
    sources: [{
      recordId: record.recordId,
      sourceActor: { actorId: 'family-fiction-001', actorRole: 'family' },
    }],
  });
});

test('an attributed-only generator cannot supply or relabel attribution free text', async () => {
  const store = new InMemoryReferenceStore();
  const item = candidate('profile-attribution-forgery', '家人说老人曾参加合唱队', 'profile_draft', {
    contentType: 'photo_person_relation',
    authorityState: 'SOURCED_CLAIM',
    sourceActor: { actorId: 'family-fiction-002', actorRole: 'family' },
    disposition: 'SOURCED_ONLY',
    confirmationBasis: 'sourced_acceptance',
    writeEligibility: 'NOT_ELIGIBLE',
  });
  const record = activateCandidate(store, item);
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 20);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => profileOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      'relationships.socialRole',
      '曾参加合唱队',
      {
        claimMode: 'ATTRIBUTED',
        uncertainty: 'SOURCE_ATTRIBUTION',
        attribution: '老人亲口确认',
      },
    ),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_schema');
});

test('PF04-TEMPORAL: ended preferences cannot be flattened into CURRENT profile state', async () => {
  mark('PF04-TEMPORAL');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('profile-historical-routine', '在纺织厂阶段习惯早起', 'profile_draft', {
    contentType: 'routine', validFrom: '1978', validTo: '1998', temporalState: 'PAST_INTERVAL',
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 12);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => profileOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      'lifeStageRoutines.historical',
      '在纺织厂阶段习惯早起',
      { temporalScope: 'LIFE_STAGE' },
    ),
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.equal(result.artifact.fields[0].temporalScope, 'LIFE_STAGE');
  assert.equal(result.artifact.sourceGovernance[0].validTo, '1998');
});

test('PAST_INTERVAL remains historical when validTo is absent', async () => {
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate(
    'profile-past-interval-no-end',
    '在纺织厂阶段习惯早起',
    'profile_draft',
    { contentType: 'routine', validFrom: '1978', validTo: null, temporalState: 'PAST_INTERVAL' },
  ));

  const currentRegistry = new GenerationCancellationRegistry();
  const currentIdentity = active(currentRegistry, 'profile_draft', 21);
  const currentRuntime = createProfileDraftRuntime({
    cancellationRegistry: currentRegistry,
    sourceStore: store,
    generate: () => profileOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      'lifeStageRoutines.current',
      '习惯早起',
      { temporalScope: 'CURRENT' },
    ),
  });
  const currentResult = await currentRuntime.run({
    identity: currentIdentity,
    sourceRequest: sourceRequest('profile_draft'),
    noSave: false,
  });
  assert.equal(currentResult.status, 'failed');
  assert.equal(currentResult.error.code, 'invalid_schema');

  const historicalRegistry = new GenerationCancellationRegistry();
  const historicalIdentity = active(historicalRegistry, 'profile_draft', 22);
  const historicalRuntime = createProfileDraftRuntime({
    cancellationRegistry: historicalRegistry,
    sourceStore: store,
    generate: () => profileOutput(
      record.recordId,
      record.candidate.evidenceRefs,
      'lifeStageRoutines.historical',
      '在纺织厂阶段习惯早起',
      { temporalScope: 'LIFE_STAGE' },
    ),
  });
  const historicalResult = await historicalRuntime.run({
    identity: historicalIdentity,
    sourceRequest: sourceRequest('profile_draft'),
    noSave: false,
  });
  assert.equal(historicalResult.status, 'success');
  assert.equal(historicalResult.artifact.fields[0].temporalScope, 'LIFE_STAGE');
});

test('PF05-BLOCKED-TOPIC: forbidden-use sources never enter the profile provider bundle', async () => {
  mark('PF05-BLOCKED-TOPIC');
  const store = new InMemoryReferenceStore();
  const safe = activateCandidate(store, candidate('profile-safe-topic', '喜欢听京剧', 'profile_draft'));
  activateCandidate(store, candidate('profile-forbidden-topic', '不愿谈旧屋失火', 'profile_draft', {
    forbiddenUses: ['profile_draft'],
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 13);
  let seenIds: string[] = [];
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: input => {
      seenIds = input.sources.map(source => source.recordId);
      return profileOutput(safe.recordId, safe.candidate.evidenceRefs, 'preferences.music', '京剧');
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.deepEqual(seenIds, [safe.recordId]);
});

test('PF06-PROTECTED-HEALTH: S2 input and protected nested output both fail closed', async () => {
  mark('PF06-PROTECTED-HEALTH');
  const store = new InMemoryReferenceStore();
  const safe = activateCandidate(store, candidate('profile-safe-health-control', '喜欢兰花', 'profile_draft'));
  activateCandidate(store, candidate('profile-hidden-health', '模型猜测认知下降', 'profile_draft', {
    sensitivityLevel: 'S2', sensitivityCategories: ['health_or_cognitive'],
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 14);
  let seenIds: string[] = [];
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: input => {
      seenIds = input.sources.map(source => source.recordId);
      return profileOutput(
        safe.recordId,
        safe.candidate.evidenceRefs,
        'preferences.activities.health.cognitiveStatus',
        '认知下降',
      );
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.deepEqual(seenIds, [safe.recordId]);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_schema');
});

test('obfuscated protected material mislabeled S0 is blocked before generation', async () => {
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate(
    'profile-obfuscated-credential',
    '银 行／密—码是1234',
    'profile_draft',
    { sensitivityLevel: 'S0', sensitivityCategories: [] },
  ));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 23);
  let providerCalls = 0;
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => {
      providerCalls += 1;
      return {};
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'authorization_withdrawn');
  assert.equal(providerCalls, 0);
});

test('variation selectors, combining marks and traditional credential aliases are blocked before generation', async () => {
  const variants = [
    '银\uFE0F行密\uFE0F码1234',
    '银\u0301行密\u0301码1234',
    '銀行／密碼是1234',
    '帳\uFE0F號和密\u0301碼不可外传',
  ];

  for (const [index, text] of variants.entries()) {
    const store = new InMemoryReferenceStore();
    activateCandidate(store, candidate(
      `profile-unicode-credential-${index}`,
      text,
      'profile_draft',
      { sensitivityLevel: 'S0', sensitivityCategories: [] },
    ));
    const registry = new GenerationCancellationRegistry();
    const identity = active(registry, 'profile_draft', 120 + index);
    let providerCalls = 0;
    const runtime = createProfileDraftRuntime({
      cancellationRegistry: registry,
      sourceStore: store,
      generate: () => {
        providerCalls += 1;
        return {};
      },
    });
    const result = await runtime.run({
      identity,
      sourceRequest: sourceRequest('profile_draft'),
      noSave: false,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'authorization_withdrawn');
    assert.equal(providerCalls, 0);
  }
});

test('PF07-CONFLICT: ordinary profile retrieval omits open family-source conflicts', async () => {
  mark('PF07-CONFLICT');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('profile-open-conflict', '老人喜欢京剧，但家人说不喜欢', 'profile_draft', {
    conflictState: 'OPEN',
  }));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 15);
  let providerCalls = 0;
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { providerCalls += 1; return {}; },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(providerCalls, 0);
});

test('PF08-DELETE: deletion during generation invalidates the complete bundle before commit', async () => {
  mark('PF08-DELETE');
  const store = new InMemoryReferenceStore();
  const record = activateCandidate(store, candidate('profile-delete', '喜欢合唱活动', 'profile_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 16);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => {
      store.delete(record.recordId, {
        actionId: 'delete:profile-delete', actorId: 'elder-fiction-001', actorRole: 'elder',
        occurredAt: T2, reasonCode: 'OWNER_DELETE',
      });
      return profileOutput(record.recordId, record.candidate.evidenceRefs, 'preferences.activities', '合唱');
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'authorization_withdrawn');
});

test('bundle snapshot ignores newly authorized unexposed sources', async () => {
  const store = new InMemoryReferenceStore();
  const exposed = activateCandidate(store, candidate('story-snapshot-exposed', '老人喜欢在河边散步', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 24);
  let exposedIds: string[] = [];
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: input => {
      exposedIds = input.sources.map(source => source.recordId);
      activateCandidate(store, candidate('story-snapshot-added', '老人也喜欢逛花市', 'story_draft'));
      return storyOutput(exposed.recordId, exposed.candidate.evidenceRefs, '老人喜欢在河边散步。');
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'success');
  assert.deepEqual(exposedIds, [exposed.recordId]);
  assert.deepEqual(result.artifact.sourceRecordIds, [exposed.recordId]);
});

test('bundle snapshot rejects correction of an exposed source before commit', async () => {
  const store = new InMemoryReferenceStore();
  const exposed = activateCandidate(store, candidate('story-snapshot-corrected', '老人喜欢在河边散步', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 25);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => {
      const corrected = structuredClone(exposed.candidate);
      corrected.normalizedClaim = '老人更正为只在公园散步';
      corrected.confirmationBasis = 'explicit_item';
      corrected.reasonCodes = [...corrected.reasonCodes, 'ELDER_EXPLICIT_CORRECTION'];
      store.correct(
        exposed.recordId,
        corrected,
        {
          decisionId: 'correct:story-snapshot-corrected',
          approved: true,
          deterministic: true,
          policyVersion: corrected.policyVersion,
          reasonCodes: ['ELDER_EXPLICIT_CORRECTION'],
          decidedAt: T2,
        },
        { operationId: 'operation:story-snapshot-corrected', submittedAt: T2 },
      );
      return storyOutput(exposed.recordId, exposed.candidate.evidenceRefs, '老人喜欢在河边散步。');
    },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'authorization_withdrawn');
});

test('X03-STORY-FAILURE: story provider failure is redacted, module-local and source-immutable', async () => {
  mark('X03-STORY-FAILURE');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('story-isolation', '获准故事来源', 'story_draft'));
  const before = store.exportSnapshot();
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 17);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { throw new Error('secret provider stack and prompt'); },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'story generation failed');
  assert.deepEqual(store.exportSnapshot(), before);
});

test('X04-PROFILE-FAILURE: profile provider failure is redacted, module-local and source-immutable', async () => {
  mark('X04-PROFILE-FAILURE');
  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('profile-isolation', '获准画像来源', 'profile_draft'));
  const before = store.exportSnapshot();
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'profile_draft', 18);
  const runtime = createProfileDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    generate: () => { throw new Error('secret provider stack and prompt'); },
  });
  const result = await runtime.run({ identity, sourceRequest: sourceRequest('profile_draft'), noSave: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'profile generation failed');
  assert.deepEqual(store.exportSnapshot(), before);
});

test('derived runtime rejects generic lookalike stores and cancellation wins over a hung generator', async () => {
  assert.throws(() => createStoryDraftRuntime({
    cancellationRegistry: new GenerationCancellationRegistry(),
    sourceStore: { retrieve: () => [], isRecordUsable: () => true } as any,
    generate: () => ({}),
  }), /governed InMemoryReferenceStore/);

  const store = new InMemoryReferenceStore();
  activateCandidate(store, candidate('story-hung', '获准故事来源', 'story_draft'));
  const registry = new GenerationCancellationRegistry();
  const identity = active(registry, 'story_draft', 19);
  const runtime = createStoryDraftRuntime({
    cancellationRegistry: registry,
    sourceStore: store,
    cancellationCleanupTimeoutMs: 10,
    generate: () => new Promise(() => {}),
  });
  const running = runtime.run({ identity, sourceRequest: sourceRequest('story_draft'), noSave: false });
  await Promise.resolve();
  assert.equal(registry.cancel(identity, 'story_draft', 'user_cancelled'), true);
  const result = await Promise.race([
    running,
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50)),
  ]);
  assert.notEqual(result, 'timeout');
  if (result === 'timeout') throw new Error('hung derived provider did not cancel');
  assert.equal(result.status, 'suppressed');
  assert.equal(result.cancellationCleanupStatus, 'TIMED_OUT');
});
