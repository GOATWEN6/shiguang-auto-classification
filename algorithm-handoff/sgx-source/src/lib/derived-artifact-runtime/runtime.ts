import { createHash } from 'node:crypto';

import { assertRuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import type {
  BorrowedGenerationExecutionPermit,
  CancellationCleanupStatus,
  NormalizedRuntimeError,
} from '../algorithm-runtime/index.ts';
import {
  cancellationCleanupTimeout,
  settleWithCancellationCleanup,
} from '../algorithm-runtime/index.ts';
import {
  assertValidReferenceRetrievalRequest,
  InMemoryReferenceStore,
} from '../memory-runtime/index.ts';
import type { ReferenceRecord } from '../memory-runtime/index.ts';
import type {
  CreateProfileDraftRuntimeOptions,
  CreateStoryDraftRuntimeOptions,
  DerivedArtifactRunRequest,
  DerivedArtifactRunResult,
  DerivedAttribution,
  DerivedSource,
  DerivedSourceGovernance,
  DerivedSourceRequest,
  DerivedUncertainty,
  ProfileDraftArtifact,
  ProfileDraftField,
  ProfileDraftPath,
  ProfileDraftRuntime,
  StoryDraftArtifact,
  StoryDraftRuntime,
  StorySentence,
} from './contracts.ts';

const STORY_CONTENT_TYPES = new Set([
  'life_event',
  'photo_location_claim',
  'photo_metadata',
  'photo_person_relation',
  'quote',
  'story_assertion',
  'subjective_meaning',
]);

const PROFILE_CONTENT_TYPES = new Set([
  'interaction_observation',
  'interaction_preference',
  'photo_person_relation',
  'preference',
  'routine',
]);

const PROFILE_PATHS = new Set<ProfileDraftPath>([
  'interests.activities',
  'interests.objects',
  'interests.places',
  'interactionPreferences.formOfAddress',
  'interactionPreferences.pace',
  'interactionPreferences.topics',
  'lifeStageRoutines.current',
  'lifeStageRoutines.historical',
  'preferences.activities',
  'preferences.food',
  'preferences.music',
  'relationships.familyRole',
  'relationships.socialRole',
]);

const PROFILE_TEMPORAL_SCOPES = new Set([
  'CURRENT',
  'HISTORICAL',
  'LIFE_STAGE',
  'UNKNOWN',
]);

const CLAIM_MODES = new Set(['DIRECT', 'ATTRIBUTED']);
const UNCERTAINTY_VALUES = new Set(['NONE', 'SOURCE_ATTRIBUTION', 'UNKNOWN_TIME']);
const PROTECTED_PATTERNS = [
  /health|medical|diagnos|cognitive|dementia|mental|psycholog|depress/iu,
  /financial|finance|asset|bank|credential|password|account/iu,
  /family.?conflict|trauma|abuse/iu,
  /健康|疾病|诊断|診斷|认知|認知|失智|痴呆|癡呆|抑郁|抑鬱|心理|财产|財產|存款|银行|銀行|账号|帳號|賬號|密码|密碼|家庭冲突|家庭衝突|创伤|創傷|虐待/u,
];

function normalizedError(
  code: NormalizedRuntimeError['code'],
  message: string,
): NormalizedRuntimeError {
  return { code, message, retryable: false };
}

function failed<T>(error: NormalizedRuntimeError): DerivedArtifactRunResult<T> {
  return {
    status: 'failed', error, canonicalWritePerformed: false,
    cancellationCleanupStatus: 'NOT_REQUIRED',
  };
}

function suppressed<T>(
  reason: 'no_save' | 'cancelled',
  cancellationCleanupStatus: CancellationCleanupStatus = 'NOT_REQUIRED',
): DerivedArtifactRunResult<T> {
  return { status: 'suppressed', reason, canonicalWritePerformed: false, cancellationCleanupStatus };
}

function combinedCancellationCleanup(
  taskStatus: Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'>,
  permit: BorrowedGenerationExecutionPermit,
): Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'> {
  const nestedStatus = permit.cleanupStatus();
  if (taskStatus === 'FAILED' || nestedStatus === 'FAILED') return 'FAILED';
  return taskStatus === 'TIMED_OUT'
    || nestedStatus === 'TIMED_OUT'
    || nestedStatus === 'PENDING'
    ? 'TIMED_OUT'
    : 'JOINED';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== 'string')) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function normalizeProtectedMaterial(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{Z}\p{P}\p{Cf}\p{M}]+/gu, '');
}

function cloneGovernance(source: DerivedSource): DerivedSourceGovernance {
  return {
    recordId: source.recordId,
    attributedOnly: source.attributedOnly,
    sourceActor: { ...source.sourceActor },
    authorityState: source.authorityState,
    conflictState: source.conflictState,
    validFrom: source.validFrom,
    validTo: source.validTo,
    temporalState: source.temporalState,
    mustNotHappen: [...source.mustNotHappen],
    sensitivityLevel: source.sensitivityLevel,
    sensitivityCategories: [...source.sensitivityCategories],
    visibilityScope: [...source.visibilityScope],
  };
}

function normalizeRecord(record: ReferenceRecord): DerivedSource | null {
  const candidate = record.candidate;
  if (
    record.status !== 'ACTIVE'
    || record.candidate.canonicalWritePerformed !== false
    || record.candidate.sensitivityLevel !== 'S0'
    || record.candidate.conflictState !== 'NONE'
  ) return null;
  if (
    !nonEmptyString(record.recordId)
    || !nonEmptyString(candidate.subjectId)
    || !nonEmptyString(candidate.familySpaceId)
    || !nonEmptyString(candidate.authorizationVersion)
    || !nonEmptyString(candidate.contentType)
    || !nonEmptyString(candidate.normalizedClaim)
    || !nonEmptyStringArray(candidate.visibilityScope)
    || !nonEmptyStringArray(candidate.evidenceRefs)
  ) return null;
  return {
    recordId: record.recordId,
    subjectId: candidate.subjectId,
    familySpaceId: candidate.familySpaceId,
    authorizationVersion: candidate.authorizationVersion,
    visibilityScope: [...candidate.visibilityScope],
    allowedUses: [...candidate.allowedUses],
    forbiddenUses: [...candidate.forbiddenUses],
    contentType: candidate.contentType,
    text: candidate.normalizedClaim,
    evidenceRefs: [...candidate.evidenceRefs],
    sensitivityLevel: 'S0',
    sensitivityCategories: [...candidate.sensitivityCategories],
    attributedOnly: record.attributedOnly,
    sourceActor: { ...candidate.sourceActor },
    authorityState: candidate.authorityState,
    conflictState: candidate.conflictState,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    temporalState: candidate.temporalState,
    mustNotHappen: [...candidate.mustNotHappen],
  };
}

function eligibleForPurpose(source: DerivedSource, request: DerivedSourceRequest): boolean {
  const allowed = source.allowedUses.includes('*') || source.allowedUses.includes(request.purpose);
  const forbidden = source.forbiddenUses.includes('*') || source.forbiddenUses.includes(request.purpose);
  const typeAllowed = request.purpose === 'story_draft'
    ? STORY_CONTENT_TYPES.has(source.contentType)
    : PROFILE_CONTENT_TYPES.has(source.contentType);
  const protectedSource = containsProtectedMaterial([
    source.contentType,
    source.text,
    ...source.sensitivityCategories,
  ].join(' '));
  return allowed && !forbidden && typeAllowed && !protectedSource;
}

function sourceBundle(
  store: InMemoryReferenceStore,
  request: DerivedSourceRequest,
): DerivedSource[] {
  const seen = new Set<string>();
  const sources: DerivedSource[] = [];
  const records = InMemoryReferenceStore.prototype.retrieve.call(
    store,
    structuredClone(request),
  );
  for (const record of records) {
    const source = normalizeRecord(record);
    if (!source || seen.has(record.recordId)) continue;
    if (
      source.subjectId !== request.subjectId
      || source.familySpaceId !== request.familySpaceId
      || source.authorizationVersion !== request.authorizationVersion
      || !request.visibilityScope.every(scope => source.visibilityScope.includes(scope))
      || !InMemoryReferenceStore.prototype.isRecordUsable.call(store, source.recordId, request)
      || !eligibleForPurpose(source, request)
    ) continue;
    seen.add(source.recordId);
    sources.push(source);
  }
  return sources;
}

function sourceFingerprint(source: DerivedSource): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

/**
 * This is an exposed-bundle snapshot check: newly authorized records are not
 * part of this run, while every record shown to the generator must remain
 * byte-for-byte governed and usable until commit.
 */
function exposedSnapshotStillAuthorized(
  store: InMemoryReferenceStore,
  request: DerivedSourceRequest,
  exposedSources: readonly DerivedSource[],
): boolean {
  const currentById = new Map(sourceBundle(store, request).map(source => [source.recordId, source]));
  return exposedSources.every(source => {
    const current = currentById.get(source.recordId);
    return current !== undefined && sourceFingerprint(current) === sourceFingerprint(source);
  });
}

function citationsAreAuthorized(
  recordIds: string[],
  evidenceRefs: string[],
  sourcesById: ReadonlyMap<string, DerivedSource>,
): DerivedSource[] | null {
  if (!nonEmptyStringArray(recordIds) || !nonEmptyStringArray(evidenceRefs)) return null;
  if (!unique(recordIds) || !unique(evidenceRefs)) return null;
  const cited: DerivedSource[] = [];
  for (const recordId of recordIds) {
    const source = sourcesById.get(recordId);
    if (!source) return null;
    cited.push(source);
  }
  const allowedEvidence = new Set(cited.flatMap(source => source.evidenceRefs));
  if (!evidenceRefs.every(ref => allowedEvidence.has(ref))) return null;
  if (!cited.every(source => source.evidenceRefs.some(ref => evidenceRefs.includes(ref)))) return null;
  return cited;
}

function runtimeAttribution(cited: readonly DerivedSource[]): DerivedAttribution | null {
  const attributedSources = cited
    .filter(source => source.attributedOnly)
    .map(source => ({
      recordId: source.recordId,
      sourceActor: { ...source.sourceActor },
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId)
      || left.sourceActor.actorRole.localeCompare(right.sourceActor.actorRole)
      || left.sourceActor.actorId.localeCompare(right.sourceActor.actorId));
  if (attributedSources.length === 0) return null;
  return { kind: 'SOURCE_ACTORS', sources: attributedSources };
}

function claimGovernance(
  claimMode: unknown,
  uncertainty: unknown,
  cited: readonly DerivedSource[],
): {
  claimMode: StorySentence['claimMode'];
  attribution: DerivedAttribution | null;
  uncertainty: StorySentence['uncertainty'];
} | null {
  if (!nonEmptyString(claimMode) || !CLAIM_MODES.has(claimMode)) return null;
  if (!nonEmptyString(uncertainty) || !UNCERTAINTY_VALUES.has(uncertainty)) return null;
  const needsAttribution = cited.some(source => source.attributedOnly);
  if (needsAttribution && (claimMode !== 'ATTRIBUTED' || uncertainty !== 'SOURCE_ATTRIBUTION')) {
    return null;
  }
  if (!needsAttribution && claimMode !== 'DIRECT') return null;
  return {
    claimMode: claimMode as StorySentence['claimMode'],
    attribution: runtimeAttribution(cited),
    uncertainty: uncertainty as StorySentence['uncertainty'],
  };
}

function containsProtectedMaterial(text: string): boolean {
  const normalized = normalizeProtectedMaterial(text);
  return PROTECTED_PATTERNS.some(pattern => pattern.test(normalized));
}

function protectedMaterialIsGrounded(text: string, cited: readonly DerivedSource[]): boolean {
  if (!containsProtectedMaterial(text)) return true;
  return cited.some(source => containsProtectedMaterial(source.text));
}

function yearTokens(text: string): string[] {
  return [...text.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/gu)].map(match => match[0]);
}

function yearsAreGrounded(text: string, cited: readonly DerivedSource[]): boolean {
  const supported = new Set(cited.flatMap(source => yearTokens([
    source.text,
    source.validFrom ?? '',
    source.validTo ?? '',
  ].join(' '))));
  return yearTokens(text).every(year => supported.has(year));
}

const UNCERTAINTY_MARKER = /(大概|大约|约莫|可能|也许|记不清|不确定|左右|前后)/u;
const INTERNAL_IDENTIFIER = /(?:fictional[-_:]|\b(?:subject|actor|record|claim|evidence|familySpace|authorization)(?:Id|_id)\b)/iu;

function sourceRequiresUncertainty(cited: readonly DerivedSource[]): boolean {
  return cited.some(source => {
    const temporalState = source.temporalState.normalize('NFKC').trim().toUpperCase();
    return UNCERTAINTY_MARKER.test(source.text)
      || temporalState === 'UNKNOWN'
      || temporalState === 'UNCERTAIN';
  });
}

function uncertaintyIsPreserved(
  uncertainty: DerivedUncertainty,
  cited: readonly DerivedSource[],
): boolean {
  return !sourceRequiresUncertainty(cited) || uncertainty !== 'NONE';
}

function containsInternalIdentifier(text: string, cited: readonly DerivedSource[]): boolean {
  if (INTERNAL_IDENTIFIER.test(text)) return true;
  return cited.some(source => text.includes(source.recordId));
}

function violatesMustNotHappen(text: string, sources: readonly DerivedSource[]): boolean {
  const normalized = normalizeText(text);
  return sources.some(source => source.mustNotHappen.some(rule => {
    const term = normalizeText(rule);
    return term.length >= 2 && normalized.includes(term);
  }));
}

function governanceFor(
  sourceRecordIds: readonly string[],
  sourcesById: ReadonlyMap<string, DerivedSource>,
): DerivedSourceGovernance[] {
  return sourceRecordIds.map(recordId => cloneGovernance(sourcesById.get(recordId)!));
}

function temporalScopeAligned(
  temporalScope: ProfileDraftField['temporalScope'],
  cited: readonly DerivedSource[],
): boolean {
  if (temporalScope === 'UNKNOWN') return true;
  return cited.every(source => {
    const state = source.temporalState.normalize('NFKC').trim().toUpperCase();
    if (source.validTo !== null) {
      return temporalScope === 'HISTORICAL' || temporalScope === 'LIFE_STAGE';
    }
    if (['HISTORICAL', 'PAST', 'PAST_INTERVAL', 'ENDED', 'EXPIRED'].includes(state)) {
      return temporalScope === 'HISTORICAL' || temporalScope === 'LIFE_STAGE';
    }
    if (['CURRENT', 'TEMPORARY_CURRENT', 'ONGOING', 'PRESENT'].includes(state)) {
      return temporalScope === 'CURRENT';
    }
    return false;
  });
}

function validateStory(raw: unknown, sources: DerivedSource[]): StoryDraftArtifact | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'sentences'])) return null;
  if (raw.schemaVersion !== '0.3' || !Array.isArray(raw.sentences) || raw.sentences.length === 0) return null;
  const byId = new Map(sources.map(source => [source.recordId, source]));
  const sentenceIds = new Set<string>();
  const sentences: StorySentence[] = [];
  for (const value of raw.sentences) {
    if (!isPlainRecord(value) || !hasExactKeys(value, [
      'sentenceId', 'text', 'recordIds', 'evidenceRefs', 'claimMode', 'uncertainty',
    ])) return null;
    if (
      !nonEmptyString(value.sentenceId)
      || sentenceIds.has(value.sentenceId)
      || !nonEmptyString(value.text)
      || !nonEmptyStringArray(value.recordIds)
      || !nonEmptyStringArray(value.evidenceRefs)
    ) return null;
    const cited = citationsAreAuthorized(value.recordIds, value.evidenceRefs, byId);
    const governance = cited ? claimGovernance(value.claimMode, value.uncertainty, cited) : null;
    if (
      !cited
      || !governance
      || containsInternalIdentifier(value.text, cited)
      || !uncertaintyIsPreserved(governance.uncertainty, cited)
      || !yearsAreGrounded(value.text, cited)
      || !protectedMaterialIsGrounded(value.text, cited)
      || violatesMustNotHappen(value.text, sources)
    ) return null;
    sentenceIds.add(value.sentenceId);
    sentences.push({
      sentenceId: value.sentenceId,
      text: value.text,
      recordIds: [...value.recordIds],
      evidenceRefs: [...value.evidenceRefs],
      ...governance,
    });
  }
  const sourceRecordIds = [...new Set(sentences.flatMap(sentence => sentence.recordIds))];
  return {
    kind: 'STORY_DRAFT',
    schemaVersion: '0.3',
    sentences,
    sourceRecordIds,
    sourceGovernance: governanceFor(sourceRecordIds, byId),
  };
}

function validateProfile(raw: unknown, sources: DerivedSource[]): ProfileDraftArtifact | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'fields'])) return null;
  if (raw.schemaVersion !== '0.3' || !Array.isArray(raw.fields) || raw.fields.length === 0) return null;
  const byId = new Map(sources.map(source => [source.recordId, source]));
  const fieldIds = new Set<string>();
  const fields: ProfileDraftField[] = [];
  for (const value of raw.fields) {
    if (!isPlainRecord(value) || !hasExactKeys(value, [
      'fieldId', 'path', 'value', 'temporalScope', 'recordIds', 'evidenceRefs',
      'claimMode', 'uncertainty',
    ])) return null;
    if (
      !nonEmptyString(value.fieldId)
      || fieldIds.has(value.fieldId)
      || !nonEmptyString(value.path)
      || !PROFILE_PATHS.has(value.path as ProfileDraftPath)
      || !nonEmptyString(value.value)
      || containsProtectedMaterial(`${value.path} ${value.value}`)
      || !nonEmptyString(value.temporalScope)
      || !PROFILE_TEMPORAL_SCOPES.has(value.temporalScope)
      || !nonEmptyStringArray(value.recordIds)
      || !nonEmptyStringArray(value.evidenceRefs)
    ) return null;
    const cited = citationsAreAuthorized(value.recordIds, value.evidenceRefs, byId);
    const governance = cited ? claimGovernance(value.claimMode, value.uncertainty, cited) : null;
    if (
      !cited
      || !governance
      || containsInternalIdentifier(value.value, cited)
      || !uncertaintyIsPreserved(governance.uncertainty, cited)
      || !temporalScopeAligned(value.temporalScope as ProfileDraftField['temporalScope'], cited)
      || violatesMustNotHappen(value.value, sources)
    ) return null;
    fieldIds.add(value.fieldId);
    fields.push({
      fieldId: value.fieldId,
      path: value.path as ProfileDraftPath,
      value: value.value,
      temporalScope: value.temporalScope as ProfileDraftField['temporalScope'],
      recordIds: [...value.recordIds],
      evidenceRefs: [...value.evidenceRefs],
      ...governance,
    });
  }
  const sourceRecordIds = [...new Set(fields.flatMap(field => field.recordIds))];
  return {
    kind: 'DRAFT_PATCH',
    schemaVersion: '0.3',
    fields,
    sourceRecordIds,
    sourceGovernance: governanceFor(sourceRecordIds, byId),
  };
}

function validateRequest(
  request: DerivedArtifactRunRequest,
  expectedPurpose: DerivedSourceRequest['purpose'],
): NormalizedRuntimeError | null {
  try {
    assertRuntimeIdentity(request.identity);
    if (typeof request.noSave !== 'boolean') throw new TypeError('noSave must be boolean');
    if (request.sourceRequest.purpose !== expectedPurpose) {
      return normalizedError('invalid_config', 'derived artifact purpose does not match runtime');
    }
    if (request.sourceRequest.mode !== undefined && request.sourceRequest.mode !== 'ORDINARY') {
      return normalizedError('invalid_config', 'derived generation supports ORDINARY retrieval only');
    }
    assertValidReferenceRetrievalRequest({ ...request.sourceRequest, mode: 'ORDINARY' });
    return null;
  } catch {
    return normalizedError('invalid_schema', 'derived artifact request is invalid');
  }
}

function assertOptions(
  options: CreateStoryDraftRuntimeOptions | CreateProfileDraftRuntimeOptions,
): void {
  if (!options.cancellationRegistry) throw new TypeError('cancellationRegistry is required');
  if (!(options.sourceStore instanceof InMemoryReferenceStore)) {
    throw new TypeError('sourceStore must be the governed InMemoryReferenceStore');
  }
  if (typeof options.generate !== 'function') throw new TypeError('generate must be a function');
}

export function createStoryDraftRuntime(
  options: CreateStoryDraftRuntimeOptions,
): StoryDraftRuntime {
  assertOptions(options);
  const cleanupTimeoutMs = cancellationCleanupTimeout(options.cancellationCleanupTimeoutMs);
  return {
    async run(request): Promise<DerivedArtifactRunResult<StoryDraftArtifact>> {
      const invalid = validateRequest(request, 'story_draft');
      if (invalid) return failed(invalid);
      const lease = options.cancellationRegistry.acquireLease(request.identity, 'story_draft');
      if (!lease) return suppressed('cancelled');
      try {
        const executionPermit = options.cancellationRegistry.borrowLease(lease);
        if (!executionPermit) {
          return failed(normalizedError('invalid_config', 'story execution permit is unavailable'));
        }
        if (request.noSave) return suppressed('no_save');
        if (lease.signal.aborted || !lease.accepts().accepted) return suppressed('cancelled');
        let sources: DerivedSource[];
        try {
          sources = sourceBundle(options.sourceStore, { ...request.sourceRequest, mode: 'ORDINARY' });
        } catch {
          return failed(normalizedError('authorization_withdrawn', 'story sources are unavailable'));
        }
        if (sources.length === 0) {
          return failed(normalizedError('authorization_withdrawn', 'no authorized story sources'));
        }
        const operation = Promise.resolve().then(() => options.generate({
          identity: structuredClone(lease.identity),
          sources: structuredClone(sources),
          signal: lease.signal,
          executionPermit,
        }));
        const outcome = await settleWithCancellationCleanup(
          operation,
          lease.signal,
          cleanupTimeoutMs,
        );
        if (outcome.kind === 'cancelled') {
          return suppressed(
            'cancelled',
            combinedCancellationCleanup(outcome.cleanupStatus, executionPermit),
          );
        }
        if (lease.signal.aborted || !lease.accepts().accepted) {
          return suppressed(
            'cancelled',
            combinedCancellationCleanup('JOINED', executionPermit),
          );
        }
        if (outcome.kind === 'error') {
          return failed(normalizedError('unknown', 'story generation failed'));
        }
        const artifact = validateStory(outcome.value, sources);
        if (!artifact) return failed(normalizedError('invalid_schema', 'story draft failed governance validation'));
        try {
          if (!exposedSnapshotStillAuthorized(options.sourceStore, request.sourceRequest, sources)) {
            return failed(normalizedError('authorization_withdrawn', 'story sources changed before commit'));
          }
        } catch {
          return failed(normalizedError('authorization_withdrawn', 'story sources are unavailable'));
        }
        return {
          status: 'success', artifact, canonicalWritePerformed: false,
          cancellationCleanupStatus: 'NOT_REQUIRED',
        };
      } finally {
        lease.finalize();
      }
    },
  };
}

export function createProfileDraftRuntime(
  options: CreateProfileDraftRuntimeOptions,
): ProfileDraftRuntime {
  assertOptions(options);
  const cleanupTimeoutMs = cancellationCleanupTimeout(options.cancellationCleanupTimeoutMs);
  return {
    async run(request): Promise<DerivedArtifactRunResult<ProfileDraftArtifact>> {
      const invalid = validateRequest(request, 'profile_draft');
      if (invalid) return failed(invalid);
      const lease = options.cancellationRegistry.acquireLease(request.identity, 'profile_draft');
      if (!lease) return suppressed('cancelled');
      try {
        const executionPermit = options.cancellationRegistry.borrowLease(lease);
        if (!executionPermit) {
          return failed(normalizedError('invalid_config', 'profile execution permit is unavailable'));
        }
        if (request.noSave) return suppressed('no_save');
        if (lease.signal.aborted || !lease.accepts().accepted) return suppressed('cancelled');
        let sources: DerivedSource[];
        try {
          sources = sourceBundle(options.sourceStore, { ...request.sourceRequest, mode: 'ORDINARY' });
        } catch {
          return failed(normalizedError('authorization_withdrawn', 'profile sources are unavailable'));
        }
        if (sources.length === 0) {
          return failed(normalizedError('authorization_withdrawn', 'no ordinary profile sources'));
        }
        const operation = Promise.resolve().then(() => options.generate({
          identity: structuredClone(lease.identity),
          sources: structuredClone(sources),
          signal: lease.signal,
          executionPermit,
        }));
        const outcome = await settleWithCancellationCleanup(
          operation,
          lease.signal,
          cleanupTimeoutMs,
        );
        if (outcome.kind === 'cancelled') {
          return suppressed(
            'cancelled',
            combinedCancellationCleanup(outcome.cleanupStatus, executionPermit),
          );
        }
        if (lease.signal.aborted || !lease.accepts().accepted) {
          return suppressed(
            'cancelled',
            combinedCancellationCleanup('JOINED', executionPermit),
          );
        }
        if (outcome.kind === 'error') {
          return failed(normalizedError('unknown', 'profile generation failed'));
        }
        const artifact = validateProfile(outcome.value, sources);
        if (!artifact) return failed(normalizedError('invalid_schema', 'profile draft failed governance validation'));
        try {
          if (!exposedSnapshotStillAuthorized(options.sourceStore, request.sourceRequest, sources)) {
            return failed(normalizedError('authorization_withdrawn', 'profile sources changed before commit'));
          }
        } catch {
          return failed(normalizedError('authorization_withdrawn', 'profile sources are unavailable'));
        }
        return {
          status: 'success', artifact, canonicalWritePerformed: false,
          cancellationCleanupStatus: 'NOT_REQUIRED',
        };
      } finally {
        lease.finalize();
      }
    },
  };
}
