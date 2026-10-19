import {
  assertRuntimeIdentity,
  type ProviderUsage,
  type RuntimeIdentity,
} from '../algorithm-runtime/contracts.ts';
import type {
  AsrAcceptResult,
  AsrAttemptContext,
  AsrCanonicalEvent,
  AsrPartialEvent,
  AsrReducerSnapshot,
  AsrSegmentFinalEvent,
  AsrStreamReducerOptions,
  TranscriptEvidence,
} from './contracts.ts';

const USAGE_FIELDS = new Set<keyof ProviderUsage>([
  'inputAudioMs',
  'outputAudioMs',
  'inputCharacters',
  'outputCharacters',
  'inputTokens',
  'outputTokens',
  'totalTokens',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value: unknown, minimum?: number): value is number {
  return Number.isSafeInteger(value)
    && (minimum === undefined || (value as number) >= minimum);
}

function cloneIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return { ...identity, evidenceRefs: [...identity.evidenceRefs] };
}

function identitiesEqual(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionEpoch === right.sessionEpoch
    && left.turnId === right.turnId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId
    && left.responseId === right.responseId
    && left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((item, index) => item === right.evidenceRefs[index]);
}

function generationKey(identity: RuntimeIdentity): string {
  return JSON.stringify([
    identity.sessionEpoch,
    identity.turnId,
    identity.generationId,
  ]);
}

function segmentKey(identity: RuntimeIdentity, segmentIndex: number): string {
  return JSON.stringify([
    identity.sessionEpoch,
    identity.turnId,
    identity.generationId,
    segmentIndex,
  ]);
}

function eventSequenceSlot(event: AsrCanonicalEvent): string {
  if (event.kind === 'partial' || event.kind === 'segment_final') {
    return JSON.stringify([event.providerSequence, 'segment', event.segmentIndex]);
  }
  return JSON.stringify([event.providerSequence, event.kind]);
}

function stableUsage(usage: ProviderUsage): string {
  return JSON.stringify(
    Object.entries(usage).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function eventFingerprint(event: AsrCanonicalEvent): string {
  if (event.kind === 'partial' || event.kind === 'segment_final') {
    return JSON.stringify([
      event.kind,
      event.providerPacketFingerprint ?? null,
      event.segmentIndex,
      event.revision,
      event.text,
      event.providerSegmentId ?? null,
      event.startTimeMs ?? null,
      event.endTimeMs ?? null,
    ]);
  }
  if (event.kind === 'usage') {
    return JSON.stringify([
      event.kind,
      event.providerPacketFingerprint ?? null,
      stableUsage(event.usage),
    ]);
  }
  return JSON.stringify([event.kind, event.providerPacketFingerprint ?? null]);
}

function invalidSchema(): AsrAcceptResult {
  return {
    accepted: false,
    reason: 'invalid_schema',
    errorCode: 'invalid_schema',
    fatal: true,
  };
}

function incompleteStream(): AsrAcceptResult {
  return {
    accepted: false,
    reason: 'incomplete_stream',
    errorCode: 'incomplete_stream',
  };
}

function rejected(reason: Exclude<AsrAcceptResult, { accepted: true }>['reason']): AsrAcceptResult {
  return { accepted: false, reason };
}

function normalizeUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const usage: ProviderUsage = {};
  for (const [key, item] of entries) {
    if (!USAGE_FIELDS.has(key as keyof ProviderUsage)) return undefined;
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return undefined;
    usage[key as keyof ProviderUsage] = item;
  }
  return usage;
}

function normalizeIdentity(value: unknown): RuntimeIdentity | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return cloneIdentity(assertRuntimeIdentity(value as unknown as RuntimeIdentity));
  } catch {
    return undefined;
  }
}

function normalizeEvent(value: unknown): AsrCanonicalEvent | undefined {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return undefined;
  const identity = normalizeIdentity(value.identity);
  if (
    !identity
    || !nonEmptyString(value.attemptId)
    || !nonEmptyString(value.connectionId)
    || !nonEmptyString(value.receivedAt)
    || Number.isNaN(Date.parse(value.receivedAt))
    || !integer(value.providerSequence)
    || (value.providerPacketFingerprint !== undefined
      && !nonEmptyString(value.providerPacketFingerprint))
  ) {
    return undefined;
  }
  const base = {
    identity,
    attemptId: value.attemptId,
    connectionId: value.connectionId,
    receivedAt: value.receivedAt,
    providerSequence: value.providerSequence,
    ...(value.providerPacketFingerprint === undefined
      ? {}
      : { providerPacketFingerprint: value.providerPacketFingerprint }),
  };

  if (value.kind === 'usage') {
    const usage = normalizeUsage(value.usage);
    return usage ? { ...base, kind: 'usage', usage } : undefined;
  }
  if (value.kind === 'stream_final') {
    return { ...base, kind: 'stream_final' };
  }
  if (value.kind !== 'partial' && value.kind !== 'segment_final') return undefined;
  if (
    !integer(value.segmentIndex, 0)
    || !integer(value.revision, 0)
    || !nonEmptyString(value.text)
  ) {
    return undefined;
  }
  if (value.providerSegmentId !== undefined && !nonEmptyString(value.providerSegmentId)) {
    return undefined;
  }
  for (const time of [value.startTimeMs, value.endTimeMs]) {
    if (time !== undefined && (
      typeof time !== 'number' || !Number.isFinite(time) || time < 0
    )) return undefined;
  }
  if (
    typeof value.startTimeMs === 'number'
    && typeof value.endTimeMs === 'number'
    && value.startTimeMs > value.endTimeMs
  ) {
    return undefined;
  }
  const providerSegmentId = typeof value.providerSegmentId === 'string'
    ? value.providerSegmentId
    : undefined;
  const startTimeMs = typeof value.startTimeMs === 'number'
    ? value.startTimeMs
    : undefined;
  const endTimeMs = typeof value.endTimeMs === 'number'
    ? value.endTimeMs
    : undefined;
  const segment = {
    ...base,
    segmentIndex: value.segmentIndex as number,
    revision: value.revision as number,
    text: value.text as string,
    ...(providerSegmentId === undefined ? {} : { providerSegmentId }),
    ...(startTimeMs === undefined ? {} : { startTimeMs }),
    ...(endTimeMs === undefined ? {} : { endTimeMs }),
  };
  return value.kind === 'partial'
    ? { ...segment, kind: 'partial' }
    : { ...segment, kind: 'segment_final' };
}

export class AsrStreamReducer {
  private readonly options: AsrStreamReducerOptions;
  private activeAttempt?: AsrAttemptContext;
  private currentGenerationKey?: string;
  private readonly sequenceFingerprints = new Map<string, string>();
  private readonly packetFingerprintBySequence = new Map<number, string | null>();
  private readonly revisionTextBySegment = new Map<number, Map<number, string>>();
  private readonly latestRevisionBySegment = new Map<number, number>();
  private readonly pendingFinals = new Map<number, AsrSegmentFinalEvent>();
  private readonly unresolvedPartialSegments = new Set<number>();
  private readonly committedFinals = new Map<string, AsrSegmentFinalEvent>();
  private readonly nextSegmentByGeneration = new Map<string, number>();
  private usage?: ProviderUsage;
  private streamFinal = false;
  private fatalError?: 'invalid_schema';

  constructor(options: AsrStreamReducerOptions) {
    this.options = options;
  }

  beginAttempt(context: AsrAttemptContext): void {
    assertRuntimeIdentity(context.identity);
    if (!nonEmptyString(context.attemptId) || !nonEmptyString(context.connectionId)) {
      throw new Error('attemptId and connectionId must be non-empty strings');
    }
    const acceptance = this.options.cancellationRegistry.accepts(context.identity, 'asr');
    if (!acceptance.accepted) {
      throw new Error(`cannot begin inactive ASR attempt: ${acceptance.reason ?? 'rejected'}`);
    }

    this.activeAttempt = {
      identity: cloneIdentity(context.identity),
      attemptId: context.attemptId,
      connectionId: context.connectionId,
    };
    this.currentGenerationKey = generationKey(context.identity);
    this.sequenceFingerprints.clear();
    this.packetFingerprintBySequence.clear();
    this.revisionTextBySegment.clear();
    this.latestRevisionBySegment.clear();
    this.pendingFinals.clear();
    this.unresolvedPartialSegments.clear();
    this.usage = undefined;
    this.streamFinal = false;
    this.fatalError = undefined;
  }

  accept(input: unknown): AsrAcceptResult {
    const event = normalizeEvent(input);
    if (!event) return this.failClosed();
    if (!this.activeAttempt) return rejected('no_active_attempt');
    if (
      event.attemptId !== this.activeAttempt.attemptId
      || event.connectionId !== this.activeAttempt.connectionId
      || !identitiesEqual(event.identity, this.activeAttempt.identity)
    ) {
      return rejected('stale_connection');
    }

    const acceptance = this.options.cancellationRegistry.accepts(event.identity, 'asr');
    if (!acceptance.accepted) {
      const reason = acceptance.reason;
      if (
        reason === 'generation_mismatch'
        || reason === 'response_id_missing'
        || reason === 'response_id_mismatch'
        || reason === 'evidence_mismatch'
        || reason === 'cancelled'
        || reason === 'finalized'
      ) {
        return rejected(reason);
      }
      return rejected('generation_mismatch');
    }
    if (this.fatalError) return rejected('fatal_conflict');

    const packetFingerprint = event.providerPacketFingerprint ?? null;
    if (this.packetFingerprintBySequence.has(event.providerSequence)) {
      if (this.packetFingerprintBySequence.get(event.providerSequence) !== packetFingerprint) {
        return this.failClosed();
      }
    } else {
      this.packetFingerprintBySequence.set(event.providerSequence, packetFingerprint);
    }

    const sequenceSlot = eventSequenceSlot(event);
    const fingerprint = eventFingerprint(event);
    const priorSequence = this.sequenceFingerprints.get(sequenceSlot);
    if (priorSequence !== undefined) {
      if (priorSequence !== fingerprint) return this.failClosed();
      if (event.kind === 'segment_final') {
        const pending = this.pendingFinals.get(event.segmentIndex);
        if (pending && eventFingerprint(pending) === fingerprint) {
          this.flushContiguousFinals(event.identity);
          return this.committedFinals.has(segmentKey(event.identity, event.segmentIndex))
            ? { accepted: true }
            : rejected('duplicate');
        }
      }
      return rejected('duplicate');
    }
    this.sequenceFingerprints.set(sequenceSlot, fingerprint);

    switch (event.kind) {
      case 'partial':
        return this.acceptPartial(event);
      case 'segment_final':
        return this.acceptSegmentFinal(event);
      case 'usage':
        return this.acceptUsage(event.usage);
      case 'stream_final':
        return this.acceptStreamFinal();
    }
  }

  snapshot(): AsrReducerSnapshot {
    const currentKey = this.currentGenerationKey;
    let emittedSegmentCount = 0;
    if (currentKey) {
      for (const event of this.committedFinals.values()) {
        if (generationKey(event.identity) === currentKey) emittedSegmentCount += 1;
      }
    }
    return {
      ...(this.activeAttempt
        ? {
            activeAttempt: {
              ...this.activeAttempt,
              identity: cloneIdentity(this.activeAttempt.identity),
            },
          }
        : {}),
      ...(this.usage ? { usage: { ...this.usage } } : {}),
      streamFinal: this.streamFinal,
      pendingSegmentIndexes: [...this.pendingFinals.keys()].sort((left, right) => left - right),
      emittedSegmentCount,
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
    };
  }

  private acceptPartial(event: AsrPartialEvent): AsrAcceptResult {
    if (this.streamFinal) return rejected('after_stream_final');
    const key = segmentKey(event.identity, event.segmentIndex);
    if (this.committedFinals.has(key)) return rejected('final_already_committed');

    const revisionResult = this.checkAndRememberRevision(event);
    if (revisionResult) return revisionResult;
    this.unresolvedPartialSegments.add(event.segmentIndex);
    this.options.onPartial?.({
      ...event,
      identity: cloneIdentity(event.identity),
    });
    return { accepted: true };
  }

  private acceptSegmentFinal(event: AsrSegmentFinalEvent): AsrAcceptResult {
    const key = segmentKey(event.identity, event.segmentIndex);
    const committed = this.committedFinals.get(key);
    if (committed) {
      return committed.text === event.text
        ? rejected('duplicate')
        : this.failClosed();
    }
    if (this.streamFinal) return this.failClosed();

    const revisionResult = this.checkAndRememberRevision(event, true);
    if (revisionResult) return revisionResult;
    const pending = this.pendingFinals.get(event.segmentIndex);
    if (pending) {
      if (pending.text !== event.text) return this.failClosed();
      this.flushContiguousFinals(event.identity);
      return this.committedFinals.has(key)
        ? { accepted: true }
        : rejected('duplicate');
    }
    this.pendingFinals.set(event.segmentIndex, event);
    this.flushContiguousFinals(event.identity);
    return { accepted: true };
  }

  private acceptUsage(usage: ProviderUsage): AsrAcceptResult {
    if (!this.usage) {
      this.usage = { ...usage };
      return { accepted: true };
    }
    return stableUsage(this.usage) === stableUsage(usage)
      ? rejected('duplicate')
      : this.failClosed();
  }

  private acceptStreamFinal(): AsrAcceptResult {
    if (this.streamFinal) return rejected('duplicate');
    if (this.pendingFinals.size > 0 || this.unresolvedPartialSegments.size > 0) {
      return incompleteStream();
    }
    this.streamFinal = true;
    return { accepted: true };
  }

  private checkAndRememberRevision(
    event: AsrPartialEvent | AsrSegmentFinalEvent,
    allowFinalAtSameRevision = false,
  ): AsrAcceptResult | undefined {
    let revisions = this.revisionTextBySegment.get(event.segmentIndex);
    if (!revisions) {
      revisions = new Map<number, string>();
      this.revisionTextBySegment.set(event.segmentIndex, revisions);
    }
    const knownText = revisions.get(event.revision);
    if (knownText !== undefined && knownText !== event.text) return this.failClosed();

    const latest = this.latestRevisionBySegment.get(event.segmentIndex);
    if (latest !== undefined && event.revision < latest) return rejected('stale_revision');
    if (
      latest !== undefined
      && event.revision === latest
      && knownText === event.text
      && !allowFinalAtSameRevision
    ) {
      return rejected('duplicate');
    }

    revisions.set(event.revision, event.text);
    if (latest === undefined || event.revision > latest) {
      this.latestRevisionBySegment.set(event.segmentIndex, event.revision);
    }
    return undefined;
  }

  private flushContiguousFinals(identity: RuntimeIdentity): void {
    const key = generationKey(identity);
    let next = this.nextSegmentByGeneration.get(key) ?? 0;
    while (this.pendingFinals.has(next)) {
      const event = this.pendingFinals.get(next)!;
      const logicalSegmentKey = segmentKey(event.identity, event.segmentIndex);
      if (this.committedFinals.has(logicalSegmentKey)) {
        this.pendingFinals.delete(next);
        this.unresolvedPartialSegments.delete(event.segmentIndex);
        next += 1;
        this.nextSegmentByGeneration.set(key, next);
        continue;
      }
      const evidence: TranscriptEvidence = {
        kind: 'transcript_final',
        evidenceId: logicalSegmentKey,
        segmentKey: logicalSegmentKey,
        identity: cloneIdentity(event.identity),
        attemptId: event.attemptId,
        connectionId: event.connectionId,
        receivedAt: event.receivedAt,
        providerSequence: event.providerSequence,
        ...(event.providerPacketFingerprint === undefined
          ? {}
          : { providerPacketFingerprint: event.providerPacketFingerprint }),
        segmentIndex: event.segmentIndex,
        revision: event.revision,
        text: event.text,
        ...(event.providerSegmentId === undefined
          ? {}
          : { providerSegmentId: event.providerSegmentId }),
        ...(event.startTimeMs === undefined ? {} : { startTimeMs: event.startTimeMs }),
        ...(event.endTimeMs === undefined ? {} : { endTimeMs: event.endTimeMs }),
      };
      this.options.onEvidence?.(evidence as unknown as Record<string, unknown>);
      this.committedFinals.set(logicalSegmentKey, event);
      this.pendingFinals.delete(next);
      this.unresolvedPartialSegments.delete(event.segmentIndex);
      next += 1;
      this.nextSegmentByGeneration.set(key, next);
    }
    this.nextSegmentByGeneration.set(key, next);
  }

  private failClosed(): AsrAcceptResult {
    this.fatalError = 'invalid_schema';
    return invalidSchema();
  }
}
