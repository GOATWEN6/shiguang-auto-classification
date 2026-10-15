import {
  assertRuntimeIdentity,
  type ProviderUsage,
} from '../algorithm-runtime/contracts.ts';
import type {
  AsrCanonicalEvent,
  DoubaoTranslationContext,
} from './contracts.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('payload must contain only finite JSON numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('payload must contain only JSON-compatible values');
  if (ancestors.has(value)) fail('payload must not contain circular references');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map(key => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
        ancestors,
      )}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function packetFingerprint(payload: Record<string, unknown>): string {
  const canonical = canonicalJson(payload);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function fail(message: string, providerCode?: number): never {
  throw new DoubaoProtocolError(message, providerCode);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${field} must be a non-negative number`);
  }
  return value;
}

function usageFrom(value: unknown): ProviderUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('usage must be an object');
  const allowed = new Set([
    'inputAudioMs',
    'outputAudioMs',
    'inputCharacters',
    'outputCharacters',
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ]);
  const entries = Object.entries(value);
  if (entries.length === 0) fail('usage must not be empty');
  const usage: ProviderUsage = {};
  for (const [key, item] of entries) {
    if (!allowed.has(key)) fail(`unsupported usage field ${key}`);
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
      fail(`usage.${key} must be non-negative`);
    }
    usage[key as keyof ProviderUsage] = item;
  }
  return usage;
}

function contexts(context: DoubaoTranslationContext) {
  assertRuntimeIdentity(context.identity);
  requiredString(context.attemptId, 'attemptId');
  requiredString(context.connectionId, 'connectionId');
  requiredString(context.receivedAt, 'receivedAt');
  if (Number.isNaN(Date.parse(context.receivedAt))) fail('receivedAt must be an ISO timestamp');
  return {
    identity: { ...context.identity, evidenceRefs: [...context.identity.evidenceRefs] },
    attemptId: context.attemptId,
    connectionId: context.connectionId,
    receivedAt: context.receivedAt,
  };
}

function selectResult(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = payload.result;
  const payloadMessage = payload.payload_msg;
  const nested = isRecord(payloadMessage) ? payloadMessage.result : undefined;
  if (direct !== undefined && !isRecord(direct)) fail('result must be an object');
  if (nested !== undefined && !isRecord(nested)) fail('payload_msg.result must be an object');
  if (direct !== undefined && nested !== undefined && direct !== nested) {
    if (JSON.stringify(direct) !== JSON.stringify(nested)) {
      fail('ambiguous direct and nested Doubao results');
    }
  }
  return (direct ?? nested) as Record<string, unknown> | undefined;
}

function selectLast(payload: Record<string, unknown>): boolean {
  const direct = payload.last;
  const official = payload.is_last_package;
  if (direct !== undefined && typeof direct !== 'boolean') fail('last must be boolean');
  if (official !== undefined && typeof official !== 'boolean') {
    fail('is_last_package must be boolean');
  }
  if (direct !== undefined && official !== undefined && direct !== official) {
    fail('conflicting last indicators');
  }
  return (direct ?? official ?? false) as boolean;
}

export class DoubaoProtocolError extends Error {
  readonly code = 'invalid_schema' as const;
  readonly providerCode?: number;

  constructor(message: string, providerCode?: number) {
    super(`invalid Doubao ASR payload: ${message}`);
    this.name = 'DoubaoProtocolError';
    this.providerCode = providerCode;
  }
}

export function translateDoubaoDecodedPayload(
  input: unknown,
  context: DoubaoTranslationContext,
): AsrCanonicalEvent[] {
  if (!isRecord(input)) fail('payload must be an object');
  const payload = input;
  const providerCode = payload.code;
  if (providerCode !== undefined) {
    if (typeof providerCode !== 'number' || !Number.isSafeInteger(providerCode)) {
      fail('code must be an integer');
    }
    if (providerCode !== 0 && providerCode !== 20_000_000) {
      fail(`provider returned code ${providerCode}`, providerCode);
    }
  }
  if (
    typeof payload.payload_sequence !== 'number'
    || !Number.isSafeInteger(payload.payload_sequence)
  ) {
    fail('payload_sequence must be an integer');
  }
  const providerSequence = payload.payload_sequence as number;
  const providerPacketFingerprint = packetFingerprint(payload);
  const last = selectLast(payload);
  const result = selectResult(payload);
  const eventContext = contexts(context);
  const events: AsrCanonicalEvent[] = [];

  if (result) {
    const utterances = result.utterances;
    if (utterances !== undefined && !Array.isArray(utterances)) {
      fail('result.utterances must be an array');
    }
    const seenIndexes = new Map<number, string>();
    for (const [arrayIndex, rawUtterance] of (utterances ?? []).entries()) {
      if (!isRecord(rawUtterance)) fail('utterance must be an object');
      const explicitIndex = rawUtterance.index;
      if (explicitIndex !== undefined && (
        !Number.isSafeInteger(explicitIndex) || (explicitIndex as number) < 0
      )) {
        fail('utterance.index must be a non-negative integer');
      }
      const segmentIndex = (explicitIndex ?? arrayIndex) as number;
      if (typeof rawUtterance.definite !== 'boolean') {
        fail('utterance.definite must be boolean');
      }
      const text = requiredString(rawUtterance.text, 'utterance.text');
      const revisionValue = rawUtterance.revision;
      if (revisionValue !== undefined && (
        !Number.isSafeInteger(revisionValue) || (revisionValue as number) < 0
      )) {
        fail('utterance.revision must be a non-negative integer');
      }
      const revision = (revisionValue ?? Math.abs(providerSequence)) as number;
      const providerSegmentId = rawUtterance.id === undefined
        ? undefined
        : requiredString(rawUtterance.id, 'utterance.id');
      const startTimeMs = optionalNonNegativeNumber(rawUtterance.start_time, 'utterance.start_time');
      const endTimeMs = optionalNonNegativeNumber(rawUtterance.end_time, 'utterance.end_time');
      if (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs > endTimeMs) {
        fail('utterance start_time must not exceed end_time');
      }

      const contentKey = JSON.stringify([
        rawUtterance.definite,
        revision,
        text,
        providerSegmentId ?? null,
        startTimeMs ?? null,
        endTimeMs ?? null,
      ]);
      const prior = seenIndexes.get(segmentIndex);
      if (prior !== undefined) {
        if (prior !== contentKey) fail('conflicting utterances share one segment index');
        continue;
      }
      seenIndexes.set(segmentIndex, contentKey);

      events.push({
        ...eventContext,
        kind: rawUtterance.definite ? 'segment_final' : 'partial',
        providerSequence,
        providerPacketFingerprint,
        segmentIndex,
        revision,
        text,
        ...(providerSegmentId === undefined ? {} : { providerSegmentId }),
        ...(startTimeMs === undefined ? {} : { startTimeMs }),
        ...(endTimeMs === undefined ? {} : { endTimeMs }),
      });
    }

    if ((utterances ?? []).length === 0 && result.text !== undefined) {
      const text = requiredString(result.text, 'result.text');
      events.push({
        ...eventContext,
        kind: 'partial',
        providerSequence,
        providerPacketFingerprint,
        segmentIndex: 0,
        revision: Math.abs(providerSequence),
        text,
      });
    }
  } else if (!last) {
    fail('non-final payload must contain a result');
  }

  const usage = usageFrom(payload.usage);
  if (usage) {
    events.push({
      ...eventContext,
      kind: 'usage',
      providerSequence,
      providerPacketFingerprint,
      usage,
    });
  }
  if (last) {
    events.push({
      ...eventContext,
      kind: 'stream_final',
      providerSequence,
      providerPacketFingerprint,
    });
  }
  return events;
}
