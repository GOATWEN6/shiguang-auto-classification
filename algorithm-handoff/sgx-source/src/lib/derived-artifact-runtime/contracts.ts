import type {
  BorrowedGenerationExecutionPermit,
  CancellationCleanupStatus,
  GenerationCancellationRegistry,
  NormalizedRuntimeError,
  RuntimeIdentity,
} from '../algorithm-runtime/index.ts';
import type {
  InMemoryReferenceStore,
  ReferenceRetrievalRequest,
  SourceActor,
} from '../memory-runtime/index.ts';

export type DerivedArtifactPurpose = 'story_draft' | 'profile_draft';

export interface DerivedSourceRequest extends ReferenceRetrievalRequest {
  purpose: DerivedArtifactPurpose;
  /** G4 generation is deliberately ordinary-mode only. */
  mode?: 'ORDINARY';
}

export interface DerivedSourceGovernance {
  recordId: string;
  attributedOnly: boolean;
  sourceActor: SourceActor;
  authorityState: string;
  conflictState: 'OPEN' | 'NONE';
  validFrom: string | null;
  validTo: string | null;
  temporalState: string;
  mustNotHappen: string[];
  sensitivityLevel: 'S0';
  sensitivityCategories: string[];
  visibilityScope: string[];
}

export interface DerivedSource extends DerivedSourceGovernance {
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  allowedUses: string[];
  forbiddenUses: string[];
  contentType: string;
  text: string;
  evidenceRefs: string[];
}

export type DerivedClaimMode = 'DIRECT' | 'ATTRIBUTED';
export type DerivedUncertainty = 'NONE' | 'SOURCE_ATTRIBUTION' | 'UNKNOWN_TIME';

export interface DerivedAttributionSource {
  recordId: string;
  sourceActor: SourceActor;
}

/** Runtime-derived provenance. Generators never provide this field. */
export interface DerivedAttribution {
  kind: 'SOURCE_ACTORS';
  sources: DerivedAttributionSource[];
}

export interface StorySentence {
  sentenceId: string;
  text: string;
  recordIds: string[];
  evidenceRefs: string[];
  claimMode: DerivedClaimMode;
  attribution: DerivedAttribution | null;
  uncertainty: DerivedUncertainty;
}

export interface StoryDraftArtifact {
  kind: 'STORY_DRAFT';
  schemaVersion: '0.3';
  sentences: StorySentence[];
  sourceRecordIds: string[];
  sourceGovernance: DerivedSourceGovernance[];
}

export type ProfileDraftPath =
  | 'interests.activities'
  | 'interests.objects'
  | 'interests.places'
  | 'interactionPreferences.formOfAddress'
  | 'interactionPreferences.pace'
  | 'interactionPreferences.topics'
  | 'lifeStageRoutines.current'
  | 'lifeStageRoutines.historical'
  | 'preferences.activities'
  | 'preferences.food'
  | 'preferences.music'
  | 'relationships.familyRole'
  | 'relationships.socialRole';

export interface ProfileDraftField {
  fieldId: string;
  path: ProfileDraftPath;
  value: string;
  temporalScope: 'CURRENT' | 'HISTORICAL' | 'LIFE_STAGE' | 'UNKNOWN';
  recordIds: string[];
  evidenceRefs: string[];
  claimMode: DerivedClaimMode;
  attribution: DerivedAttribution | null;
  uncertainty: DerivedUncertainty;
}

export interface ProfileDraftArtifact {
  kind: 'DRAFT_PATCH';
  schemaVersion: '0.3';
  fields: ProfileDraftField[];
  sourceRecordIds: string[];
  sourceGovernance: DerivedSourceGovernance[];
}

export interface DerivedArtifactRunRequest {
  identity: RuntimeIdentity;
  sourceRequest: DerivedSourceRequest;
  noSave: boolean;
}

export type DerivedArtifactRunResult<T> =
  | {
      status: 'success';
      artifact: T;
      error?: undefined;
      canonicalWritePerformed: false;
      cancellationCleanupStatus: CancellationCleanupStatus;
    }
  | {
      status: 'suppressed';
      artifact?: undefined;
      error?: undefined;
      reason: 'no_save' | 'cancelled';
      canonicalWritePerformed: false;
      cancellationCleanupStatus: CancellationCleanupStatus;
    }
  | {
      status: 'failed';
      artifact?: undefined;
      error: NormalizedRuntimeError;
      canonicalWritePerformed: false;
      cancellationCleanupStatus: CancellationCleanupStatus;
    };

export interface StoryDraftGeneratorInput {
  identity: RuntimeIdentity;
  sources: DerivedSource[];
  signal: AbortSignal;
  /** Branded read-only permit for a nested model runtime; no cancel/finalize authority. */
  executionPermit: BorrowedGenerationExecutionPermit;
}

export interface ProfileDraftGeneratorInput {
  identity: RuntimeIdentity;
  sources: DerivedSource[];
  signal: AbortSignal;
  /** Branded read-only permit for a nested model runtime; no cancel/finalize authority. */
  executionPermit: BorrowedGenerationExecutionPermit;
}

export interface StoryDraftRuntime {
  run(request: DerivedArtifactRunRequest): Promise<DerivedArtifactRunResult<StoryDraftArtifact>>;
}

export interface ProfileDraftRuntime {
  run(request: DerivedArtifactRunRequest): Promise<DerivedArtifactRunResult<ProfileDraftArtifact>>;
}

interface DerivedRuntimeOptionsBase {
  cancellationRegistry: GenerationCancellationRegistry;
  /** G4 binds derived generation to the governed Reference Store implementation. */
  sourceStore: InMemoryReferenceStore;
  /** Bounded wait for an already-started nested generator to finish abort cleanup. */
  cancellationCleanupTimeoutMs?: number;
}

export interface CreateStoryDraftRuntimeOptions extends DerivedRuntimeOptionsBase {
  generate(input: StoryDraftGeneratorInput): Promise<unknown> | unknown;
}

export interface CreateProfileDraftRuntimeOptions extends DerivedRuntimeOptionsBase {
  generate(input: ProfileDraftGeneratorInput): Promise<unknown> | unknown;
}
