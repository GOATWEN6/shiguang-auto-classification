export type Toggle = 'on' | 'off';

export type MemoryDisposition =
  | 'AUTO_WRITE'
  | 'C2_BATCH_CONFIRM'
  | 'C3_STRONG_CONFIRM'
  | 'SOURCED_ONLY'
  | 'SESSION_ONLY'
  | 'NO_MEMORY'
  | 'BLOCKED';

export type SensitivityLevel = 'S0' | 'S1' | 'S2';
export type GovernanceAction = 'NONE' | 'RESTRICT' | 'REVOKE' | 'DELETE' | 'RESTORE_REQUEST';
export type MemoryOrigin =
  | 'SELF_REPORT'
  | 'FAMILY_REPORT'
  | 'COMMUNITY_REPORT'
  | 'SYSTEM_OBSERVATION'
  | 'AI_DERIVED'
  | 'PHOTO_MODEL';

export interface MemoryPolicyContext {
  interactionPreferenceAutoSavePolicy: Toggle;
  ordinaryMemoryAutoSavePolicy: Toggle;
  interviewAutoOrganizePolicy: Toggle;
  longitudinalObservationAuthorization: Toggle;
  actorRole: string;
  subjectId: string;
  familySpaceId: string;
  purpose: string;
  visibilityScope: string[];
  authorizationVersion: string;
}

export interface EvidenceFragment {
  ref: string;
  kind: string;
  actorId: string;
  actorRole: string;
  subjectId: string;
  familySpaceId: string;
  allowedPurposes: string[];
  authorizationVersion: string;
  visibilityScope: string[];
  text: string;
  recordedAt?: string;
  eventTime?: string | null;
  useStatus: string;
}

export interface CurrentMemoryRecord {
  recordId: string;
  subjectId: string;
  familySpaceId: string;
  allowedPurposes: string[];
  authorizationVersion: string;
  visibilityScope: string[];
  sourceActor: SourceActor;
  evidenceRef: string;
  content: string;
  status: string;
}

export interface MemoryRelationship {
  type: string;
  targetProposalId?: string;
  targetMemoryId?: string;
  [key: string]: unknown;
}

export interface SourceActor {
  actorId: string;
  actorRole: string;
}

export interface MemorySignals {
  origin: MemoryOrigin;
  explicitRemember: boolean;
  explicitCorrection: boolean;
  governanceAction: GovernanceAction;
  containsCredential: boolean;
  conflict: boolean;
  ambiguousSubject: boolean;
  purposeExpansion: boolean;
  visibilityExpansion: boolean;
  shortTerm: boolean;
  interactionPreference: boolean;
  interviewMaterial: boolean;
  ordinaryMemory: boolean;
  reversible: boolean;
  auditable: boolean;
  temporalState: string;
}

export interface MemoryProposal {
  proposalId: string;
  contentType: string;
  normalizedClaim: string;
  query: string;
  topK: number;
  eventTime: string | null;
  validFrom: string | null;
  validTo: string | null;
  handlingProfile: string;
  retentionPolicy: string;
  importanceReasons: string[];
  sensitivityLevel: SensitivityLevel;
  sensitivityCategories: string[];
  allowedUses: string[];
  forbiddenUses: string[];
  reviewTrigger: string;
  expiryOrSupersedeRule: string;
  mustNotHappen: string[];
  relationships: MemoryRelationship[];
  signals: MemorySignals;
  rawEvidenceRef?: string;
  sourceEvidenceRefs?: string[];
  sourceActor?: SourceActor;
}

export interface ExistingIdempotencyRecord {
  idempotencyKey: string;
  payloadHash: string;
  resultRef: string;
}

export interface MemoryTransactionInput {
  currentVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  payloadHash: string;
  existingIdempotencyRecord: ExistingIdempotencyRecord | null;
}

export interface MemoryCaseInput {
  caseId: string;
  requestId: string;
  fixtureVersion?: string;
  policyVersion?: string;
  policy: MemoryPolicyContext;
  evidence: EvidenceFragment[];
  currentRecords: CurrentMemoryRecord[];
  proposals: MemoryProposal[];
  transaction: MemoryTransactionInput;
}

export interface HybridInput {
  policy: MemoryPolicyContext;
  evidence: EvidenceFragment[];
  currentRecords: CurrentMemoryRecord[];
}

export type TransactionStatus = 'NEW' | 'REPLAY' | 'KEY_PAYLOAD_CONFLICT' | 'STALE_VERSION';

export interface TransactionInspection {
  status: TransactionStatus;
  blockReason: string | null;
  replayedResultRef: string | null;
}

export interface MemoryPolicyDecision {
  disposition: MemoryDisposition;
  confirmationBasis: string;
  reasonCodes: string[];
}

export interface ScoredEvidenceFragment extends EvidenceFragment {
  score: number;
}

export interface MemoryCandidate {
  claimId: string;
  proposalId: string;
  subjectId: string;
  familySpaceId: string;
  purpose: string;
  authorizationVersion: string;
  contentType: string;
  normalizedClaim: string;
  evidenceRefs: string[];
  sourceActor: SourceActor;
  eventTime: string | null;
  validFrom: string | null;
  validTo: string | null;
  authorityState: string;
  conflictState: 'OPEN' | 'NONE';
  handlingProfile: string;
  retentionPolicy: string;
  importanceReasons: string[];
  sensitivityLevel: SensitivityLevel;
  sensitivityCategories: string[];
  disposition: MemoryDisposition;
  confirmationBasis: string;
  allowedUses: string[];
  forbiddenUses: string[];
  visibilityScope: string[];
  reviewTrigger: string;
  expiryOrSupersedeRule: string;
  mustNotHappen: string[];
  policyVersion: string;
  algorithmVersion: string;
  temporalState: string;
  usageStatus: string;
  relationships: MemoryRelationship[];
  reasonCodes: string[];
  writeEligibility: 'ELIGIBLE_FOR_BUSINESS_GATE' | 'NOT_ELIGIBLE';
  canonicalWritePerformed: false;
}

export interface MemoryAdapterMetadata {
  adapterId: string;
  adapterVersion: string;
  contractVersion: string;
  externalFramework: false;
  canonicalWriteCapability: false;
}

export interface MemoryRunOutput {
  contractVersion: string;
  adapter: MemoryAdapterMetadata;
  caseId: string;
  requestId: string;
  jobStatus: 'needs_review' | 'succeeded';
  candidates: MemoryCandidate[];
  retrieval: Array<{
    proposalId: string;
    fragments: Array<Omit<ScoredEvidenceFragment, 'text' | 'recordedAt' | 'eventTime' | 'subjectId'>>;
  }>;
  transaction: {
    currentVersion: number;
    expectedVersion: number;
    idempotencyKey: string;
    idempotencyStatus: TransactionStatus;
    replayedResultRef: string | null;
    mutationIntentCount: number;
    canonicalWriteCount: 0;
  };
}

export interface SemanticSourceSpan {
  evidenceRef?: unknown;
  quote?: unknown;
}

export interface RawSemanticProposal {
  providerProposalId?: unknown;
  contentType?: unknown;
  normalizedClaim?: unknown;
  query?: unknown;
  sourceEvidenceRefs?: unknown;
  sourceSpans?: unknown;
  eventTime?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  sensitivityLevel?: unknown;
  signals?: {
    shortTerm?: unknown;
    temporalState?: unknown;
    conflict?: unknown;
    ambiguousSubject?: unknown;
    purposeExpansion?: unknown;
    visibilityExpansion?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type SemanticProviderResponse = RawSemanticProposal[] | { proposals: RawSemanticProposal[] };
export type SemanticProvider = (input: Readonly<HybridInput>) => Promise<SemanticProviderResponse> | SemanticProviderResponse;

export interface HybridExtractorOptions {
  semanticProvider?: SemanticProvider;
}

export interface HybridExtractionResult {
  extractor: {
    extractorId: string;
    extractorVersion: string;
    contractVersion: string;
    dependencies: readonly never[];
    network: false;
    model: false;
    acceptedInputFields: readonly string[];
    readsStructuredProposals: false;
    readsExpectedOracle: false;
    caseIdRules: false;
    canonicalWriteCapability: false;
  };
  proposals: MemoryProposal[];
  diagnostics: {
    mustExtractCount: number;
    semanticInputCount: number;
    semanticAcceptedCount: number;
    semanticRejectedCount: number;
    semanticRejections: Array<{ index: number; reason: string }>;
    mergeCount: number;
    outputCount: number;
  };
  invocation: {
    provider: 'offline-injected-semantic-provider';
    model: null;
    network: false;
    usage: { inputTokens: 0; outputTokens: 0; totalTokens: 0 };
    actualCostCny: 0;
  };
}

export type ReferenceStatus = 'CANDIDATE' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface ReferenceRecord {
  recordId: string;
  logicalId: string;
  version: number;
  status: ReferenceStatus;
  candidate: MemoryCandidate;
  submittedAt: string;
  activatedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  supersedesRecordId: string | null;
  supersededByRecordId: string | null;
  activationDecisionId: string | null;
  activationKind: 'BUSINESS_POLICY' | 'CONFIRMATION' | 'SOURCED_ACCEPTANCE' | null;
  activationAuthorityRef: string | null;
  attributedOnly: boolean;
}

export interface DeletedReferenceTombstone {
  recordId: string;
  logicalId: string;
  version: number;
  status: 'DELETED';
  deletedAt: string;
  reasonCode: string;
}

export type StoredReference = ReferenceRecord | DeletedReferenceTombstone;

export interface DeterministicBusinessDecision {
  decisionId: string;
  approved: boolean;
  deterministic: true;
  policyVersion: string;
  reasonCodes: string[];
  decidedAt: string;
}

export interface ConfirmationDecision {
  confirmationId: string;
  level: 'C2' | 'C3';
  actorId: string;
  actorRole: string;
  authorityRef?: string;
  confirmedAt: string;
}

export interface SourcedAcceptanceDecision {
  decisionId: string;
  actorId: string;
  actorRole: string;
  authorityRef?: string;
  acceptedAt: string;
}

export interface InvalidationAudit {
  actionId: string;
  actorId: string;
  actorRole: string;
  occurredAt: string;
  reasonCode: string;
}

export interface ReferenceRetrievalRequest {
  subjectId: string;
  familySpaceId: string;
  purpose: string;
  authorizationVersion: string;
  visibilityScope: string[];
  mode?: 'ORDINARY' | 'REVIEW';
  reviewAuthorityRef?: string;
  asOf?: string;
}

export interface ReferenceStoreSnapshot {
  snapshotVersion: 'sgx-reference-store-v1';
  records: StoredReference[];
  withdrawnEvidenceRefs: string[];
  operationResults: Array<[string, { fingerprint: string; recordId: string }]>;
}

export interface CandidateSubmissionContext {
  operationId: string;
  submittedAt: string;
}

export interface CorrectionContext extends CandidateSubmissionContext {}

export interface ReferenceIndexHit {
  recordId: string;
  score: number;
  [key: string]: unknown;
}

export interface GatedReferenceHit<T extends ReferenceIndexHit = ReferenceIndexHit> {
  hit: T;
  record: ReferenceRecord;
}
