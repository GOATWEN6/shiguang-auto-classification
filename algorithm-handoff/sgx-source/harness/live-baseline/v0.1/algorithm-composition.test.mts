import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlgorithmComposition, type LiveProvider, type AlgorithmOutputEvent } from '../../../src/lib/algorithm-service/index.ts';
import type { TrustedSessionAuthority } from '../../../src/lib/turn-orchestrator/index.ts';
import { findUnsupportedEventPrecondition } from '../../../src/lib/response-runtime/spoken-text.ts';

function authority(id = 'A'): TrustedSessionAuthority {
  return { schemaVersion: 'trusted-session-authority-v0.1', actorId: `actor-${id}`,
    subjectId: `elder-${id}`, familySpaceId: `family-${id}`, authorizationVersion: 'auth-v1',
    visibilityScope: ['elder_only'] };
}
function provider(overrides: Partial<LiveProvider> = {}): LiveProvider {
  return {
    async json(_system, input, options) {
      const data = input as any;
      if (options.module === 'memory') {
        const source = data.evidence[0];
        return { proposals: [{ providerProposalId: 'semantic-1',
          contentType: /第一次/u.test(source.text) ? 'life_event' : 'preference',
          normalizedClaim: source.text, query: source.text, sourceEvidenceRefs: [source.ref],
          sourceSpans: [{ evidenceRef: source.ref, quote: source.text }],
          eventTime: null, validFrom: null, validTo: null, sensitivityLevel: 'S0',
          signals: { temporalState: 'CURRENT', shortTerm: false, conflict: false,
            ambiguousSubject: false, purposeExpansion: false, visibilityExpansion: false } }] };
      }
      if (options.module === 'profile_draft' || options.module === 'story_draft') {
        const source = data.sources[0];
        const provenance = { recordIds: [source.recordId], evidenceRefs: source.evidenceRefs,
          claimMode: 'DIRECT', uncertainty: 'NONE' };
        return options.module === 'profile_draft'
          ? { schemaVersion: '0.3', fields: [{ fieldId: 'field-1', path: 'preferences.music',
            value: source.text, temporalScope: 'CURRENT', ...provenance }] }
          : { schemaVersion: '0.3', sentences: [{ sentenceId: 'sentence-1', text: source.text, ...provenance }] };
      }
      if (options.module === 'formal_interview') {
        return { text: data.plan.questionCount === 1 ? '您愿意讲讲当时的一件小事吗？' : data.plan.frozenPolicyText,
          questions: data.plan.questionCount === 1 ? ['您愿意讲讲当时的一件小事吗？'] : [] };
      }
      return { text: '我听到了，我们慢慢聊。', questions: [] };
    },
    async synthesize() { return { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' }; },
    async transcribe() { return { text: '我喜欢越剧。', payloadCount: 1 }; },
    ...overrides,
  };
}
function start(composition: ReturnType<typeof createAlgorithmComposition>, id = 'A') {
  return composition.orchestrator.startSession({ schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: `start-${id}`, requestedMode: 'DAILY_CHAT' }, authority(id)).opaqueSessionHandle;
}
function turn(composition: ReturnType<typeof createAlgorithmComposition>, handle: string, text: string, key: string, interview = false) {
  return composition.orchestrator.runFinalTurn(handle, { schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: key, source: 'TYPED_TEXT', text, receivedAt: '2026-10-07T01:00:00.000Z',
    ...(interview ? { uiAction: { type: 'MEMORY_TOPIC_CLICK', eventRef: `ui-${key}`, targetMode: 'FORMAL_INTERVIEW' } as const } : {}) });
}

test('composition reuses gated Memory and produces authorized derived views without cross-family leakage', async () => {
  const c = createAlgorithmComposition({ provider: provider(), derivedPurposes: ['profile_draft', 'story_draft'] });
  const a = start(c);
  const b = start(c, 'B');
  const result = await turn(c, a, '我一直喜欢听越剧，请整理我的爱好画像。', 'a1');
  assert.equal(result.status, 'completed');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.deepEqual(result.asyncJobs.map(job => [job.kind, job.status]), [['MEMORY', 'success'], ['PROFILE', 'success']]);
  assert.ok(c.view(a).memory.some(record => record.status === 'ACTIVE'));
  assert.equal(c.view(a).artifacts.length, 1);
  assert.equal(c.view(b).memory.length, 0);
  assert.equal(c.view(b).artifacts.length, 0);
  const replay = await turn(c, a, '我一直喜欢听越剧，请整理我的爱好画像。', 'a1');
  assert.equal(replay.turnId, result.turnId);
});

test('explicit story and profile request schedules both independent derived jobs', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ derivedPurposes: ['profile_draft', 'story_draft'], provider: provider({
    async json(system, input, options) {
      if (options.module === 'memory') {
        const source = (input as any).evidence[0];
        const common = { query: source.text, sourceEvidenceRefs: [source.ref],
          sourceSpans: [{ evidenceRef: source.ref, quote: source.text }],
          eventTime: null, validFrom: null, validTo: null, sensitivityLevel: 'S0',
          signals: { temporalState: 'CURRENT', shortTerm: false, conflict: false,
            ambiguousSubject: false, purposeExpansion: false, visibilityExpansion: false } };
        return { proposals: [
          { providerProposalId: 'story-fact', contentType: 'life_event', normalizedClaim: '曾在工厂工作', ...common },
          { providerProposalId: 'profile-fact', contentType: 'preference', normalizedClaim: '喜欢听越剧', ...common },
        ] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我曾在工厂工作，也喜欢听越剧，请同时做故事草稿和基础画像。', 'both-derived');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.asyncJobs.map(job => job.kind), ['MEMORY', 'PROFILE', 'STORY']);
  assert.deepEqual(result.asyncJobs.map(job => job.status), ['success', 'success', 'success']);
});

test('paused interview accepts a governed continuation and keeps unrelated input paused', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  const entered = await turn(c, handle, '我愿意聊聊以前在纺织厂工作的日子。', 'pause-entry', true);
  assert.equal(entered.mode, 'FORMAL_INTERVIEW');

  const paused = await turn(c, handle, '我有点累，先停一下。', 'pause-turn');
  assert.equal(paused.status, 'completed');
  assert.equal(paused.response?.action, 'PAUSE');
  assert.equal(c.view(handle).status, 'PAUSED');

  const stillPaused = await turn(c, handle, '我想换个轻松话题。', 'paused-unrelated');
  assert.equal(stillPaused.status, 'completed');
  assert.equal(stillPaused.response?.action, 'PAUSE');
  assert.equal(c.view(handle).status, 'PAUSED');

  const resumed = await turn(c, handle, '我休息好了，继续吧。', 'resume-turn');
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.response?.action, 'ACKNOWLEDGE');
  assert.equal(c.view(handle).status, 'ACTIVE');
});

test('natural topic handoff phrase is treated as an explicit switch', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  await turn(c, handle, '我愿意聊聊以前在纺织厂工作的日子。', 'switch-entry', true);
  const result = await turn(c, handle,
    '这段先聊到这里，我们说说后来在阳台种花的事。', 'switch-natural');
  assert.equal(result.status, 'completed');
  assert.equal(result.response?.action, 'SWITCH_TOPIC');
  assert.match(result.response?.text ?? '', /阳台种花/u);
  assert.equal(result.response?.policyStatePatch?.interviewState.currentTopic, '后来在阳台种花');
});

test('missing derived authorization prevents derived scheduling and purpose expansion', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  const result = await turn(c, handle, '我喜欢听越剧，请整理我的爱好画像。', 'a1');
  assert.deepEqual(result.asyncJobs.map(job => job.kind), ['MEMORY']);
  assert.equal(c.view(handle).artifacts.length, 0);
  for (const record of c.view(handle).memory) {
    if (record.status !== 'DELETED') assert.deepEqual(record.candidate.allowedUses, ['daily_chat']);
  }
});

test('daily light follow-up stays in Daily Chat and cannot schedule interview or derived artifacts', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'daily_chat') {
        assert.equal((input as { maxQuestions: number }).maxQuestions, 1);
        return { text: '京剧很有韵味。您喜欢哪个选段？', questions: ['您喜欢哪个选段？'] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我平时喜欢听京剧。', 'light-question');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.response?.questionCount, 1);
  assert.equal(result.mode, 'DAILY_CHAT');
  assert.equal(c.view(handle).mode, 'DAILY_CHAT');
  assert.equal(result.response?.retentionIntent, 'DEFAULT');
  assert.equal(result.response?.retentionScope, 'NONE');
  assert.deepEqual(result.asyncJobs.map(job => job.kind), ['MEMORY']);
  assert.equal(c.view(handle).artifacts.length, 0);
  for (const record of c.view(handle).memory) {
    if (record.status !== 'DELETED') assert.deepEqual(record.candidate.allowedUses, ['daily_chat']);
  }
});

test('split model question is spoken once in Daily Chat and formal interview', async () => {
  const base = provider();
  const question = '您愿意讲讲当时的一件小事吗？';
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'daily_chat' || options.module === 'formal_interview') {
        return { text: '我听到了。', questions: [question] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const daily = await turn(c, handle, '我平时喜欢听京剧。', 'split-daily');
  assert.equal(daily.response?.status, 'success');
  assert.equal(daily.response?.text, `我听到了。 ${question}`);
  assert.equal(daily.response?.questionCount, 1);
  assert.equal(daily.mode, 'DAILY_CHAT');
  const interview = await turn(c, handle, '我第一次去厂里上班是1968年，那天有点下雨，周师傅带我去认机器，后来还借给我一件雨衣。', 'split-interview', true);
  assert.equal(interview.response?.status, 'success');
  assert.equal(interview.response?.text, `我听到了。 ${question}`);
  assert.equal(interview.response?.questionCount, 1);
});

test('formal interview keeps a complete provider sentence when the question field is a shorter copy', async () => {
  const base = provider();
  const completeText = '好的，您可以讲讲以前在纺织厂工作时，有没有让您印象比较深的人和事呀？';
  const shorterQuestion = '您以前在纺织厂工作时，有没有让您印象比较深的人和事呀？';
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'formal_interview') {
        return { text: completeText, questions: [shorterQuestion] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我想聊聊以前在纺织厂的事吧。', 'question-copy-mismatch', true);
  assert.equal(result.response?.status, 'success');
  assert.equal(result.response?.text, completeText);
  assert.equal(result.response?.questionCount, 1);
});

test('interview guard converts an unconfirmed event presupposition into a conditional question', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'formal_interview') {
        return {
          text: '您在阳台靠东的角落种的这盆茉莉，平时开的花闻起来香不香呀？',
          questions: ['您在阳台靠东的角落种的这盆茉莉，平时开的花闻起来香不香呀？'],
        };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle,
    '我先种了一盆茉莉，花盆放在阳台靠东的角落，早上出门前浇一点水。',
    'precondition-flower', true);
  assert.equal(result.response?.status, 'success');
  assert.match(result.response?.text ?? '', /如果后来开过花/u);
  assert.doesNotMatch(result.response?.text ?? '', /平时开的花闻起来香不香/u);
  assert.equal(result.response?.questionCount, 1);
});

test('interview guard scans the normalized split question, not only provider text', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'formal_interview') {
        return { text: '我听到了。', questions: ['您结婚那天是不是很热闹？'] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我小时候在镇上的机械厂学徒。', 'precondition-question-field', true);
  assert.equal(result.response?.status, 'success');
  assert.match(result.response?.text ?? '', /如果后来有过成家或婚礼/u);
  assert.doesNotMatch(result.response?.text ?? '', /结婚那天是不是很热闹/u);
});

test('interview guard does not treat an unrelated if-clause as confirmation', async () => {
  const guarded = findUnsupportedEventPrecondition('如果方便，您结婚那天最记得什么？', '我在机械厂工作。');
  assert.equal(guarded?.code, 'MARRIAGE');
  assert.match(guarded?.question ?? '', /如果后来有过成家或婚礼/u);
});

test('interview guard respects explicit negation and avoids a false event premise', async () => {
  const guarded = findUnsupportedEventPrecondition('您结婚那天最记得什么？', '我没有结婚。');
  assert.equal(guarded?.code, 'MARRIAGE');
  assert.match(guarded?.text ?? '', /按您刚才的说明/u);
  assert.doesNotMatch(guarded?.question ?? '', /如果后来有过成家或婚礼/u);
  assert.equal(findUnsupportedEventPrecondition('您说起嫁接时，最先想到什么？', '我在院子里嫁接月季。'), null);
});

test('interview guard accepts a supported premise from prior trusted evidence', () => {
  assert.equal(findUnsupportedEventPrecondition(
    '您结婚那天最记得什么？',
    '今天我们先聊工作。',
    ['我年轻时结过婚，后来和家人一起生活。'],
  ), null);
});

test('interview emotion guard also covers a split question field', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'formal_interview') {
        return { text: '我听到了。', questions: ['想必您一定很幸福，对吗？'] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我在机械厂学徒，后来调到车间。', 'emotion-question-field', true);
  assert.equal(result.response?.status, 'fallback');
  assert.doesNotMatch(result.response?.text ?? '', /一定很幸福/u);
});

test('daily model cannot announce completed persistence before background governance commits', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      if (options.module === 'daily_chat') return { text: '我记下您明天去花市的安排了。', questions: [] };
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '明天我想去花市，这只是明天的安排。', 'premature-save');
  assert.equal(result.response?.status, 'fallback');
  assert.equal(result.response?.text.includes('记下'), false);
});

test('Memory failure settles derived dependency promptly and preserves reply, TTS and next turn', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ derivedPurposes: ['profile_draft'], provider: provider({
    async json(system, input, options) {
      if (options.module === 'memory') throw new Error('fixture_failure');
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我喜欢听越剧，请整理我的爱好画像。', 'a1');
  assert.equal(result.status, 'completed');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.deepEqual(result.asyncJobs.map(job => [job.kind, job.status]), [['MEMORY', 'failed'], ['PROFILE', 'failed']]);
  assert.equal((await turn(c, handle, '今天阳光很好。', 'a2')).status, 'completed');
});

test('invalid Memory signal fields are failed without hiding successful chat or TTS', async () => {
  const base = provider();
  const saved: { module: string; evidenceRefs: string[]; output: unknown }[] = [];
  const c = createAlgorithmComposition({ onModelOutput: item => saved.push(item), provider: provider({
    async json(system, input, options) {
      const value = await base.json(system, input, options) as any;
      if (options.module === 'memory') {
        value.proposals[0].signals.shortTerm = 'HISTORICAL';
        value.proposals[0].signals.temporalState = false;
      }
      return value;
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我平时喜欢听京剧。', 'invalid-memory');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.equal(result.asyncJobs[0].status, 'failed');
  assert.equal(result.asyncJobs[0].errorCode, 'memory_candidate_invalid_schema');
  assert.equal(c.view(handle).memory.length, 0);
  const diagnostics = saved.filter(item => item.module === 'memory_extraction_diagnostic');
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0].output as any;
  assert.equal(diagnostic.providerProposalCount, 1);
  assert.equal(diagnostic.validCandidateCount, 0);
  assert.equal(diagnostic.rejectedCandidateCount, 1);
  assert.deepEqual(diagnostic.rejectedCandidates, [{ index: 0, reason: 'invalid_signal_shortTerm' }]);
  assert.equal(diagnostic.semanticAcceptedCount, 0);
  assert.equal(diagnostic.semanticRejectedCount, 1);
  assert.equal(diagnostic.extractionCompleteness, 'REJECTED');
  assert.equal(diagnostic.partial, false);
  assert.equal(diagnostic.processingStatus, 'FAILED');
  assert.equal(diagnostic.commitStatus, 'NOT_ATTEMPTED');
  assert.equal(diagnostic.finalSubmissionStatus, 'FAILED');
  assert.equal(diagnostic.committedCandidateCount, 0);
  assert.equal(diagnostic.errorCode, 'memory_candidate_invalid_schema');
  assert.deepEqual(diagnostic.semanticRejections, [{ index: 0, reason: 'invalid_signal_shortTerm' }]);
  assert.deepEqual(diagnostics[0].evidenceRefs, [result.evidenceId]);
  assert.equal(JSON.stringify(diagnostic).includes('我平时喜欢听京剧'), false);
  assert.deepEqual(c.view(handle).memoryExtractions, [diagnostic]);
});

test('Memory keeps valid candidates when another provider proposal has an unverifiable span', async () => {
  const base = provider();
  const saved: { module: string; evidenceRefs: string[]; output: unknown }[] = [];
  const c = createAlgorithmComposition({ onModelOutput: item => saved.push(item), provider: provider({
    async json(system, input, options) {
      if (options.module === 'memory') {
        const source = (input as any).evidence[0];
        return { proposals: [
          { providerProposalId: 'non-contiguous', contentType: 'life_event',
            normalizedClaim: '拼接了相隔句子的候选', query: '拼接句子',
            sourceEvidenceRefs: [source.ref],
            sourceSpans: [{ evidenceRef: source.ref, quote: '不存在的连续原文' }],
            eventTime: null, validFrom: null, validTo: null, sensitivityLevel: 'S0',
            signals: { temporalState: 'CURRENT', shortTerm: false, conflict: false,
              ambiguousSubject: false, purposeExpansion: false, visibilityExpansion: false } },
          { providerProposalId: 'valid', contentType: 'preference',
            normalizedClaim: source.text, query: source.text,
            sourceEvidenceRefs: [source.ref], sourceSpans: [{ evidenceRef: source.ref, quote: source.text }],
            eventTime: null, validFrom: null, validTo: null, sensitivityLevel: 'S0',
            signals: { temporalState: 'CURRENT', shortTerm: false, conflict: false,
              ambiguousSubject: false, purposeExpansion: false, visibilityExpansion: false } },
        ] };
      }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我喜欢听越剧。', 'mixed-memory-proposals');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.equal(result.asyncJobs[0].status, 'success');
  const records = c.view(handle).memory;
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'ACTIVE');
  assert.equal(records[0].candidate.normalizedClaim, '我喜欢听越剧。');
  assert.equal(records.some(record => record.candidate.normalizedClaim.includes('拼接')), false);
  const diagnostics = saved.filter(item => item.module === 'memory_extraction_diagnostic');
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0].output as any;
  assert.equal(diagnostic.providerProposalCount, 2);
  assert.equal(diagnostic.validCandidateCount, 1);
  assert.equal(diagnostic.rejectedCandidateCount, 1);
  assert.deepEqual(diagnostic.rejectedCandidates, [{ index: 0, reason: 'missing_verified_source_span' }]);
  assert.equal(diagnostic.semanticInputCount, 2);
  assert.equal(diagnostic.semanticAcceptedCount, 1);
  assert.equal(diagnostic.semanticRejectedCount, 1);
  assert.equal(diagnostic.outputCount, 1);
  assert.equal(diagnostic.extractionCompleteness, 'PARTIAL');
  assert.equal(diagnostic.partial, true);
  assert.equal(diagnostic.processingStatus, 'PROCESSED');
  assert.equal(diagnostic.commitStatus, 'COMMITTED');
  assert.equal(diagnostic.finalSubmissionStatus, 'COMMITTED_PARTIAL');
  assert.equal(diagnostic.committedCandidateCount, 1);
  assert.deepEqual(diagnostic.semanticRejections, [{ index: 0, reason: 'missing_verified_source_span' }]);
  assert.equal(JSON.stringify(diagnostic).includes('越剧'), false);
  assert.deepEqual(c.view(handle).memoryExtractions, [diagnostic]);
  assert.deepEqual(c.view(start(c, 'other-family')).memoryExtractions, []);
});

test('deterministic safety candidate survives all-invalid semantic extraction with explicit partial status', async () => {
  const base = provider();
  const saved: { module: string; evidenceRefs: string[]; output: unknown }[] = [];
  const c = createAlgorithmComposition({ onModelOutput: item => saved.push(item), provider: provider({
    async json(system, input, options) {
      const value = await base.json(system, input, options) as any;
      if (options.module === 'memory') {
        value.proposals[0].normalizedClaim = '无依据候选';
        value.proposals[0].sourceSpans[0].quote = '不存在的连续原文';
      }
      return value;
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我有高血压。', 'must-extract-invalid-semantic');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.equal(result.asyncJobs[0].status, 'success');
  const records = c.view(handle).memory;
  assert.equal(records.length, 1);
  assert.equal(records[0].candidate.sensitivityLevel, 'S2');
  assert.notEqual(records[0].status, 'ACTIVE');
  assert.equal(records.some(record => record.candidate.normalizedClaim.includes('无依据候选')), false);
  const diagnostics = saved.filter(item => item.module === 'memory_extraction_diagnostic');
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0].output as any;
  assert.equal(diagnostic.mustExtractCount, 1);
  assert.equal(diagnostic.semanticAcceptedCount, 0);
  assert.equal(diagnostic.semanticRejectedCount, 1);
  assert.equal(diagnostic.extractionCompleteness, 'PARTIAL');
  assert.equal(diagnostic.partial, true);
  assert.equal(diagnostic.commitStatus, 'COMMITTED');
  assert.equal(diagnostic.committedCandidateCount, 1);
  assert.deepEqual(c.view(handle).memoryExtractions, [diagnostic]);
  await turn(c, handle, '刚才这段不要存。', 'withdraw-partial-extraction');
  assert.equal(c.view(handle).memoryExtractions.some(item => item.evidenceRefs.includes(result.evidenceId!)), false);
});

test('invalid profile value and temporal scope do not publish a draft or discard successful Memory', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ derivedPurposes: ['profile_draft'], provider: provider({
    async json(system, input, options) {
      const value = await base.json(system, input, options) as any;
      if (options.module === 'profile_draft') {
        value.fields[0].value = ['听越剧'];
        value.fields[0].temporalScope = 'UNKNOWN_TIME';
      }
      return value;
    },
  }) });
  const handle = start(c);
  const result = await turn(c, handle, '我现在喜欢听越剧，请整理我的爱好画像。', 'invalid-profile');
  assert.equal(result.response?.status, 'success');
  assert.equal(result.tts.status, 'success');
  assert.deepEqual(result.asyncJobs.map(job => [job.kind, job.status]), [['MEMORY', 'success'], ['PROFILE', 'failed']]);
  assert.equal(c.view(handle).artifacts.length, 0);
  assert.ok(c.view(handle).memory.some(record => record.status === 'ACTIVE'));
});

test('cross-turn withdrawal removes Memory and derived view before policy delivery', async () => {
  const c = createAlgorithmComposition({ provider: provider(), derivedPurposes: ['profile_draft'] });
  const handle = start(c);
  await turn(c, handle, '我喜欢听越剧，请整理我的爱好画像。', 'a1');
  assert.equal(c.view(handle).artifacts.length, 1);
  const result = await turn(c, handle, '刚才这段不要存。', 'a2');
  assert.equal(result.retentionEffect?.scope, 'PREVIOUS_COMPLETED_TURN');
  assert.equal(result.retentionEffect?.downstreamStatus, 'APPLIED');
  assert.equal(c.view(handle).memory.length, 0);
  assert.equal(c.view(handle).artifacts.length, 0);
});

test('explicit interview transition runs natural realizer while refused topics and follow-up depth persist', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  const first = await turn(c, handle, '我第一次去厂里上班是1968年，那天有点下雨，周师傅带我去认机器，后来还借给我一件雨衣。', 'a1', true);
  assert.equal(first.mode, 'FORMAL_INTERVIEW');
  assert.equal(first.response?.status, 'success');
  assert.equal(first.response?.questionCount, 1);
  const second = await turn(c, handle, '那天周师傅带我看织布机。', 'a2');
  assert.equal(second.status, 'completed');
  assert.equal(second.response?.questionCount, 1);
  assert.equal(c.view(handle).interviewPolicyVersion, 'interview-policy-v0.3.4');
  assert.equal(c.orchestrator.getSessionSnapshot(handle).interviewState.followUpDepth, 2);
  const limited = await turn(c, handle, '后来我先记住了几个零件的名字。', 'a2-limit');
  assert.equal(limited.response?.status, 'policy_direct');
  assert.equal(limited.response?.policyEngine, 'InterviewPolicyV0.2');
  assert.equal(limited.response?.action, 'CLARIFY');
  assert.equal(limited.response?.questionCount, 1);
  assert.match(limited.response?.text ?? '', /还愿意继续讲|还想接着讲|今天先到这里|今天先休息/u);
  assert.doesNotMatch(limited.response?.text ?? '', /收住精力|把.*经历收住/u);
  assert.equal(c.orchestrator.getSessionSnapshot(handle).interviewState.followUpDepth, 0);
  const stopped = await turn(c, handle, '我有点累，先停一下。', 'a3');
  assert.equal(stopped.response?.sessionControl, 'PAUSE');
  assert.equal(c.view(handle).status, 'PAUSED');
});

test('explicit continue after a natural pause reopens one low-load follow-up', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  await turn(c, handle, '我第一次在厂里工作，师傅教我认机器。', 'continue-start', true);
  await turn(c, handle, '后来我慢慢记住了几个零件。', 'continue-detail');
  const pause = await turn(c, handle, '那天我还学会了看刻度。', 'continue-pause');
  assert.equal(pause.response?.action, 'CLARIFY');
  assert.match(pause.response?.text ?? '', /还愿意继续讲|还想接着讲|今天先到这里|今天先休息/u);
  assert.doesNotMatch(pause.response?.text ?? '', /收住精力|把.*经历收住/u);
  const resumed = await turn(c, handle, '继续吧。', 'continue-resume');
  assert.equal(resumed.response?.action, 'FOLLOW_UP');
  assert.equal(resumed.response?.questionCount, 1);
  assert.match(resumed.response?.text ?? '', /接着聊|还想补充/u);
});

test('a named topic switch is respected after the follow-up limit and is not durable Memory', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  await turn(c, handle, '我第一次到镇里的工厂，师傅带我认工具。', 'switch-start', true);
  await turn(c, handle, '我学会量零件，后来还能准备车床工具。', 'switch-detail');
  await turn(c, handle, '那段工作先聊到这里吧，我想换个轻松话题，聊聊后来在阳台种花的事。', 'switch-new');
  const snapshot = c.orchestrator.getSessionSnapshot(handle);
  assert.equal(snapshot.interviewState.currentTopic, '后来在阳台种花');
  assert.equal(snapshot.interviewState.followUpDepth, 0);
  assert.equal(c.view(handle).memory.some(record => record.status === 'ACTIVE'
    && record.candidate.normalizedClaim.includes('换个轻松话题')), false);
});

test('a named topic switch also updates action and topic before the follow-up limit', async () => {
  const c = createAlgorithmComposition({ provider: provider() });
  const handle = start(c);
  await turn(c, handle, '我第一次到镇里的工厂，师傅带我认工具。', 'switch-before-start', true);
  assert.equal(c.orchestrator.getSessionSnapshot(handle).interviewState.followUpDepth, 1);
  const switched = await turn(c, handle,
    '那段工作先聊到这里吧，我想换个轻松话题，聊聊后来在阳台种花的事。', 'switch-before-new');
  assert.equal(switched.response?.action, 'SWITCH_TOPIC');
  const snapshot = c.orchestrator.getSessionSnapshot(handle);
  assert.equal(snapshot.interviewState.currentTopic, '后来在阳台种花');
  assert.equal(snapshot.interviewState.followUpDepth, 0);
  assert.equal(c.view(handle).memory.some(record =>
    record.candidate.evidenceRefs.includes(switched.evidenceId!)), false);
});

test('taboo takes effect before generation and removes restricted Memory and derived reuse', async () => {
  const calls: { module: string; input: unknown }[] = [];
  const base = provider();
  const c = createAlgorithmComposition({ derivedPurposes: ['profile_draft'], provider: provider({
    async json(system, input, options) {
      calls.push({ module: options.module, input: structuredClone(input) });
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  await turn(c, handle, '我喜欢京剧，请整理我的爱好画像。', 'a1');
  assert.equal(c.view(handle).artifacts.length, 1);
  const before = calls.length;
  const restricted = await turn(c, handle, '以后不要再提京剧。', 'a2');
  assert.equal(restricted.response?.status, 'policy_direct');
  assert.equal(calls.length, before);
  assert.equal(c.view(handle).artifacts.length, 0);
  await turn(c, handle, '我们继续聊吧。', 'a3');
  const latest = calls.filter(call => call.module === 'daily_chat').at(-1)!;
  assert.equal(JSON.stringify(latest.input).includes('京剧'), false);
  await turn(c, handle, '我以前喜欢京剧。', 'a4');
  assert.equal(c.view(handle).memory.some(record => record.status === 'ACTIVE'
    && record.candidate.normalizedClaim.includes('京剧')), false);
});

test('explicit correction supersedes the unambiguous previous preference and invalidates its derived view', async () => {
  const calls: { module: string; input: unknown }[] = [];
  const base = provider();
  const c = createAlgorithmComposition({ derivedPurposes: ['profile_draft'], provider: provider({
    async json(system, input, options) {
      calls.push({ module: options.module, input: structuredClone(input) });
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  await turn(c, handle, '我喜欢京剧，请整理我的爱好画像。', 'a1');
  const prior = c.view(handle).memory.find(record => record.status === 'ACTIVE')!;
  await turn(c, handle, '不对，我现在喜欢越剧。', 'a2');
  assert.equal(c.memoryStore.get(prior.recordId)?.status, 'SUPERSEDED');
  assert.equal(c.view(handle).artifacts.length, 0);
  await turn(c, handle, '我们继续聊吧。', 'a3');
  const latest = calls.filter(call => call.module === 'daily_chat').at(-1)!.input as { allowedMemory: string[] };
  assert.ok(latest.allowedMemory.some(text => text.includes('越剧')));
  assert.equal(latest.allowedMemory.some(text => text.includes('京剧')), false);
});

test('cancelled model output cannot reach audio, Memory or client events', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const events: AlgorithmOutputEvent[] = [];
  const base = provider();
  const c = createAlgorithmComposition({ onEvent: (_handle, event) => events.push(event), provider: provider({
    async json(system, input, options) {
      if (options.module === 'daily_chat') { entered(); await delayed; }
      return base.json(system, input, options);
    },
  }) });
  const handle = start(c);
  const pending = turn(c, handle, '我喜欢听越剧。', 'a1');
  await ready;
  const targetHandle = c.orchestrator.getCurrentTarget(handle)!;
  assert.equal(c.orchestrator.interrupt(handle, { schemaVersion: 'orchestrated-interrupt-v0.1',
    idempotencyToken: 'stop-a1', targetHandle, reason: 'user_speech' }).accepted, true);
  release();
  assert.equal((await pending).status, 'interrupted');
  assert.equal(events.filter(event => event.type === 'text' || event.type === 'audio' || event.type === 'memory').length, 0);
  assert.equal(c.view(handle).memory.length, 0);
});

test('one-off operations are session-only while a real preference in the same utterance survives', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      const value = await base.json(system, input, options) as any;
      if (options.module === 'memory' && !(input as any).evidence[0].text.includes('说慢一点')) {
        value.proposals[0].normalizedClaim = (input as any).evidence[0].text.includes('越剧')
          ? '用户喜欢越剧并希望结合当前爱好继续开展聊天'
          : '用户希望结合自己当下的爱好继续开展聊天';
      }
      return value;
    },
  }) });
  const handle = start(c);
  await turn(c, handle, '根据我现在的爱好，我们接着聊吧。', 'operation-only');
  assert.equal(c.view(handle).memory.length, 0);
  await turn(c, handle, '我现在喜欢越剧，请根据我的爱好继续聊。', 'fact-and-operation');
  const facts = c.view(handle).memory.filter(record => record.status === 'ACTIVE');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].candidate.normalizedClaim, '我现在喜欢越剧');
  await turn(c, handle, '以后每次聊天请说慢一点。', 'recurring-preference');
  assert.ok(c.view(handle).memory.some(record => record.status === 'ACTIVE'
    && record.candidate.normalizedClaim.includes('说慢一点')));
});

test('interview control utterances stay session-only and do not pollute derived sources', async () => {
  const c = createAlgorithmComposition({ provider: provider(), derivedPurposes: ['story_draft', 'profile_draft'] });
  const handle = start(c);
  const entered = await turn(c, handle, '我愿意聊聊以前在纺织厂工作的日子。', 'control-entry', true);
  assert.equal(entered.mode, 'FORMAL_INTERVIEW');
  assert.deepEqual(entered.asyncJobs, []);
  assert.equal(c.view(handle).memory.filter(record => record.status === 'ACTIVE').length, 0);

  const switched = await turn(c, handle, '这段先聊到这里，我们说说后来在阳台种花的事。', 'control-switch');
  assert.deepEqual(switched.asyncJobs, []);
  const continued = await turn(c, handle, '我休息好了，继续吧。', 'control-continue');
  assert.deepEqual(continued.asyncJobs, []);
  assert.equal(c.view(handle).memory.filter(record => record.status === 'ACTIVE').length, 0);
});

test('withdrawal during another session generation blocks old-source output and leaves own-source Memory independent', async () => {
  const base = provider();
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const saved: { module: string; evidenceRefs: string[] }[] = [];
  const c = createAlgorithmComposition({ onModelOutput: item => saved.push(item), provider: provider({
    async json(system, input, options) {
      if (options.module === 'daily_chat' && (input as any).currentInput.join('').includes('今天阳光')) {
        entered(); await wait;
      }
      return base.json(system, input, options);
    },
  }) });
  const a = start(c);
  const old = await turn(c, a, '我喜欢听越剧。', 'saved-pref');
  const b = c.orchestrator.startSession({ schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: 'same-person-new-session', requestedMode: 'DAILY_CHAT' }, authority()).opaqueSessionHandle;
  const pending = turn(c, b, '今天阳光很好。', 'pending-reply');
  await ready;
  await turn(c, a, '刚才这段不要存。', 'withdraw-old');
  const before = saved.length;
  release(); await pending;
  const newCopies = saved.slice(before);
  assert.equal(newCopies.some(item => item.evidenceRefs.includes(old.evidenceId!)), false);
  assert.ok(newCopies.some(item => item.module === 'memory'), 'this turn own-source extraction remains allowed');
});

test('natural draft requests cannot authorize old facts by quoting only the new request', async () => {
  const base = provider();
  const c = createAlgorithmComposition({ provider: provider({
    async json(system, input, options) {
      const value = await base.json(system, input, options) as any;
      if (options.module === 'memory') value.proposals[0].normalizedClaim = '用户喜欢越剧';
      return value;
    },
  }) });
  const handle = start(c);
  for (const [index, text] of [
    '把我刚才说的爱好整理成基础画像。',
    '我希望你帮忙制作一个故事草稿。',
  ].entries()) {
    await turn(c, handle, text, `natural-request-${index}`);
    assert.equal(c.view(handle).memory.filter(record => record.status === 'ACTIVE').length, 0);
  }
});
