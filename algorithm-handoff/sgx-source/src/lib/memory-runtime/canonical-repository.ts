import type {
  CandidateSubmissionContext,
  ConfirmationDecision,
  CorrectionContext,
  DeletedReferenceTombstone,
  DeterministicBusinessDecision,
  InvalidationAudit,
  MemoryCandidate,
  ReferenceRecord,
  ReferenceRetrievalRequest,
  ReferenceStoreSnapshot,
  SourcedAcceptanceDecision,
  StoredReference,
} from './contracts.ts';

/**
 * Stable algorithm-side port for the authoritative Life Memory repository.
 *
 * This is deliberately narrower than a database DAO.  The algorithm service
 * can submit candidates, request deterministic activation, retrieve permitted
 * records, and issue governed corrections/revocations.  A backend adapter is
 * responsible for transactions, authorization, persistence, outbox delivery,
 * and deletion workers; the algorithm must never receive a direct database
 * handle.
 */
export const canonicalMemoryRepositoryContract = {
  contractVersion: 'sgx-canonical-memory-repository-v0.1',
  canonicalWriteOwner: 'business-backend',
  algorithmDirectDatabaseAccess: false,
  defaultDurable: false,
} as const;

export interface CanonicalMemoryRepository {
  /** The algorithm-side adapter must remain read/candidate-only by default. */
  readonly canonicalWriteCapability: boolean;

  /** Candidate submission is not authority activation. */
  submitCandidate(
    candidate: MemoryCandidate,
    context: CandidateSubmissionContext,
  ): ReferenceRecord;

  /** Deterministic backend policy may activate an approved low-risk candidate. */
  approveAutoWrite(
    recordId: string,
    decision: DeterministicBusinessDecision,
  ): ReferenceRecord;

  /** Explicit C2/C3 confirmation may activate a review-gated candidate. */
  confirm(recordId: string, decision: ConfirmationDecision): ReferenceRecord;

  /** A sourced claim can be accepted without being upgraded to self-asserted fact. */
  acceptSourced(recordId: string, decision: SourcedAcceptanceDecision): ReferenceRecord;

  /** Corrections create a new version; they do not overwrite prior evidence. */
  correct(
    recordId: string,
    correctedCandidate: MemoryCandidate,
    decision: DeterministicBusinessDecision,
    context: CorrectionContext,
  ): ReferenceRecord;

  /** Revoke stops ordinary retrieval immediately while preserving an audit record. */
  revoke(recordId: string, audit: InvalidationAudit): ReferenceRecord;

  /** Delete a logical memory and leave a content-free tombstone. */
  delete(recordId: string, audit: InvalidationAudit): DeletedReferenceTombstone;

  /** Delete one obsolete version when an evidence source is withdrawn. */
  deleteVersion(recordId: string, audit: InvalidationAudit): DeletedReferenceTombstone;

  /** Withdrawn evidence invalidates every dependent candidate/active record. */
  withdrawEvidence(evidenceRef: string, audit: InvalidationAudit): string[];

  /** Retrieval must apply purpose, authorization, visibility, status and time gates. */
  retrieve(request: ReferenceRetrievalRequest): ReferenceRecord[];

  isRecordUsable(recordId: string, request: ReferenceRetrievalRequest): boolean;

  get(recordId: string): StoredReference | null;

  /** Only the in-memory adapter uses snapshots; a durable adapter maps this to backup/export. */
  exportSnapshot(): ReferenceStoreSnapshot;
}
