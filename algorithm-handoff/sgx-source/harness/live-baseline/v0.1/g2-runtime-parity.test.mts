import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDirectionPlan,
  decideInterviewNextAction,
  decideInterviewNextActionWithContinuation,
  INTERVIEW_CONTINUATION_POLICY_VERSION,
} from '../../../src/lib/interview-policy/index.ts';
import {
  assertDirectionPlan,
  assertPlanState,
  decideFrozenCompatibilityNextAction as decideRuntimeCandidateNextAction,
  directionPlanIdFor,
} from '../../../src/lib/interview-policy/internal.ts';
import {
  extractHybridCandidates,
  hybridExtractorMetadata,
  runHybridCase,
  evaluateMemoryPolicy,
  inspectMemoryTransaction,
  runCase as runRuntimeMemoryCase,
  type EvidenceFragment,
  type MemoryPolicyContext,
  type MemoryTransactionInput,
} from '../../../src/lib/memory-runtime/index.ts';
import { decideCandidateNextAction as rawDecideFrozenInterviewNextAction } from '../../oss-p0/interview/v0.2/candidate.mjs';
import { runCase as rawRunFrozenMemoryCase } from '../../oss-p0/memory/baseline.mjs';
import { cases as rawCases, corpusMetadata as rawCorpusMetadata } from '../../oss-p0/memory/cases.mjs';
import { validateAdapterOutput as rawValidateAdapterOutput } from '../../oss-p0/memory/schema-validation.mjs';
import {
  createMockSemanticProvider as rawCreateMockSemanticProvider,
  semanticProposal as rawSemanticProposal,
} from '../../oss-p0/memory/hybrid-v0.2/mock-semantic-provider.mjs';

// Frozen harness files are JavaScript artifacts. These local adapters keep the
// strict TypeScript boundary explicit without weakening production types.
const decideFrozenInterviewNextAction = rawDecideFrozenInterviewNextAction as (request: any) => any;
const runFrozenMemoryCase = rawRunFrozenMemoryCase as (input: any) => Promise<any>;
const cases = rawCases as unknown as any[];
const corpusMetadata = rawCorpusMetadata as any;
const validateAdapterOutput = rawValidateAdapterOutput as (output: unknown) => { valid: boolean; errors?: unknown[] };
const createMockSemanticProvider = rawCreateMockSemanticProvider as (proposals: any[]) => any;
const semanticProposal = rawSemanticProposal as (input: any) => any;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const INTERVIEW_V02_DIR = path.join(REPO_ROOT, 'harness/oss-p0/interview/v0.2');

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function interviewFixtures() {
  const original = readJson(path.join(REPO_ROOT, 'harness/oss-p0/interview/cases.json')).cases;
  const heldOut = readJson(path.join(REPO_ROOT, 'harness/oss-p0/interview/held-out/cases.json')).cases;
  const runtime = readJson(path.join(INTERVIEW_V02_DIR, 'runtime-contract-cases.json')).cases;
  return { original, heldOut, runtime };
}

function sanitizedMemoryInput(testCase: any) {
  return structuredClone({
    caseId: testCase.caseId,
    fixtureVersion: testCase.fixtureVersion,
    policyVersion: testCase.policyVersion,
    ...testCase.input,
  });
}

function sameSet(left: unknown, right: unknown) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((item, index) => item === b[index]);
}

function evidenceMatchesScope(item: any, policy: any) {
  return item.subjectId === policy.subjectId
    && item.useStatus === 'ACTIVE'
    && item.familySpaceId === policy.familySpaceId
    && (item.allowedPurposes.includes('*') || item.allowedPurposes.includes(policy.purpose))
    && (item.authorizationVersion === '*' || item.authorizationVersion === policy.authorizationVersion)
    && (item.visibilityScope.includes('*') || policy.visibilityScope.every((scope: string) => item.visibilityScope.includes(scope)));
}

function baseDirectionInput(): any {
  return {
    program: {
      schemaVersion: '0.1',
      programId: 'owner-program',
      version: 'owner-program-v1',
      allowedGoalTypes: ['life_review', 'family_archive'],
      allowedOutputTypes: ['private_notes', 'family_story'],
      topics: [
        { topicId: 'work', title: '第一次参加工作', goalTypes: ['life_review'] },
        { topicId: 'family', title: '家里的重要时刻', goalTypes: ['family_archive'] },
      ],
      redLines: ['elder_current_will_first'],
      qualityPriorities: ['one_question_at_a_time'],
    },
    sessionPlan: {
      schemaVersion: '0.1',
      sessionPlanId: 'session-plan-fixture-001',
      programId: 'owner-program',
      programVersion: 'owner-program-v1',
      sessionEpoch: 'epoch-fixture-001',
      consent: { status: 'EXPLICIT', evidenceRef: 'turn:fixture:consent' },
      goalTypes: ['life_review'],
      outputTypes: ['private_notes'],
      guidanceMode: 'FOLLOW_USER',
      burdenBudget: { maxMinutes: 20, maxQuestions: 8, maxFollowUpDepth: 2 },
      authorizationVersion: 'auth-v1',
      memorySnapshotId: null,
    },
    state: {
      schemaVersion: '0.1',
      planVersion: 1,
      sessionEpoch: 'epoch-fixture-001',
      turnId: 'turn-fixture-001',
      currentTopicId: 'work',
      openLeadIds: [],
      topicLedger: [],
      resumeTopicId: null,
    },
    elderDirection: 'NONE',
    elderRequestedTopicId: null,
    uncertainty: 'MEDIUM',
    selectedTopicId: 'work',
    candidateTopicIds: ['work', 'family'],
    evidenceRefs: [],
    reasonCodes: ['PLANNER_CANDIDATE'],
  };
}

function elderDirectionEvidence(sessionEpoch = 'epoch-fixture-001', turnId = 'turn-fixture-001') {
  return {
    ref: `turn:${turnId}:elder`,
    purpose: 'elder current direction',
    kind: 'ELDER_TURN',
    sessionEpoch,
    turnId,
  };
}

test('Interview v0.2 freeze manifest contains exactly seven intact artifacts', () => {
  const manifest = readJson(path.join(INTERVIEW_V02_DIR, 'manifest.json'));
  assert.equal(manifest.artifacts.length, 7);
  assert.deepEqual(manifest.evaluation.denominators, {
    original: 36,
    heldOut: 16,
    total: 52,
    runtimeContractProbes: 2,
  });
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(REPO_ROOT, artifact.path);
    assert.equal(fs.existsSync(artifactPath), true, `missing frozen artifact ${artifact.path}`);
    assert.equal(sha256(artifactPath), artifact.sha256, `freeze hash drifted: ${artifact.path}`);
  }
});

test('Interview runtime preserves v0.2 frozen behavior on 53 inputs and an explicit owner-approved I-034 version delta', () => {
  const { original, heldOut, runtime } = interviewFixtures();
  assert.equal(original.length, 36);
  assert.equal(heldOut.length, 16);
  assert.equal(runtime.length, 2);

  let exactParityCount = 0;
  const versionDeltaIds: string[] = [];
  for (const fixture of [...original, ...heldOut, ...runtime]) {
    const expected = decideFrozenInterviewNextAction({ input: structuredClone(fixture.input) });
    const actual = decideRuntimeCandidateNextAction({ input: structuredClone(fixture.input) });
    if (fixture.id !== 'I-034') {
      assert.deepEqual(actual, expected, `InterviewPolicy frozen behavior drifted for ${fixture.id}`);
      exactParityCount += 1;
      continue;
    }

    // The internal compatibility export currently shares the upgraded reducer.
    // Preserve the immutable v0.2 result and audit this one intentional delta;
    // this is not a claim that all 54 current outputs still equal v0.2.
    versionDeltaIds.push(fixture.id);
    assert.equal(expected.interviewAction, fixture.expected.interviewAction);
    assert.equal(expected.interviewAction, 'OFFER_TOPIC');
    assert.deepEqual(expected.utterancePlan, {
      intent: '收住细节追问并回到开放提纲',
      suggestedText: '这段线索我们先收住，接下来可以换个轻松的话题。',
      questionCount: 0,
      mustAvoid: ['把推测说成事实', '一次提出多个问题', '使用未获准的 Memory', '暂停整个访谈', '强迫继续原细节'],
    });
    assert.equal(actual.interviewAction, 'CLARIFY');
    assert.deepEqual(actual.utterancePlan, {
      intent: '在自然停顿处询问老人是否继续当前线索',
      suggestedText: '第一次工作这段先停在这里也可以。您还愿意继续讲吗，还是今天先到这里？',
      questionCount: 1,
      mustAvoid: ['把推测说成事实', '一次提出多个问题', '使用未获准的 Memory', '擅自换题', '擅自结束访谈', '连续追加问题'],
    });

    const { interviewAction: _frozenAction, utterancePlan: _frozenUtterance,
      obligations: frozenObligations, ...frozenUnchanged } = expected;
    const { interviewAction: _currentAction, utterancePlan: _currentUtterance,
      obligations: currentObligations, ...currentUnchanged } = actual;
    assert.deepEqual(currentUnchanged, frozenUnchanged, 'I-034 may only change the approved interview move');
    assert.deepEqual(currentObligations, frozenObligations.map((item: any) => item.id === 'INTERVIEW_MOVE'
      ? { ...item, operation: 'CLARIFY' } : item), 'I-034 control, authority and source obligations must remain intact');
  }
  assert.equal(exactParityCount, 53);
  assert.deepEqual(versionDeltaIds, ['I-034']);
});

test('live Interview v0.3.5 reflects new I-034 content instead of stopping at a fixed follow-up count', () => {
  const fixture = interviewFixtures().original.find((item: any) => item.id === 'I-034');
  assert.ok(fixture);
  const input = structuredClone(fixture.input);
  input.sessionEpoch = 'epoch-live-natural-pause';
  input.runtime.sessionEpoch = input.sessionEpoch;
  input.runtime.generationId = 9;
  const identity = {
    sessionEpoch: input.sessionEpoch,
    turnId: 'turn-live-natural-pause',
    generationId: 9,
    invocationId: 'invocation-live-natural-pause',
    evidenceRefs: [input.asr.ref],
  };
  const actual = decideInterviewNextActionWithContinuation({ input, identity });
  assert.equal(INTERVIEW_CONTINUATION_POLICY_VERSION, 'interview-policy-v0.3.5');
  assert.notDeepEqual(actual, decideInterviewNextAction({ input, identity }));
  assert.equal(actual.mode, 'FORMAL_INTERVIEW');
  assert.equal(actual.interactionAction, 'NONE');
  assert.equal(actual.interviewAction, 'ACKNOWLEDGE');
  assert.deepEqual(actual.reasonCodes, ['REFLECTIVE_LISTENING_TURN']);
  assert.equal(actual.utterancePlan.suggestedText, '我听着呢，您把这段慢慢说完。');
  assert.equal(actual.utterancePlan.questionCount, 0);
  assert.deepEqual(actual.statePatch, {}, 'a listening turn must not change topic or session status');
  assert.deepEqual(actual.obligations, [
    { id: 'AUTHORITY_BOUNDARY', plane: 'AUTHORITY', operation: 'CANDIDATES_ONLY', sourceRefs: [] },
    { id: 'INTERVIEW_MOVE', plane: 'INTERVIEW', operation: 'ACKNOWLEDGE', sourceRefs: [input.asr.ref] },
  ]);
  assert.equal(actual.retentionControl.intent, 'DEFAULT');
  assert.equal(actual.runtimeControl.delivery.mode, 'EMIT');
  assert.equal(actual.runtimeControl.generation.cancelRequested, false);
  assert.deepEqual(actual.memoryCandidates, []);
  assert.deepEqual(actual.storyCandidateRefs, []);
});

test('content-bearing holiday and reunion turns are never replaced by a continue-or-rest checkpoint', () => {
  for (const [index, text] of ['今天过重阳节见到了很多朋友', '我们好久没见了'].entries()) {
    const fixture = interviewFixtures().original.find((item: any) => item.id === 'I-034');
    assert.ok(fixture);
    const input = structuredClone(fixture.input);
    input.asr.text = text;
    input.asr.ref = `turn-content-${index}`;
    input.sessionEpoch = `epoch-content-${index}`;
    input.runtime.sessionEpoch = input.sessionEpoch;
    input.runtime.generationId = index + 1;
    const action = decideInterviewNextActionWithContinuation({ input, identity: {
      sessionEpoch: input.sessionEpoch, turnId: `turn-${index}`, generationId: index + 1,
      invocationId: `invocation-${index}`, evidenceRefs: [input.asr.ref],
    } });
    assert.equal(action.interviewAction, 'ACKNOWLEDGE');
    assert.equal(action.utterancePlan.questionCount, 0);
    assert.doesNotMatch(action.utterancePlan.suggestedText, /继续讲|先到这里|先休息/u);
  }
});

test('a memory gap after a question gets a listening turn unless the elder explicitly requests a cue', () => {
  const fixture = interviewFixtures().original.find((item: any) => item.id === 'I-034');
  assert.ok(fixture);
  const decide = (text: string, suffix: string) => {
    const input = structuredClone(fixture.input);
    input.asr.text = text;
    input.asr.ref = `turn-memory-gap-${suffix}`;
    input.followUpDepth = 1;
    input.sessionEpoch = `epoch-memory-gap-${suffix}`;
    input.runtime.sessionEpoch = input.sessionEpoch;
    input.runtime.generationId = 20;
    return decideInterviewNextActionWithContinuation({ input, identity: {
      sessionEpoch: input.sessionEpoch,
      turnId: `turn-memory-gap-${suffix}`,
      generationId: 20,
      invocationId: `invocation-memory-gap-${suffix}`,
      evidenceRefs: [input.asr.ref],
    } });
  };

  const uncertainty = decide('具体哪一年我记不清了，大概是九十年代。', 'listen');
  assert.equal(uncertainty.interviewAction, 'ACKNOWLEDGE');
  assert.equal(uncertainty.utterancePlan.questionCount, 0);
  assert.deepEqual(uncertainty.reasonCodes, ['REFLECTIVE_LISTENING_TURN']);

  const requestedCue = decide('我记不清了，给我一个简单的提示。', 'cue');
  assert.equal(requestedCue.interviewAction, 'OFFER_TOPIC');
  assert.equal(requestedCue.utterancePlan.questionCount, 1);
  assert.ok(requestedCue.reasonCodes.includes('REQUESTED_CUES'));
});

test('public Interview package exports only the live decision boundary, not the frozen compatibility reducer', async () => {
  const publicApi = await import('../../../src/lib/interview-policy/index.ts');
  assert.equal('decideInterviewNextAction' in publicApi, true);
  assert.equal('decideCandidateNextAction' in publicApi, false);
  assert.equal('decideFrozenCompatibilityNextAction' in publicApi, false);
  assert.equal('assertDirectionPlan' in publicApi, false);
  assert.equal('directionPlanIdFor' in publicApi, false);
  assert.equal('assertInterviewNextAction' in publicApi, false);
  assert.equal('assertLiveInterviewDecisionRequest' in publicApi, false);
});

test('live Interview entrypoint fails closed on missing or mismatched runtime identity', () => {
  const fixture = interviewFixtures().original[2];
  const input = structuredClone(fixture.input);
  input.sessionEpoch = 'epoch-live-fixture';
  input.runtime.sessionEpoch = 'epoch-live-fixture';
  input.runtime.generationId = 7;
  const identity = {
    sessionEpoch: 'epoch-live-fixture',
    turnId: 'turn-live-fixture',
    generationId: 7,
    invocationId: 'invocation-live-fixture',
    evidenceRefs: input.asr.ref ? [input.asr.ref] : [],
  };
  assert.deepEqual(
    decideInterviewNextAction({ input, identity }),
    decideRuntimeCandidateNextAction({ input }),
  );
  assert.throws(() => decideInterviewNextAction({ input } as any), /identity/);
  assert.throws(
    () => decideInterviewNextAction({ input, identity: { ...identity, generationId: 8 } }),
    /generationId/,
  );
});

test('live Interview rejects active-session stale provider responses before reducer delivery', () => {
  const fixture = interviewFixtures().original[2];
  const input = structuredClone(fixture.input);
  input.sessionEpoch = 'epoch-live-current';
  input.runtime.sessionEpoch = 'epoch-live-current';
  input.runtime.generationId = 2;
  input.incomingEvent = {
    type: 'PROVIDER_RESPONSE',
    ref: 'provider:stale',
    sessionEpoch: 'epoch-live-old',
    generationId: 1,
  };
  const identity = {
    sessionEpoch: 'epoch-live-current',
    turnId: 'turn-live-current',
    generationId: 2,
    invocationId: 'invocation-live-current',
    evidenceRefs: [input.asr.ref, input.incomingEvent.ref].filter(Boolean),
  };
  assert.throws(() => decideInterviewNextAction({ input, identity }), /incomingEvent\.sessionEpoch/);

  input.incomingEvent.sessionEpoch = 'epoch-live-current';
  assert.throws(() => decideInterviewNextAction({ input, identity }), /incomingEvent\.generationId/);

  delete input.incomingEvent.sessionEpoch;
  delete input.incomingEvent.generationId;
  assert.throws(() => decideInterviewNextAction({ input, identity }), /input\.incomingEvent\.sessionEpoch/);
});

test('live Interview requires every ASR, UI, runtime, provider and Memory evidence ref in the identity allowlist', () => {
  const fixture = interviewFixtures().original[2];
  const input = structuredClone(fixture.input);
  input.sessionEpoch = 'epoch-live-evidence';
  input.runtime.sessionEpoch = 'epoch-live-evidence';
  input.runtime.generationId = 3;
  input.runtime.ref = 'runtime:network';
  input.uiEvent = { type: 'END_BUTTON', ref: 'ui:end' };
  input.memoryRefs = [{
    ref: 'memory:allowed',
    source: 'reference-store',
    text: '老人喜欢听越剧。',
    allowedForInterview: true,
  }];
  const identity = {
    sessionEpoch: 'epoch-live-evidence',
    turnId: 'turn-live-evidence',
    generationId: 3,
    invocationId: 'invocation-live-evidence',
    evidenceRefs: [input.asr.ref].filter(Boolean),
  };
  assert.throws(() => decideInterviewNextAction({ input, identity }), /runtime\.ref|uiEvent\.ref|memoryRefs/);

  identity.evidenceRefs.push(input.runtime.ref, input.uiEvent.ref, input.memoryRefs[0].ref);
  assert.equal(decideInterviewNextAction({ input, identity }).interactionAction, 'END');
});

test('live Interview requires non-empty evidence for ASR and every decision-affecting runtime signal', () => {
  const fixture = interviewFixtures().original[2];
  const baseInput = structuredClone(fixture.input);
  baseInput.sessionEpoch = 'epoch-live-required-ref';
  baseInput.runtime.sessionEpoch = 'epoch-live-required-ref';
  baseInput.runtime.generationId = 4;
  const identity = {
    sessionEpoch: 'epoch-live-required-ref',
    turnId: 'turn-live-required-ref',
    generationId: 4,
    invocationId: 'invocation-live-required-ref',
    evidenceRefs: [] as string[],
  };

  for (const missingRef of ['', null]) {
    const input = structuredClone(baseInput);
    input.asr.status = 'FINAL';
    input.asr.text = '继续问';
    input.asr.ref = missingRef;
    assert.throws(() => decideInterviewNextAction({ input, identity }), /input\.asr\.ref/);
  }

  const runtimeSignals = [
    (input: any) => { input.runtime.network = 'OFFLINE'; },
    (input: any) => { input.runtime.provider = 'TIMEOUT'; },
    (input: any) => { input.runtime.vad = 'SPEAKING'; },
    (input: any) => { input.runtime.tts = 'PLAYING'; },
    (input: any) => { input.runtime.silenceSeconds = 8; },
    (input: any) => { input.runtime.waitPreferenceSeconds = 5; },
  ];
  for (const applySignal of runtimeSignals) {
    const input = structuredClone(baseInput);
    input.asr.status = 'NONE';
    input.asr.text = '';
    input.asr.ref = null;
    input.runtime.ref = null;
    applySignal(input);
    assert.throws(() => decideInterviewNextAction({ input, identity }), /input\.runtime\.ref/);
  }
});

test('DirectionPlan remains a planner contract and does not acquire canonical-memory authority', () => {
  const input = baseDirectionInput();
  input.elderDirection = 'CONTINUE';
  input.uncertainty = 'LOW';
  input.selectedTopicId = 'family';
  input.evidenceRefs = [elderDirectionEvidence()];
  input.reasonCodes = ['USER_CURRENT_WILL'];
  const plan = createDirectionPlan(input);
  assert.equal(assertDirectionPlan(plan), plan);
  assert.equal(plan.schemaVersion, '0.1');
  assert.equal(plan.uncertainty, 'LOW');
  assert.equal(plan.selectedTopicId, 'work');
  assert.equal('canonicalWrite' in plan, false);
  assert.equal('canonicalMemory' in plan, false);
  assert.deepEqual(plan.authorityBoundary, {
    canProposeTopic: true,
    canPersistMemory: false,
    canEndSession: false,
    canGenerateUtterance: false,
  });
  const missingUncertainty = structuredClone(plan) as any;
  delete missingUncertainty.uncertainty;
  assert.throws(() => assertDirectionPlan(missingUncertainty), /uncertainty/);
  assert.throws(() => assertPlanState({
    schemaVersion: '0.1',
    planVersion: 1,
    sessionEpoch: 'epoch-fixture-001',
    turnId: 'turn-fixture-001',
    currentTopicId: 'work',
    openLeadIds: [],
    topicLedger: [{ topicId: 'work', status: 'OPEN', sourceRefs: ['turn:fixture:user'] }],
    resumeTopicId: null,
  }), /scope/);
});

test('DirectionPlan enforces Program goal/output allowlists and topic-goal compatibility', () => {
  const invalidGoal = baseDirectionInput();
  invalidGoal.sessionPlan.goalTypes = ['medical_diagnosis'];
  assert.throws(() => createDirectionPlan(invalidGoal), /goalTypes.*allowlist/);

  const invalidOutput = baseDirectionInput();
  invalidOutput.sessionPlan.outputTypes = ['public_broadcast'];
  assert.throws(() => createDirectionPlan(invalidOutput), /outputTypes.*allowlist/);

  const plan = createDirectionPlan(baseDirectionInput());
  assert.equal(plan.selectedTopicId, 'work');
  assert.deepEqual(plan.candidateTopicIds, ['work']);
});

test('elder direction requires current-turn elder evidence and CONTINUE cannot switch topics', () => {
  const missingEvidence = baseDirectionInput();
  missingEvidence.elderDirection = 'CONTINUE';
  missingEvidence.selectedTopicId = 'family';
  assert.throws(() => createDirectionPlan(missingEvidence), /current-turn elder evidence/);

  const wrongEvidence = baseDirectionInput();
  wrongEvidence.elderDirection = 'CONTINUE';
  wrongEvidence.evidenceRefs = [{
    ...elderDirectionEvidence(),
    kind: 'SYSTEM_PLAN',
  }];
  assert.throws(() => createDirectionPlan(wrongEvidence), /current-turn elder evidence/);

  const valid = baseDirectionInput();
  valid.elderDirection = 'CONTINUE';
  valid.selectedTopicId = 'family';
  valid.evidenceRefs = [elderDirectionEvidence()];
  const plan = createDirectionPlan(valid);
  assert.equal(plan.selectedTopicId, 'work');
  assert.deepEqual(plan.candidateTopicIds, ['work']);

  const forged = structuredClone(plan);
  forged.candidateTopicIds = ['family'];
  const { directionPlanId: _ignored, ...forgedWithoutId } = forged;
  forged.directionPlanId = directionPlanIdFor(forgedWithoutId);
  assert.throws(() => assertDirectionPlan(forged), /only the current topic/);

  const forgedAuthority = structuredClone(plan) as any;
  forgedAuthority.authorityBoundary.canonicalWrite = true;
  forgedAuthority.authorityBoundary.canDeleteMemory = true;
  const { directionPlanId: _ignoredAuthority, ...forgedAuthorityWithoutId } = forgedAuthority;
  forgedAuthority.directionPlanId = directionPlanIdFor(forgedAuthorityWithoutId);
  assert.throws(() => assertDirectionPlan(forgedAuthority), /authorityBoundary contains unsupported field/);

  const resign = (value: any) => {
    const { directionPlanId: _discarded, ...withoutId } = value;
    value.directionPlanId = directionPlanIdFor(withoutId);
    return value;
  };
  const forgedRequest = structuredClone(plan) as any;
  forgedRequest.elderRequestedTopicId = 'family';
  assert.throws(() => assertDirectionPlan(resign(forgedRequest)), /only valid with SWITCH_TOPIC/);

  const skipInput = baseDirectionInput();
  skipInput.elderDirection = 'SKIP_CURRENT';
  skipInput.evidenceRefs = [elderDirectionEvidence()];
  const skipPlan = createDirectionPlan(skipInput);
  const forgedSkip = structuredClone(skipPlan) as any;
  forgedSkip.candidateTopicIds = ['work'];
  assert.throws(() => assertDirectionPlan(resign(forgedSkip)), /exclude the current topic/);

  const switchInput = baseDirectionInput();
  switchInput.sessionPlan.goalTypes = ['life_review', 'family_archive'];
  switchInput.elderDirection = 'SWITCH_TOPIC';
  switchInput.elderRequestedTopicId = 'family';
  switchInput.evidenceRefs = [elderDirectionEvidence()];
  const switchPlan = createDirectionPlan(switchInput);
  const forgedSwitch = structuredClone(switchPlan) as any;
  forgedSwitch.candidateTopicIds = ['family', 'work'];
  assert.throws(() => assertDirectionPlan(resign(forgedSwitch)), /exclude the current topic/);

  const openSwitchInput = baseDirectionInput();
  openSwitchInput.sessionPlan.goalTypes = ['life_review', 'family_archive'];
  openSwitchInput.elderDirection = 'SWITCH_TOPIC';
  openSwitchInput.elderRequestedTopicId = null;
  openSwitchInput.evidenceRefs = [elderDirectionEvidence()];
  const openSwitch = createDirectionPlan(openSwitchInput);
  const forgedOpenSwitch = structuredClone(openSwitch) as any;
  forgedOpenSwitch.selectedTopicId = 'family';
  assert.throws(() => assertDirectionPlan(resign(forgedOpenSwitch)), /must clear the selected topic/);
});

test('TopicLedger scopes expire at turn and session boundaries while future scope remains active', () => {
  const scopedPlan = (scope: string, currentSession: string, currentTurn: string) => {
    const input = baseDirectionInput();
    input.sessionPlan.sessionEpoch = currentSession;
    input.state.sessionEpoch = currentSession;
    input.state.turnId = currentTurn;
    input.state.currentTopicId = null;
    input.selectedTopicId = 'work';
    input.candidateTopicIds = ['work'];
    input.state.topicLedger = [{
      topicId: 'work',
      status: 'SKIPPED',
      scope,
      scopeSessionEpoch: 'epoch-origin',
      scopeTurnId: scope === 'CURRENT_TURN' ? 'turn-origin' : null,
      sourceRefs: ['turn:origin:elder'],
    }];
    return createDirectionPlan(input);
  };

  assert.equal(scopedPlan('CURRENT_TURN', 'epoch-origin', 'turn-origin').selectedTopicId, null);
  assert.equal(scopedPlan('CURRENT_TURN', 'epoch-origin', 'turn-next').selectedTopicId, 'work');
  assert.equal(scopedPlan('CURRENT_SESSION', 'epoch-origin', 'turn-next').selectedTopicId, null);
  assert.equal(scopedPlan('CURRENT_SESSION', 'epoch-new', 'turn-new').selectedTopicId, 'work');
  assert.equal(scopedPlan('FUTURE_SESSIONS', 'epoch-origin', 'turn-origin').selectedTopicId, null);
  assert.equal(scopedPlan('FUTURE_SESSIONS', 'epoch-new', 'turn-new').selectedTopicId, null);
});

test('production M2 policy is exactly equivalent to the frozen policy on 30 cases and 40 proposals', async () => {
  assert.equal(cases.length, 30);
  assert.equal(cases.reduce((count, item) => count + item.input.proposals.length, 0), 40);
  for (const testCase of cases) {
    const input = sanitizedMemoryInput(testCase);
    const expected = await runFrozenMemoryCase(structuredClone(input));
    assert.deepEqual(
      await runRuntimeMemoryCase(structuredClone(input)),
      expected,
      `production memory policy drifted for ${testCase.caseId}`,
    );
    const transaction = inspectMemoryTransaction(structuredClone(input.transaction));
    for (const proposal of input.proposals) {
      const expectedCandidate = expected.candidates.find((candidate: any) => candidate.proposalId === proposal.proposalId);
      assert.ok(expectedCandidate, `missing frozen candidate ${testCase.caseId}:${proposal.proposalId}`);
      const decision = evaluateMemoryPolicy(structuredClone(proposal), structuredClone(input.policy), transaction);
      assert.deepEqual(decision, {
        disposition: expectedCandidate.disposition,
        confirmationBasis: expectedCandidate.confirmationBasis,
        reasonCodes: expectedCandidate.reasonCodes,
      }, `evaluateMemoryPolicy drifted for ${testCase.caseId}:${proposal.proposalId}`);
    }
  }
});

test('all sixteen independent M2 hard-gate families have checks and zero errors', async () => {
  const gateNames = [
    'corpus_shape',
    'adapter_contract',
    'json_schema',
    'oracle_decision',
    'retrieval_grounding',
    'provenance_complete',
    'subject_speaker_separation',
    'scope_propagation_and_filtering',
    'current_state',
    'conflict_preservation',
    'sensitive_overreach',
    'authorized_s2_observation',
    'revoked_reactivation',
    'ai_inference_promotion',
    'stale_version_blocking',
    'idempotency',
  ] as const;
  const gates = Object.fromEntries(gateNames.map(name => [name, { checks: 0, errors: [] as string[] }]));
  const check = (name: typeof gateNames[number], condition: unknown, detail: string) => {
    gates[name].checks += 1;
    if (!condition) gates[name].errors.push(detail);
  };

  check('corpus_shape', cases.length === corpusMetadata.expectedCaseCount, `case count ${cases.length}`);
  check('corpus_shape', new Set(cases.map(item => item.caseId)).size === cases.length, 'duplicate caseId');
  check('corpus_shape', cases.reduce((count, item) => count + item.input.proposals.length, 0) === 40, 'proposal count');
  for (const [group, expectedCount] of Object.entries(corpusMetadata.expectedGroups)) {
    check('corpus_shape', cases.filter(item => item.group === group).length === expectedCount, `group ${group}`);
  }

  for (const testCase of cases) {
    const output = await runRuntimeMemoryCase(sanitizedMemoryInput(testCase));
    const policy = testCase.input.policy;
    const evidenceByRef = new Map(testCase.input.evidence.map((item: any) => [item.ref, item]));

    check(
      'adapter_contract',
      output?.contractVersion === 'sgx-memory-candidate-adapter-v1'
        && output?.caseId === testCase.caseId
        && output?.adapter?.canonicalWriteCapability === false
        && output?.transaction?.canonicalWriteCount === 0
        && Array.isArray(output?.candidates)
        && Array.isArray(output?.retrieval),
      testCase.caseId,
    );
    check('json_schema', validateAdapterOutput(output).valid, testCase.caseId);
    check('oracle_decision', output.candidates.length === testCase.expected.length, `${testCase.caseId}:count`);

    for (const expected of testCase.expected) {
      const actual = output.candidates.find((candidate: any) => candidate.proposalId === expected.proposalId);
      check(
        'oracle_decision',
        actual
          && actual.disposition === expected.disposition
          && actual.confirmationBasis === expected.confirmationBasis
          && actual.authorityState === expected.authorityState
          && actual.conflictState === expected.conflictState
          && actual.temporalState === expected.temporalState
          && actual.usageStatus === expected.usageStatus
          && actual.canonicalWritePerformed === false,
        `${testCase.caseId}:${expected.proposalId}`,
      );
      check(
        'retrieval_grounding',
        actual && sameSet(actual.evidenceRefs, expected.evidenceRefs),
        `${testCase.caseId}:${expected.proposalId}`,
      );
    }

    for (const candidate of output.candidates) {
      const refs = candidate.evidenceRefs.map((ref: string) => evidenceByRef.get(ref)).filter(Boolean) as any[];
      check(
        'provenance_complete',
        refs.length === candidate.evidenceRefs.length
          && refs.length > 0
          && refs.some(item => item.actorId === candidate.sourceActor?.actorId && item.actorRole === candidate.sourceActor?.actorRole),
        `${testCase.caseId}:${candidate.proposalId}`,
      );
      check(
        'scope_propagation_and_filtering',
        candidate.subjectId === policy.subjectId
          && candidate.familySpaceId === policy.familySpaceId
          && candidate.purpose === policy.purpose
          && candidate.authorizationVersion === policy.authorizationVersion
          && sameSet(candidate.visibilityScope, policy.visibilityScope)
          && refs.every(item => evidenceMatchesScope(item, policy)),
        `${testCase.caseId}:${candidate.proposalId}`,
      );
    }

    if (testCase.tags.includes('scope_boundary')) {
      const forbidden = testCase.input.evidence
        .filter((item: any) => !evidenceMatchesScope(item, policy))
        .map((item: any) => item.ref);
      const returned = new Set([
        ...output.candidates.flatMap((candidate: any) => candidate.evidenceRefs),
        ...output.retrieval.flatMap((entry: any) => entry.fragments.map((fragment: any) => fragment.ref)),
      ]);
      check(
        'scope_propagation_and_filtering',
        forbidden.length > 0 && forbidden.every((ref: string) => !returned.has(ref)),
        `${testCase.caseId}:forbidden-scope`,
      );
    }

    if (testCase.tags.includes('subject_speaker_guard')) {
      for (const expected of testCase.expected) {
        const actual = output.candidates.find((candidate: any) => candidate.proposalId === expected.proposalId);
        check(
          'subject_speaker_separation',
          actual?.subjectId === policy.subjectId
            && actual?.sourceActor?.actorId === expected.sourceActor.actorId
            && actual?.sourceActor?.actorRole === expected.sourceActor.actorRole,
          `${testCase.caseId}:${expected.proposalId}`,
        );
      }
    }

    if (testCase.tags.includes('current_state')) {
      for (const expected of testCase.expected) {
        const actual = output.candidates.find((candidate: any) => candidate.proposalId === expected.proposalId);
        check(
          'current_state',
          actual?.temporalState === expected.temporalState && actual?.usageStatus === expected.usageStatus,
          `${testCase.caseId}:${expected.proposalId}`,
        );
      }
    }

    if (testCase.tags.includes('conflict_guard')) {
      check(
        'conflict_preservation',
        output.candidates.length >= 2
          && output.candidates.every((candidate: any) => candidate.conflictState === 'OPEN')
          && output.candidates.every((candidate: any) => candidate.relationships.some((link: any) => link.type === 'conflicts_with'))
          && new Set(output.candidates.map((candidate: any) => candidate.sourceActor.actorId)).size >= 2,
        testCase.caseId,
      );
    }

    if (testCase.tags.includes('sensitive_guard')) {
      for (const proposal of testCase.input.proposals.filter((item: any) => item.sensitivityLevel === 'S2' && item.signals.governanceAction === 'NONE')) {
        const actual = output.candidates.find((candidate: any) => candidate.proposalId === proposal.proposalId);
        check(
          'sensitive_overreach',
          actual?.disposition !== 'AUTO_WRITE'
            && actual?.writeEligibility === 'NOT_ELIGIBLE'
            && actual?.canonicalWritePerformed === false,
          `${testCase.caseId}:${proposal.proposalId}`,
        );
      }
    }

    if (testCase.tags.includes('authorized_s2_observation_guard')) {
      const actual = output.candidates.find((candidate: any) => candidate.authorityState === 'OBSERVATION');
      check(
        'authorized_s2_observation',
        policy.longitudinalObservationAuthorization === 'on'
          && actual?.disposition === 'C3_STRONG_CONFIRM'
          && actual?.usageStatus === 'RESTRICTED'
          && actual?.writeEligibility === 'NOT_ELIGIBLE',
        testCase.caseId,
      );
    }

    if (testCase.tags.includes('revocation_guard')) {
      const inactiveRefs = new Set<string>(testCase.input.evidence
        .filter((item: any) => item.useStatus !== 'ACTIVE')
        .map((item: any) => item.ref));
      const leaked = output.candidates.some((candidate: any) => candidate.evidenceRefs.some((ref: string) => inactiveRefs.has(ref)))
        || output.retrieval.some((entry: any) => entry.fragments.some((fragment: any) => inactiveRefs.has(fragment.ref)));
      const revokeApplied = testCase.input.proposals
        .filter((item: any) => item.signals.governanceAction === 'REVOKE')
        .every((item: any) => {
          const actual = output.candidates.find((candidate: any) => candidate.proposalId === item.proposalId);
          return actual?.temporalState === 'REVOKED' && actual?.usageStatus === 'REVOKED';
        });
      check('revoked_reactivation', !leaked && revokeApplied, testCase.caseId);
      if (testCase.tags.includes('revocation_reactivation_guard')) {
        const restore = output.candidates.find((candidate: any) => candidate.contentType === 'restore_request');
        check('revoked_reactivation', restore?.disposition === 'BLOCKED' && restore?.usageStatus !== 'ACTIVE', `${testCase.caseId}:restore`);
      }
    }

    if (testCase.tags.includes('ai_inference_guard')) {
      for (const proposal of testCase.input.proposals.filter((item: any) => (
        ['AI_DERIVED', 'PHOTO_MODEL', 'SYSTEM_OBSERVATION'].includes(item.signals.origin)
      ))) {
        const actual = output.candidates.find((candidate: any) => candidate.proposalId === proposal.proposalId);
        check(
          'ai_inference_promotion',
          actual?.authorityState !== 'SELF_ASSERTED'
            && actual?.disposition !== 'AUTO_WRITE'
            && actual?.canonicalWritePerformed === false,
          `${testCase.caseId}:${proposal.proposalId}`,
        );
      }
    }

    if (testCase.tags.includes('stale_version_guard')) {
      check(
        'stale_version_blocking',
        output.transaction.idempotencyStatus === 'STALE_VERSION'
          && output.transaction.mutationIntentCount === 0
          && output.transaction.canonicalWriteCount === 0
          && output.candidates.every((candidate: any) => candidate.disposition === 'BLOCKED' && candidate.temporalState === 'BLOCKED_STALE'),
        testCase.caseId,
      );
    }

    if (testCase.tags.includes('idempotency_guard')) {
      const prior: any = testCase.input.transaction.existingIdempotencyRecord;
      const samePayload = prior?.payloadHash === testCase.input.transaction.payloadHash;
      check(
        'idempotency',
        samePayload
          ? output.transaction.idempotencyStatus === 'REPLAY'
            && output.transaction.replayedResultRef === prior.resultRef
            && output.transaction.mutationIntentCount === 0
            && output.candidates.every((candidate: any) => candidate.disposition !== 'BLOCKED')
          : output.transaction.idempotencyStatus === 'KEY_PAYLOAD_CONFLICT'
            && output.transaction.mutationIntentCount === 0
            && output.candidates.every((candidate: any) => candidate.disposition === 'BLOCKED'),
        testCase.caseId,
      );
    }
  }

  assert.equal(Object.keys(gates).length, 16);
  for (const [name, gate] of Object.entries(gates)) {
    assert.ok(gate.checks > 0, `${name} had no independent checks`);
    assert.deepEqual(gate.errors, [], `${name} hard gate errors`);
  }
});

test('production Interview and Memory source trees do not import harness, cases, results or Oracle artifacts', () => {
  const roots = [
    path.join(REPO_ROOT, 'src/lib/interview-policy'),
    path.join(REPO_ROOT, 'src/lib/memory-runtime'),
  ];
  const sourceFiles = roots.flatMap(root => fs.readdirSync(root, { recursive: true })
    .map(entry => path.join(root, String(entry)))
    .filter(filePath => fs.statSync(filePath).isFile() && /\.(?:ts|mts|mjs|js)$/u.test(filePath)));
  assert.ok(sourceFiles.length > 0);
  const forbidden = /(?:^|\/)(?:harness|cases?|results?|oracles?)(?:\/|\.|$)/iu;
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gu)]
      .map(match => match[1]);
    for (const specifier of specifiers) {
      assert.equal(forbidden.test(specifier), false, `${path.relative(REPO_ROOT, sourceFile)} imports forbidden ${specifier}`);
    }
  }
});

function fixedCase(caseId: string): any {
  const testCase = cases.find((item: any) => item.caseId === caseId);
  assert.ok(testCase, `missing fixed case ${caseId}`);
  return structuredClone(testCase);
}

function rawInput(testCase: any): any {
  return {
    policy: structuredClone(testCase.input.policy),
    evidence: structuredClone(testCase.input.evidence),
    currentRecords: structuredClone(testCase.input.currentRecords),
  };
}

function fullInput(testCase: any): any {
  return {
    caseId: `hybrid-${testCase.caseId}`,
    fixtureVersion: testCase.fixtureVersion,
    policyVersion: testCase.policyVersion,
    requestId: `hybrid-${testCase.input.requestId}`,
    policy: structuredClone(testCase.input.policy),
    evidence: structuredClone(testCase.input.evidence),
    currentRecords: structuredClone(testCase.input.currentRecords),
    transaction: structuredClone(testCase.input.transaction),
  };
}

function byAction(proposals: any[], action: string): any | undefined {
  return proposals.find((proposal: any) => proposal.signals.governanceAction === action);
}

function byType(proposals: any[], type: string): any[] {
  return proposals.filter((proposal: any) => proposal.contentType === type);
}

test('metadata fixes the offline candidate-only boundary', () => {
  assert.equal(hybridExtractorMetadata.network, false);
  assert.equal(hybridExtractorMetadata.model, false);
  assert.equal(hybridExtractorMetadata.canonicalWriteCapability, false);
  assert.deepEqual(hybridExtractorMetadata.acceptedInputFields, ['policy', 'evidence', 'currentRecords']);
});

test('M2-05 must-extract keeps health and privacy as separate atoms before the policy gate', async () => {
  const testCase = fixedCase('M2-05');
  const { extraction, output } = await runHybridCase(fullInput(testCase));
  assert.equal(extraction.diagnostics.mustExtractCount, 2);
  assert.equal(byType(extraction.proposals, 'health_context').length, 1);
  assert.ok(byAction(extraction.proposals, 'RESTRICT'));

  const health = output.candidates.find(candidate => candidate.contentType === 'health_context');
  const privacy = output.candidates.find(candidate => candidate.contentType === 'privacy_rule');
  assert.ok(health, 'missing health candidate');
  assert.ok(privacy, 'missing privacy candidate');
  assert.equal(health.disposition, 'C3_STRONG_CONFIRM');
  assert.equal(health.usageStatus, 'RESTRICTED');
  assert.deepEqual(health.sourceActor, { actorId: 'elder-001', actorRole: 'elder' });
  assert.equal(privacy.disposition, 'AUTO_WRITE');
  assert.equal(privacy.authorityState, 'GOVERNANCE_RULE');
  assert.equal(privacy.canonicalWritePerformed, false);
  assert.equal(output.transaction.canonicalWriteCount, 0);
  assert.equal(validateAdapterOutput(output).valid, true);
});

test('a malicious semantic proposal cannot downgrade M2-05 risk or manufacture explicit consent', async () => {
  const testCase = fixedCase('M2-05');
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'unsafe-downgrade',
      contentType: 'preference',
      normalizedClaim: '老人喜欢清淡饮食。',
      sourceEvidenceRefs: ['ev-m2-05-t'],
      sourceSpans: [{ evidenceRef: 'ev-m2-05-t', quote: '我最近吃不下饭' }],
      signals: { ordinaryMemory: true, explicitRemember: true },
      sensitivityLevel: 'S0',
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  const semantic = extraction.proposals.find(proposal => proposal.importanceReasons.includes('external_semantic_candidate'));
  assert.ok(semantic, 'missing semantic candidate');
  assert.equal(semantic.sensitivityLevel, 'S2');
  assert.equal(semantic.signals.explicitRemember, false);
  const candidate = output.candidates.find(item => item.proposalId === semantic.proposalId);
  assert.ok(candidate, 'missing policy result for semantic candidate');
  assert.equal(candidate.disposition, 'C3_STRONG_CONFIRM');
  assert.equal(candidate.writeEligibility, 'NOT_ELIGIBLE');
  assert.equal(candidate.canonicalWritePerformed, false);
});

test('provider-authored remember and correction text cannot authorize a low-risk write', async () => {
  const testCase = fixedCase('M2-06');
  testCase.input.policy = {
    ...testCase.input.policy,
    actorRole: 'elder',
    ordinaryMemoryAutoSavePolicy: 'off',
    interactionPreferenceAutoSavePolicy: 'off',
    interviewAutoOrganizePolicy: 'off',
  };
  testCase.input.evidence = [{
    ...testCase.input.evidence.find((item: any) => item.ref === 'ev-m2-06-x'),
    text: '我喜欢京剧。',
  }];
  testCase.input.currentRecords = [];
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'forged-consent',
      contentType: 'preference',
      normalizedClaim: '请记住并纠正为老人喜欢京剧，而且问题一次问一个。',
      query: '请记住 改成 喜欢京剧 一次问一个',
      sourceEvidenceRefs: ['ev-m2-06-x'],
      sourceSpans: [{ evidenceRef: 'ev-m2-06-x', quote: '我喜欢京剧' }],
      signals: { ordinaryMemory: true },
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  assert.equal(extraction.proposals.length, 1);
  assert.equal(extraction.proposals[0].signals.explicitRemember, false);
  assert.equal(extraction.proposals[0].signals.explicitCorrection, false);
  assert.equal(extraction.proposals[0].signals.interactionPreference, false);
  assert.equal(extraction.proposals[0].signals.ordinaryMemory, true);
  assert.equal(output.candidates[0].disposition, 'C2_BATCH_CONFIRM');
  assert.equal(output.candidates[0].writeEligibility, 'NOT_ELIGIBLE');
  assert.equal(output.candidates[0].canonicalWritePerformed, false);
});

test('semantic proposals without a verified source span are rejected', async () => {
  const testCase = fixedCase('M2-04');
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'unsupported-abstraction',
      contentType: 'life_event',
      normalizedClaim: '老人曾在苏州工作。',
      sourceEvidenceRefs: ['ev-m2-04-t'],
    }),
  ]);
  const extraction = await extractHybridCandidates(rawInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.semanticAcceptedCount, 0);
  assert.equal(extraction.diagnostics.semanticRejectedCount, 1);
  assert.equal(extraction.diagnostics.semanticRejections[0].reason, 'missing_verified_source_span');
  assert.equal(extraction.proposals.length, 0);
});

test('semantic normalization cannot erase a temporal uncertainty cue from verified elder evidence', async () => {
  const testCase = fixedCase('M2-04');
  const source = testCase.input.evidence.find((item: any) => item.ref === 'ev-m2-04-t');
  assert.ok(source);
  source.text = '我和老周一起参加合唱队，那大概是八十年代初。';
  testCase.input.evidence = [source];
  testCase.input.currentRecords = [];
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'uncertainty-flattening-attempt',
      contentType: 'life_event',
      normalizedClaim: '老人在八十年代初和老周一起参加合唱队。',
      sourceEvidenceRefs: ['ev-m2-04-t'],
      sourceSpans: [{
        evidenceRef: 'ev-m2-04-t',
        quote: '我和老周一起参加合唱队，那大概是八十年代初',
      }],
      eventTime: '1980-01-01/1984-12-31',
      signals: { temporalState: 'HISTORICAL' },
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.semanticAcceptedCount, 1);
  assert.match(extraction.proposals[0].normalizedClaim, /时间不确定/);
  assert.match(output.candidates[0].normalizedClaim, /时间不确定/);
});

test('malicious semantic credential text is replaced in both claim and query', async () => {
  const testCase = fixedCase('M2-05');
  testCase.input.evidence = [{
    ...testCase.input.evidence[0],
    ref: 'ev-semantic-credential',
    text: '我的银行卡密码是 TEST-CREDENTIAL-9876，请帮我记住。',
  }];
  testCase.input.currentRecords = [];
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'credential-echo-attempt',
      contentType: 'preference',
      normalizedClaim: '老人的银行卡密码是 TEST-CREDENTIAL-9876。',
      query: '银行卡密码 TEST-CREDENTIAL-9876',
      sourceEvidenceRefs: ['ev-semantic-credential'],
      sourceSpans: [{ evidenceRef: 'ev-semantic-credential', quote: '银行卡密码是 TEST-CREDENTIAL-9876' }],
      signals: { ordinaryMemory: true },
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.semanticAcceptedCount, 1);
  assert.equal(extraction.diagnostics.mergeCount, 1);
  assert.equal(extraction.proposals.length, 1);
  assert.equal(extraction.proposals[0].normalizedClaim.includes('TEST-CREDENTIAL-9876'), false);
  assert.equal(extraction.proposals[0].query.includes('TEST-CREDENTIAL-9876'), false);
  assert.equal(extraction.proposals[0].signals.containsCredential, true);
  assert.equal(output.candidates[0].normalizedClaim.includes('TEST-CREDENTIAL-9876'), false);
  assert.equal(output.candidates[0].disposition, 'NO_MEMORY');
});

test('M2-04 mock semantic proposals preserve three atoms from one interview turn', async () => {
  const testCase = fixedCase('M2-04');
  const source = 'ev-m2-04-t';
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'work', contentType: 'life_event', normalizedClaim: '老人第一次在苏州纺织厂工作。', sourceEvidenceRefs: [source],
      sourceSpans: [{ evidenceRef: source, quote: '我第一次在苏州纺织厂工作' }],
    }),
    semanticProposal({
      providerProposalId: 'move', contentType: 'life_event', normalizedClaim: '老人后来迁居无锡。', sourceEvidenceRefs: [source],
      sourceSpans: [{ evidenceRef: source, quote: '后来搬到无锡' }],
    }),
    semanticProposal({
      providerProposalId: 'meaning', contentType: 'subjective_meaning', normalizedClaim: '老人认为迁居让一家人更亲近。', sourceEvidenceRefs: [source],
      sourceSpans: [{ evidenceRef: source, quote: '我觉得搬家让一家人更亲近了' }],
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.outputCount, 3);
  assert.deepEqual(extraction.proposals.map(item => item.contentType), ['life_event', 'life_event', 'subjective_meaning']);
  assert.equal(output.candidates.length, 3);
  assert.ok(output.candidates.every(candidate => candidate.evidenceRefs.includes(source)));
  assert.ok(output.candidates.every(candidate => candidate.sourceActor.actorId === 'elder-001'));
  assert.ok(output.candidates.every(candidate => candidate.disposition === 'AUTO_WRITE'));
  assert.ok(output.candidates.every(candidate => candidate.canonicalWritePerformed === false));
});

test('must-extract and semantic health proposals merge without losing the stronger safety fields', async () => {
  const testCase = fixedCase('M2-05');
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'health-paraphrase',
      contentType: 'health_context',
      normalizedClaim: '老人近期食欲下降。',
      sourceEvidenceRefs: ['ev-m2-05-t'],
      sourceSpans: [{ evidenceRef: 'ev-m2-05-t', quote: '我最近吃不下饭' }],
    }),
  ]);
  const extraction = await extractHybridCandidates(rawInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.mergeCount, 1);
  const health = byType(extraction.proposals, 'health_context');
  assert.equal(health.length, 1);
  assert.equal(health[0].sensitivityLevel, 'S2');
  assert.ok(health[0].importanceReasons.includes('must_extract_safety_floor'));
  assert.ok(health[0].importanceReasons.includes('external_semantic_candidate'));
});

test('FU boundaries preserve multi-source follow-up, block purpose expansion, and reject stale authorization', async () => {
  const followup = fixedCase('FU-01');
  const followupProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'followup-marker',
      contentType: 'continuation_marker',
      normalizedClaim: '下次访谈从纺织厂第一次上夜班继续。',
      sourceEvidenceRefs: ['ev-fu-01-marker', 'ev-fu-01-story'],
      sourceSpans: [
        { evidenceRef: 'ev-fu-01-marker', quote: '下次从第一次上夜班这里继续问我' },
        { evidenceRef: 'ev-fu-01-story', quote: '我第一次上夜班是在纺织厂' },
      ],
    }),
  ]);
  const followupRun = await runHybridCase(fullInput(followup), { semanticProvider: followupProvider });
  assert.equal(followupRun.output.candidates[0].disposition, 'AUTO_WRITE');
  assert.deepEqual(new Set(followupRun.output.candidates[0].evidenceRefs), new Set(['ev-fu-01-marker', 'ev-fu-01-story']));

  const purpose = fixedCase('FU-02');
  const purposeProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'purpose-expansion',
      contentType: 'health_context',
      normalizedClaim: '在家庭故事中继续使用住院后疼痛信息。',
      sourceEvidenceRefs: ['ev-fu-02-r'],
      sourceSpans: [{ evidenceRef: 'ev-fu-02-r', quote: '这件事不要写进家庭故事' }],
      signals: { purposeExpansion: true },
    }),
  ]);
  const purposeRun = await runHybridCase(fullInput(purpose), { semanticProvider: purposeProvider });
  const blocked = purposeRun.output.candidates.find(candidate => candidate.contentType === 'health_context');
  assert.ok(blocked, 'missing purpose-expansion candidate');
  assert.equal(blocked.disposition, 'BLOCKED');
  assert.equal(blocked.confirmationBasis, 'blocked_by_guard');

  const correction = fixedCase('FU-03');
  const correctionProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'current-correction',
      contentType: 'continuation_marker',
      normalizedClaim: '后续访谈以前往苏州工作的经历为当前前提。',
      sourceEvidenceRefs: ['ev-fu-03-new'],
      sourceSpans: [{ evidenceRef: 'ev-fu-03-new', quote: '第一次工作是在苏州' }],
      signals: { shortTerm: true },
    }),
    semanticProposal({
      providerProposalId: 'stale-authorization',
      contentType: 'continuation_marker',
      normalizedClaim: '使用旧授权片段继续访谈。',
      sourceEvidenceRefs: ['ev-fu-03-stale-auth'],
    }),
  ]);
  const correctionRun = await runHybridCase(fullInput(correction), { semanticProvider: correctionProvider });
  assert.equal(correctionRun.extraction.diagnostics.semanticRejectedCount, 1);
  assert.equal(correctionRun.extraction.diagnostics.semanticRejections[0].reason, 'source_evidence_out_of_scope_or_inactive');
  assert.equal(correctionRun.output.candidates.length, 1);
  assert.deepEqual(correctionRun.output.candidates[0].evidenceRefs, ['ev-fu-03-new']);
  assert.equal(correctionRun.output.candidates[0].disposition, 'SESSION_ONLY');
});

test('RT commands are must-extracted while non-elder restore remains blocked', async () => {
  for (const caseId of ['RT-01', 'RT-02']) {
    const testCase = fixedCase(caseId);
    const { extraction, output } = await runHybridCase(fullInput(testCase));
    assert.ok(byAction(extraction.proposals, 'REVOKE'));
    assert.equal(output.candidates[0].disposition, 'AUTO_WRITE');
    assert.equal(output.candidates[0].usageStatus, 'REVOKED');
    assert.equal(output.candidates[0].canonicalWritePerformed, false);
  }

  const restore = fixedCase('RT-03');
  const { extraction, output } = await runHybridCase(fullInput(restore));
  assert.ok(byAction(extraction.proposals, 'RESTORE_REQUEST'));
  assert.deepEqual(output.candidates[0].sourceActor, { actorId: 'admin-001', actorRole: 'family_admin' });
  assert.equal(output.candidates[0].disposition, 'BLOCKED');
  assert.equal(output.candidates[0].writeEligibility, 'NOT_ELIGIBLE');
});

test('explicit financial disagreement remains S2, attributed, and conflicted', async () => {
  const testCase = fixedCase('FD-02');
  const { extraction, output } = await runHybridCase(fullInput(testCase));
  const financial = byType(extraction.proposals, 'financial_claim');
  assert.equal(financial.length, 2);
  assert.ok(financial.every(proposal => proposal.sensitivityLevel === 'S2'));
  assert.ok(financial.every(proposal => proposal.signals.conflict));
  assert.deepEqual(new Set(output.candidates.map(candidate => candidate.sourceActor.actorId)), new Set(['son-002', 'elder-001']));
  assert.ok(output.candidates.every(candidate => candidate.disposition === 'C3_STRONG_CONFIRM'));
  assert.ok(output.candidates.every(candidate => candidate.conflictState === 'OPEN'));
});

test('semantic photo conflicts keep source actors and exclude cross-family evidence', async () => {
  const testCase = fixedCase('FD-03');
  const semanticProvider = createMockSemanticProvider([
    semanticProposal({
      providerProposalId: 'daughter-location', contentType: 'photo_location_claim', normalizedClaim: '女儿称 photo-52 拍摄于杭州西湖。',
      sourceEvidenceRefs: ['ev-fd-03-a'], sourceSpans: [{ evidenceRef: 'ev-fd-03-a', quote: 'photo-52 是在杭州西湖拍的' }], signals: { conflict: true },
    }),
    semanticProposal({
      providerProposalId: 'son-location', contentType: 'photo_location_claim', normalizedClaim: '儿子称 photo-52 拍摄于无锡鼋头渚。',
      sourceEvidenceRefs: ['ev-fd-03-b'], sourceSpans: [{ evidenceRef: 'ev-fd-03-b', quote: 'photo-52 明明是在无锡鼋头渚拍的' }], signals: { conflict: true },
    }),
    semanticProposal({
      providerProposalId: 'cross-family', contentType: 'photo_location_claim', normalizedClaim: '外部家庭称 photo-52 拍摄于杭州西湖。',
      sourceEvidenceRefs: ['ev-fd-03-cross-family'],
    }),
  ]);
  const { extraction, output } = await runHybridCase(fullInput(testCase), { semanticProvider });
  assert.equal(extraction.diagnostics.semanticRejectedCount, 1);
  assert.equal(output.candidates.length, 2);
  assert.deepEqual(new Set(output.candidates.map(candidate => candidate.sourceActor.actorId)), new Set(['daughter-003', 'son-003']));
  assert.ok(output.candidates.every(candidate => candidate.authorityState === 'SOURCED_CLAIM'));
  assert.ok(output.candidates.every(candidate => candidate.conflictState === 'OPEN'));
  assert.ok(output.candidates.every(candidate => !candidate.evidenceRefs.includes('ev-fd-03-cross-family')));
});

test('credential evidence becomes NO_MEMORY and the extracted claim does not echo the secret', async () => {
  const policy: MemoryPolicyContext = {
    interactionPreferenceAutoSavePolicy: 'off', ordinaryMemoryAutoSavePolicy: 'on', interviewAutoOrganizePolicy: 'off', longitudinalObservationAuthorization: 'off',
    actorRole: 'elder', subjectId: 'elder-001', familySpaceId: 'family-fiction-001', purpose: 'daily_chat', visibilityScope: ['elder_only'], authorizationVersion: 'auth-v1',
  };
  const evidence: EvidenceFragment[] = [{
    ref: 'ev-credential', kind: 'transcript', actorId: 'elder-001', actorRole: 'elder', subjectId: 'elder-001', familySpaceId: 'family-fiction-001',
    allowedPurposes: ['*'], authorizationVersion: '*', visibilityScope: ['*'], text: '我的银行卡密码是某个六位数，请帮我记住。', recordedAt: '2026-09-01T09:00:00+08:00', eventTime: null, useStatus: 'ACTIVE',
  }];
  const transaction: MemoryTransactionInput = {
    currentVersion: 1,
    expectedVersion: 1,
    idempotencyKey: 'idem-credential',
    payloadHash: 'payload-credential',
    existingIdempotencyRecord: null,
  };
  const { extraction, output } = await runHybridCase({ caseId: 'hybrid-credential', requestId: 'req-credential', policy, evidence, currentRecords: [], transaction });
  assert.equal(extraction.proposals.length, 1);
  assert.equal(extraction.proposals[0].signals.containsCredential, true);
  assert.equal(extraction.proposals[0].normalizedClaim.includes('某个六位数'), false);
  assert.equal(output.candidates[0].disposition, 'NO_MEMORY');
  assert.equal(output.candidates[0].writeEligibility, 'NOT_ELIGIBLE');
  assert.equal(output.candidates[0].canonicalWritePerformed, false);
});
