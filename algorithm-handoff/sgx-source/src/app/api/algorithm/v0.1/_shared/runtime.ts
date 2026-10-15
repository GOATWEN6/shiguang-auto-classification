import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { internalErrorBody, requestId } from './http-error-boundary.ts';

import {
  createAlgorithmHttpService, TurnOrchestrator,
  type AsyncJobAdapter, type TrustedSessionAuthority, type TurnProcessingAdapter,
  type TurnRunResult,
} from '../../../../../lib/turn-orchestrator/index.ts';
import {
  createAlgorithmComposition, createLiveProvider, readLiveProviderConfig,
  type AlgorithmOutputEvent, type ProviderAttemptAudit,
} from '../../../../../lib/algorithm-service/index.ts';
import { INTERVIEW_CONTINUATION_POLICY_VERSION } from '../../../../../lib/interview-policy/index.ts';
import type { AlgorithmRuntimeFingerprint } from '../../../../../lib/turn-orchestrator/http-service.ts';
import { createInternalTestBudget, INTERNAL_TEST_BUDGET_POLICY } from '../../../../../lib/algorithm-service/internal-test-budget.ts';
import { createInternalContentRetention } from '../../../../../lib/algorithm-service/content-retention.ts';
import { createDiagnosticRetention } from '../../../../../lib/algorithm-service/diagnostic-retention.ts';
import { createRetentionSweepDiagnostics, runRetentionSweepSafely } from '../../../../../lib/algorithm-service/retention-diagnostics.ts';
import { openLiveStreamingAsr, type LiveStreamingAsrSession } from '../../../../../lib/algorithm-service/streaming-asr.ts';
import {
  createAlgorithmCostLedger, fingerprintClientIp,
  type AlgorithmCostContext, type AlgorithmCostTable,
} from '../../../../../lib/algorithm-service/cost-ledger.ts';

const fakeAuthority: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1', actorId: 'actor-internal-fiction-001',
  subjectId: 'elder-internal-fiction-001', familySpaceId: 'family-internal-fiction-001',
  authorizationVersion: 'auth-internal-test-v0.1', visibilityScope: ['elder_only'],
};
const processing: TurnProcessingAdapter = {
  async respond(request) {
    return { status: request.signal.aborted ? 'cancelled' : 'success',
      text: request.signal.aborted ? '' : '我在听，我们慢慢聊。',
      policyEngine: request.mode === 'DAILY_CHAT' ? 'DailyChatPolicy' : 'InterviewPolicyV0.2',
      action: 'RESPOND', questionCount: 0, evidenceRefs: [...request.identity.evidenceRefs],
      retentionIntent: 'DEFAULT', retentionScope: 'NONE', sessionControl: 'CONTINUE' };
  },
  async synthesize(request) {
    return { status: request.signal.aborted ? 'cancelled' : 'skipped', audioChunkCount: 0 };
  },
  planAsyncJobs() { return []; },
};
function unusedAsyncAdapter(): AsyncJobAdapter {
  return { async run() { return { ok: false, errorCode: 'not_scheduled' }; },
    async commit(context) { return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED'; } };
}

function makeRuntime() {
  const real = process.env.SGX_ALGORITHM_MODE === 'real';
  const listeners = new Map<string, Set<(event: AlgorithmOutputEvent) => void>>();
  const attempts: ProviderAttemptAudit[] = [];
  const runDir = join(process.cwd(), 'harness/live-baseline/v0.1/.local-runs/http-current');
  const content = createInternalContentRetention(join(runDir, 'content'));
  const costLedger = createAlgorithmCostLedger({ directory: runDir });
  const costContext = new AsyncLocalStorage<AlgorithmCostContext>();
  const streamOperations = new Map<string, { fingerprint: string; result: Promise<unknown>; completedResult?: unknown }>();
  let configurationReady = true;
  const batchCap = Number(process.env.SGX_INTERNAL_BATCH_CAP_CNY ?? 0);
  const priorExposure = Number(process.env.SGX_INTERNAL_PRIOR_EXPOSURE_CNY ?? INTERNAL_TEST_BUDGET_POLICY.programHardCapCny);
  const budgetLedger = createInternalTestBudget({ directory: runDir,
    batchCapCny: batchCap, priorExposureCny: priorExposure });
  let budgetAuthorized = real && budgetLedger.authorized;
  if (budgetAuthorized) {
    try { budgetLedger.snapshot(); } catch { budgetAuthorized = false; }
  }
  const publish = (handle: string, event: AlgorithmOutputEvent) => {
    for (const listener of listeners.get(handle) ?? []) listener(event);
  };
  let provider: ReturnType<typeof createLiveProvider> | null = null;
  let config: ReturnType<typeof readLiveProviderConfig> | null = null;
  const recordAttempt = (audit: ProviderAttemptAudit) => {
    attempts.push(audit);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(runDir, 'attempts.jsonl'), `${JSON.stringify(audit)}\n`, { mode: 0o600 });
  };
  const reserveAttempt = (module: string, id: string) => {
    if (!budgetAuthorized) throw new Error('budget_review_required');
    const reserved = budgetLedger.reserve(module, id);
    costLedger.record(costContext.getStore(), { module, requestId: id, reservedCny: reserved });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const status = budgetLedger.status();
    appendFileSync(join(runDir, 'reservations.jsonl'), `${JSON.stringify({ requestId: id, module,
      reservedCny: reserved, cumulativeReservedCny: status.cumulativeReservedCny,
      ownerReportRequired: status.ownerReportRequired, occurredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  };
  if (real) {
    try {
      config = readLiveProviderConfig(process.env);
      provider = createLiveProvider(config, recordAttempt, { beforeAttempt: reserveAttempt });
    } catch { configurationReady = false; }
  }
  let composition: ReturnType<typeof createAlgorithmComposition> | null = null;
  const diagnosticContent = createDiagnosticRetention(join(runDir, '..'),
    ref => composition?.sourceExpiresAt(ref) ?? null);
  const retentionDiagnostics = createRetentionSweepDiagnostics(runDir);
  const safeSweep = (operation: 'content_sweep' | 'diagnostic_sweep', sweep: () => unknown) =>
    runRetentionSweepSafely(operation, sweep, diagnostic => { retentionDiagnostics.record(diagnostic); });
  composition = provider ? createAlgorithmComposition({ provider,
    derivedPurposes: ['story_draft', 'profile_draft'], conversationPurposes: ['daily_chat', 'formal_interview'],
    semanticTurnShadow: { enabled: process.env.SGX_SEMANTIC_TURN_SHADOW === '1' },
    onEvent: publish,
    onModelOutput(item) {
      const deadlines = item.evidenceRefs.map(ref => [ref, composition?.sourceExpiresAt(ref)] as const);
      if (deadlines.some(([, expiry]) => !expiry)) return;
      content.retain({ sessionEpoch: item.identity.sessionEpoch,
        evidenceRefs: item.evidenceRefs, kind: `model:${item.module}`, value: item.output,
        sourceExpiresAt: Object.fromEntries(deadlines) as Record<string, string> });
    },
    onWithdraw(refs) {
      content.withdraw(refs);
      diagnosticContent.withdraw(refs);
      // Physically replace completed HTTP cache values when their source is revoked.
      for (const operation of streamOperations.values()) {
        const result = operation.completedResult;
        if (result && typeof result === 'object' && 'evidenceId' in result) {
          const sanitized = composition!.orchestrator.sanitizeReplayResult(result as TurnRunResult);
          operation.completedResult = sanitized;
          operation.result = Promise.resolve(sanitized);
        }
      }
    },
  }) : null;
  const orchestrator = composition?.orchestrator ?? new TurnOrchestrator({ processing,
    asyncAdapters: { MEMORY: unusedAsyncAdapter(), STORY: unusedAsyncAdapter(), PROFILE: unusedAsyncAdapter() } });
  const currentManifest = join(process.cwd(), 'harness/live-baseline/v0.1', real ? 'live-canary/manifest.json' : 'manifest.json');
  const currentFixture = join(process.cwd(), 'harness/live-baseline/v0.1', real ? 'live-canary/run-http-first-batch.mjs' : 'g5-fixtures.json');
  const fileHash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const runtimeFingerprint = (() => {
    if (!config) return undefined;
    const code = {
      promptCodeSha256: fileHash(join(process.cwd(), 'src/lib/algorithm-service/composition.ts')),
      interviewPolicyCodeSha256: fileHash(join(process.cwd(), 'src/lib/interview-policy/continuation-v03.ts')),
      responseGuardCodeSha256: fileHash(join(process.cwd(), 'src/lib/response-runtime/spoken-text.ts')),
    };
    const unsigned = {
      schemaVersion: 'algorithm-runtime-fingerprint-v0.1' as const,
      text: { model: config.text.model, temperature: 0.2, timeoutMs: config.text.timeoutMs },
      // The resource ID itself is intentionally absent from the public result.
      asr: { resourceIdSha256: createHash('sha256').update(config.asr.resourceId).digest('hex') },
      tts: {
        provider: config.tts.provider,
        model: config.tts.model,
        voiceId: config.tts.voiceId,
        outputFormat: config.tts.outputFormat,
        sampleRate: config.tts.sampleRate,
        speed: config.tts.speed,
        volume: config.tts.volume,
        pitch: config.tts.pitch,
        synthesisTimeoutMs: config.tts.synthesisTimeoutMs,
      },
      code,
    };
    return {
      ...unsigned,
      fingerprintSha256: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
    } satisfies AlgorithmRuntimeFingerprint;
  })();
  const service = createAlgorithmHttpService({ orchestrator,
    ready: () => {
      if (!real) return process.env.NODE_ENV !== 'production' || process.env.SGX_ALGORITHM_FAKE_MODE === '1';
      if (!configurationReady || !budgetAuthorized) return false;
      try { const status = budgetLedger.status(); return status.reservedCny < status.batchCapCny; }
      catch { return false; }
    },
    executionMode: real ? 'REAL_INTERNAL' : 'LOCAL_FAKE',
    providerStatus: () => ({ networkCalls: attempts.length, costCny: real ? null : 0 }),
    metadata: { buildId: process.env.SGX_ALGORITHM_BUILD_ID?.trim() || 'local-uncommitted',
      manifestSha256: fileHash(currentManifest),
      fixtureSha256: fileHash(currentFixture),
      serviceVersion: real ? 'g5-real-internal-v0.18' : 'g5-local-fake-v0.1',
      interviewPolicyVersion: INTERVIEW_CONTINUATION_POLICY_VERSION,
      ...(runtimeFingerprint ? { runtimeFingerprint } : {}) } });
  // Retention is best-effort maintenance. A malformed local artifact, clock,
  // or filesystem failure must be diagnosable without preventing the service
  // from starting or handling an HTTP request.
  safeSweep('diagnostic_sweep', () => diagnosticContent.sweep());
  const retentionTimer = setInterval(() => {
    void orchestrator.sweepExpiredEvidence().catch(() => undefined);
    safeSweep('content_sweep', () => content.sweep());
    safeSweep('diagnostic_sweep', () => diagnosticContent.sweep());
  }, 60_000);
  retentionTimer.unref();
  return { real, provider, composition, orchestrator, service, attempts, listeners, publish,
    costLedger,
    withCostContext<T>(context: AlgorithmCostContext, operation: () => T): T {
      return costContext.run(context, operation);
    },
    content, diagnosticContent,
    openStreamingAsr: (id: string, signal: AbortSignal, onPartial: (text: string) => void) => {
      if (!config) throw new Error('real_asr_unavailable');
      return openLiveStreamingAsr(config.asr, { requestId: id, signal, onPartial },
        { gate: { beforeAttempt: reserveAttempt }, onAttempt: recordAttempt });
    },
    testAuthorities: new Map<string, TrustedSessionAuthority>(),
    subjectBindings: new Map<string, TrustedSessionAuthority>(),
    asrStreams: new Map<string, { handle: string; target: string; requestId: string;
      controller: AbortController; session: LiveStreamingAsrSession; partial: string;
      pcm: Uint8Array[]; createdAt: number; nextSequence: number; eos: boolean }>(),
    asrStartKeys: new Map<string, string>(),
    pendingAudio: new Map<string, { target: string; controller: AbortController }>(),
    streamOperations,
    configurationReady, budgetAuthorized,
    budget: () => {
      if (!real) return { batchCapCny: batchCap, reservedCny: 0, actualCostCny: 0 };
      let status: ReturnType<typeof budgetLedger.status> | null = null;
      if (real) {
        try { status = budgetLedger.status(); } catch { /* Invalid ledgers never fall back to zero. */ }
      }
      return status ?? { batchCapCny: batchCap, reservedCny: null, actualCostCny: null,
        billingState: 'PENDING', programHardCapCny: INTERNAL_TEST_BUDGET_POLICY.programHardCapCny,
        ownerReportExposureCny: INTERNAL_TEST_BUDGET_POLICY.ownerReportExposureCny };
    } };
}

type Runtime = ReturnType<typeof makeRuntime>;
// Bump the in-process runtime key when composition code changes. Next dev
// reloads modules without restarting the Node process; retaining the previous
// global instance would otherwise keep the old provider/prompt functions alive
// and make the public workbench test a different algorithm than the source.
const globalRuntime = globalThis as typeof globalThis & { sgxAlgorithmRuntimeV22?: Runtime };
const runtime = globalRuntime.sgxAlgorithmRuntimeV22 ??= makeRuntime();
export const algorithmOrchestrator = runtime.orchestrator;
export const algorithmHttpService = runtime.service;
export const internalAlgorithmRuntime = runtime;

function clientIp(request: Request): { value: string; source: AlgorithmCostContext['ipSource'] } {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return { value: forwarded, source: 'forwarded' };
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return { value: real, source: 'forwarded' };
  try { return { value: new URL(request.url).hostname, source: 'direct' }; }
  catch { return { value: 'unknown', source: 'unknown' }; }
}

/**
 * Attach a request to the next provider attempts without retaining the raw IP.
 * The session snapshot supplies the stable round number; the provider request
 * ID remains the per-attempt correlation key in the private ledger.
 */
export function withAlgorithmCostContext<T>(
  request: Request,
  opaqueSessionHandle: string,
  operation: () => T,
): T {
  let snapshot: ReturnType<typeof runtime.orchestrator.getSessionSnapshot>;
  try { snapshot = runtime.orchestrator.getSessionSnapshot(opaqueSessionHandle); }
  catch { return operation(); }
  const ip = clientIp(request);
  return runtime.withCostContext({
    ipFingerprint: fingerprintClientIp(ip.value), ipSource: ip.source,
    sessionHandle: opaqueSessionHandle, sessionEpoch: snapshot.sessionEpoch,
    round: snapshot.turnCount + 1,
  }, operation);
}

export function algorithmCostTable(): AlgorithmCostTable {
  return runtime.costLedger.table();
}

export function trustedFakeAuthority(idempotencyKey?: string, subjectBinding?: string): TrustedSessionAuthority {
  if (subjectBinding) {
    const authority = runtime.subjectBindings.get(subjectBinding);
    if (!authority) throw new Error('subject_binding_not_found');
    if (idempotencyKey) {
      const existing = runtime.testAuthorities.get(idempotencyKey);
      if (existing && JSON.stringify(existing) !== JSON.stringify(authority)) throw new Error('subject_binding_conflict');
      runtime.testAuthorities.set(idempotencyKey, authority);
    }
    return structuredClone(authority);
  }
  if (!idempotencyKey) return structuredClone(fakeAuthority);
  const existing = runtime.testAuthorities.get(idempotencyKey);
  if (existing) return structuredClone(existing);
  const id = randomUUID();
  const authority = { ...fakeAuthority, actorId: `actor-fiction-${id}`,
    subjectId: `elder-fiction-${id}`, familySpaceId: `family-fiction-${id}` };
  runtime.testAuthorities.set(idempotencyKey, authority);
  return structuredClone(authority);
}
/** Opaque capability minted by this restricted runtime, never a client-supplied actor/family ID. */
export function subjectBindingFor(authority: TrustedSessionAuthority): string {
  for (const [binding, existing] of runtime.subjectBindings) {
    if (existing.subjectId === authority.subjectId && existing.familySpaceId === authority.familySpaceId) return binding;
  }
  const binding = `subject_${randomUUID()}`;
  runtime.subjectBindings.set(binding, structuredClone(authority));
  return binding;
}

export function retainTurnResult(result: unknown, rawAudio?: Uint8Array): void {
  const turn = result as { evidenceId?: string; sessionEpoch?: string; status?: string };
  if (!turn.evidenceId || !turn.sessionEpoch || !runtime.orchestrator.isEvidenceUsable(turn.evidenceId)) return;
  const replyRefs = (result as { response?: { evidenceRefs?: string[] } }).response?.evidenceRefs ?? [];
  const refs = [...new Set([turn.evidenceId, ...replyRefs])];
  const deadlines = refs.map(ref => [ref, runtime.composition?.sourceExpiresAt(ref)] as const);
  if (deadlines.some(([, expiry]) => !expiry)) return;
  runtime.content.retain({ sessionEpoch: turn.sessionEpoch, evidenceRefs: refs,
    sourceExpiresAt: Object.fromEntries(deadlines) as Record<string, string>,
    kind: 'turn', value: { result, ...(rawAudio ? { pcm16Base64: Buffer.from(rawAudio).toString('base64') } : {}) } });
}
export { requestId } from './http-error-boundary.ts';

/** Return a redacted, correlated JSON error for failures outside a business response. */
export function internalServerError(request: Request): NextResponse {
  const body = internalErrorBody(request);
  const response = NextResponse.json(body, { status: 500 });
  const id = body.requestId;
  try { response.headers.set('X-Request-ID', id); } catch { /* platform response is expected to be mutable */ }
  return response;
}
export async function jsonBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

/** The current internal test authority is usable only through a loopback host. */
export function assertInternalRequest(request: Request): void {
  const requestURL = new URL(request.url);
  const hostHeader = new URL(`http://${request.headers.get('host') || requestURL.host}`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (!loopback.includes(requestURL.hostname) || !loopback.includes(hostHeader.hostname)) throw new Error('loopback_only');
  const origin = request.headers.get('origin');
  if (origin) {
    const originURL = new URL(origin);
    if (!loopback.includes(originURL.hostname) || originURL.port !== hostHeader.port) throw new Error('same_origin_required');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new Error('same_origin_required');
}

export function internalRequestError(request: Request): NextResponse | null {
  try { assertInternalRequest(request); return null; }
  catch { return NextResponse.json({ code: 'internal_test_only',
    message: '当前接口仅供本机或 SSH 隧道内测。', retryable: false }, { status: 403 }); }
}
