import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryReferenceStore,
  gateReferenceIndexHits,
  referenceStoreMetadata,
  runCase,
  type DeterministicBusinessDecision,
  type InvalidationAudit,
  type MemoryCandidate,
  type ReferenceRetrievalRequest,
} from '../../../src/lib/memory-runtime/index.ts';
import { cases } from '../../oss-p0/memory/cases.mjs';

const T0 = '2026-10-03T08:00:00.000Z';
const T1 = '2026-10-03T08:01:00.000Z';
const T2 = '2026-10-03T08:02:00.000Z';

function fixedCase(caseId: string) {
  const testCase = cases.find(item => item.caseId === caseId);
  assert.ok(testCase, `missing fixed case ${caseId}`);
  return structuredClone(testCase);
}

async function candidate(caseId: string, proposalId?: string): Promise<MemoryCandidate> {
  const testCase = fixedCase(caseId);
  const output = await runCase(structuredClone({
    caseId: testCase.caseId,
    fixtureVersion: testCase.fixtureVersion,
    policyVersion: testCase.policyVersion,
    ...testCase.input,
  }));
  const result = proposalId
    ? output.candidates.find(item => item.proposalId === proposalId)
    : output.candidates[0];
  assert.ok(result, `missing candidate ${caseId}:${proposalId ?? 'first'}`);
  return structuredClone(result);
}

function submit(store: InMemoryReferenceStore, item: MemoryCandidate, suffix: string) {
  return store.submitCandidate(item, {
    operationId: `submit-${suffix}`,
    submittedAt: T0,
  });
}

function approve(
  store: InMemoryReferenceStore,
  recordId: string,
  item: MemoryCandidate,
  suffix: string,
) {
  const decision: DeterministicBusinessDecision = {
    decisionId: `business-${suffix}`,
    approved: true,
    deterministic: true,
    policyVersion: item.policyVersion,
    reasonCodes: ['REFERENCE_BUSINESS_GATE_FIXTURE'],
    decidedAt: T1,
  };
  return store.approveAutoWrite(recordId, decision);
}

function activateAuto(store: InMemoryReferenceStore, item: MemoryCandidate, suffix: string) {
  const submitted = submit(store, item, suffix);
  return approve(store, submitted.recordId, item, suffix);
}

function requestFor(item: MemoryCandidate, overrides: Partial<ReferenceRetrievalRequest> = {}): ReferenceRetrievalRequest {
  return {
    subjectId: item.subjectId,
    familySpaceId: item.familySpaceId,
    purpose: item.allowedUses[0],
    authorizationVersion: item.authorizationVersion,
    visibilityScope: [...item.visibilityScope],
    ...overrides,
  };
}

function audit(actionId: string, reasonCode: string): InvalidationAudit {
  return {
    actionId,
    actorId: 'elder-001',
    actorRole: 'elder',
    occurredAt: T2,
    reasonCode,
  };
}

test('Reference Store is candidate-only and rejects model or extractor attempts to write directly', async () => {
  assert.deepEqual(referenceStoreMetadata, {
    storeId: 'sgx-in-memory-reference-store',
    storeVersion: '0.1.0',
    canonicalWriteCapability: false,
    decisionGatedActivationCapability: true,
    durable: false,
  });
  const store = new InMemoryReferenceStore();
  assert.equal(store.canonicalWriteCapability, false);
  assert.equal(store.decisionGatedActivationCapability, true);

  const modelCandidate = await candidate('PC-03');
  assert.equal(modelCandidate.authorityState, 'MODEL_CANDIDATE');
  assert.equal(modelCandidate.disposition, 'C2_BATCH_CONFIRM');
  const submitted = submit(store, modelCandidate, 'model-candidate');
  assert.equal(submitted.status, 'CANDIDATE');
  assert.equal(submitted.candidate.canonicalWritePerformed, false);
  assert.equal(store.retrieve(requestFor(modelCandidate)).length, 0);
  assert.throws(
    () => store.approveAutoWrite(submitted.recordId, {
      decisionId: 'business-model-forbidden',
      approved: true,
      deterministic: true,
      policyVersion: modelCandidate.policyVersion,
      reasonCodes: ['MODEL_REQUESTED_WRITE'],
      decidedAt: T1,
    }),
    /not eligible|AUTO_WRITE/,
  );

  assert.throws(
    () => store.submitCandidate({ ...modelCandidate, canonicalWritePerformed: true } as any, {
      operationId: 'submit-forged-canonical-write',
      submittedAt: T0,
    }),
    /canonical writes are forbidden/,
  );
});

test('AUTO_WRITE remains invisible until an approved deterministic business gate activates it', async () => {
  const store = new InMemoryReferenceStore();
  const item = await candidate('CI-02');
  assert.equal(item.disposition, 'AUTO_WRITE');
  assert.equal(item.writeEligibility, 'ELIGIBLE_FOR_BUSINESS_GATE');
  const submitted = submit(store, item, 'auto-gated');
  const request = requestFor(item);
  assert.equal(store.retrieve(request).length, 0);

  assert.throws(() => store.approveAutoWrite(submitted.recordId, {
    decisionId: 'business-denied',
    approved: false,
    deterministic: true,
    policyVersion: item.policyVersion,
    reasonCodes: ['DENIED'],
    decidedAt: T1,
  }), /approved deterministic/);
  assert.throws(() => store.approveAutoWrite(submitted.recordId, {
    decisionId: 'business-wrong-policy',
    approved: true,
    deterministic: true,
    policyVersion: 'wrong-policy',
    reasonCodes: ['WRONG_POLICY'],
    decidedAt: T1,
  }), /policyVersion/);

  const active = approve(store, submitted.recordId, item, 'auto-gated');
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.activationKind, 'BUSINESS_POLICY');
  assert.equal(active.candidate.canonicalWritePerformed, false);
  assert.deepEqual(store.retrieve(request).map(record => record.recordId), [active.recordId]);
});

test('C2 and C3 candidates require the matching confirmation path and level', async () => {
  const store = new InMemoryReferenceStore();
  const c2 = await candidate('PC-03');
  const c3 = await candidate('M2-05', 'p-m2-05-a');
  const c2Record = submit(store, c2, 'c2');
  const c3Record = submit(store, c3, 'c3');

  const delegatedStore = new InMemoryReferenceStore();
  const delegatedRecord = submit(delegatedStore, c2, 'c2-delegated');
  assert.throws(() => delegatedStore.confirm(delegatedRecord.recordId, {
    confirmationId: 'confirm-c2-family-without-authority',
    level: 'C2',
    actorId: 'family-001',
    actorRole: 'family',
    confirmedAt: T1,
  }), /authorityRef/);
  const delegatedActive = delegatedStore.confirm(delegatedRecord.recordId, {
    confirmationId: 'confirm-c2-family-authorized',
    level: 'C2',
    actorId: 'family-001',
    actorRole: 'family',
    authorityRef: 'role-binding:family-001:confirm-memory',
    confirmedAt: T1,
  });
  assert.equal(delegatedActive.activationAuthorityRef, 'role-binding:family-001:confirm-memory');

  const c2Active = store.confirm(c2Record.recordId, {
    confirmationId: 'confirm-c2',
    level: 'C2',
    actorId: 'elder-001',
    actorRole: 'elder',
    confirmedAt: T1,
  });
  assert.equal(c2Active.status, 'ACTIVE');
  assert.equal(c2Active.activationKind, 'CONFIRMATION');
  assert.deepEqual(store.retrieve(requestFor(c2)).map(item => item.recordId), [c2Active.recordId]);

  assert.throws(() => store.confirm(c3Record.recordId, {
    confirmationId: 'confirm-c3-too-weak',
    level: 'C2',
    actorId: 'elder-001',
    actorRole: 'elder',
    confirmedAt: T1,
  }), /requires a C3 confirmation/);
  const c3Active = store.confirm(c3Record.recordId, {
    confirmationId: 'confirm-c3',
    level: 'C3',
    actorId: 'elder-001',
    actorRole: 'elder',
    confirmedAt: T1,
  });
  assert.equal(c3Active.status, 'ACTIVE');
  assert.deepEqual(store.retrieve(requestFor(c3)).map(item => item.recordId), [c3Active.recordId]);
});

test('confirmation replay is idempotent while payload reuse and illegal transitions fail closed', async () => {
  const store = new InMemoryReferenceStore();
  const item = await candidate('PC-03');
  const record = submit(store, item, 'confirm-idempotent');
  const decision = {
    confirmationId: 'confirm-idempotent',
    level: 'C2' as const,
    actorId: 'elder-001',
    actorRole: 'elder',
    confirmedAt: T1,
  };
  const first = store.confirm(record.recordId, decision);
  assert.deepEqual(store.confirm(record.recordId, structuredClone(decision)), first);
  assert.throws(
    () => store.confirm(record.recordId, { ...decision, actorId: 'other-actor' }),
    /operationId reused with a different payload/,
  );
  assert.throws(
    () => store.confirm(record.recordId, { ...decision, confirmationId: 'confirm-again' }),
    /illegal transition/,
  );
});

test('an explicit correction creates a new active version and preserves the superseded source version', async () => {
  const store = new InMemoryReferenceStore();
  const priorCandidate = await candidate('CI-02');
  const prior = activateAuto(store, priorCandidate, 'correction-prior');
  const correctedCandidate = await candidate('PV-01');
  assert.equal(correctedCandidate.confirmationBasis, 'explicit_item');
  const corrected = store.correct(
    prior.recordId,
    correctedCandidate,
    {
      decisionId: 'business-correction-v2',
      approved: true,
      deterministic: true,
      policyVersion: correctedCandidate.policyVersion,
      reasonCodes: ['ELDER_EXPLICIT_CORRECTION'],
      decidedAt: T2,
    },
    { operationId: 'correct-drink-v2', submittedAt: T2 },
  );

  assert.equal(corrected.logicalId, prior.logicalId);
  assert.equal(corrected.version, 2);
  assert.equal(corrected.status, 'ACTIVE');
  assert.equal(corrected.supersedesRecordId, prior.recordId);
  const old = store.get(prior.recordId);
  assert.ok(old && old.status !== 'DELETED');
  assert.equal(old.status, 'SUPERSEDED');
  assert.equal(old.supersededByRecordId, corrected.recordId);
  assert.equal(old.candidate.normalizedClaim, priorCandidate.normalizedClaim);
  assert.deepEqual(
    store.retrieve(requestFor(correctedCandidate)).map(record => record.recordId),
    [corrected.recordId],
  );

  store.delete(corrected.recordId, audit('delete-corrected-logical-memory', 'ELDER_DELETED'));
  for (const recordId of [prior.recordId, corrected.recordId]) {
    const deleted = store.get(recordId);
    assert.ok(deleted && deleted.status === 'DELETED');
    assert.deepEqual(Object.keys(deleted).sort(), [
      'deletedAt', 'logicalId', 'reasonCode', 'recordId', 'status', 'version',
    ].sort());
  }
  const restored = InMemoryReferenceStore.restore(store.exportSnapshot());
  assert.ok(restored.get(prior.recordId)?.status === 'DELETED');
  assert.ok(restored.get(corrected.recordId)?.status === 'DELETED');
  assert.throws(
    () => restored.submitCandidate(priorCandidate, {
      operationId: 'resubmit-deleted-logical-memory',
      submittedAt: T2,
    }),
    /deleted logical reference/,
  );
});

test('open conflicts keep both attributed claims but are only retrievable in explicit review mode', async () => {
  const store = new InMemoryReferenceStore();
  const family = await candidate('M2-06', 'p-m2-06-a');
  const elder = await candidate('M2-06', 'p-m2-06-b');
  assert.equal(family.disposition, 'SOURCED_ONLY');
  assert.equal(elder.disposition, 'C2_BATCH_CONFIRM');
  const familyRecord = submit(store, family, 'conflict-family');
  const elderRecord = submit(store, elder, 'conflict-elder');
  assert.throws(() => store.acceptSourced(familyRecord.recordId, {
    decisionId: 'accept-conflict-family-without-authority',
    actorId: 'reviewer-001',
    actorRole: 'reviewer',
    acceptedAt: T1,
  }), /authorityRef/);
  const familyActive = store.acceptSourced(familyRecord.recordId, {
    decisionId: 'accept-conflict-family',
    actorId: 'reviewer-001',
    actorRole: 'reviewer',
    authorityRef: 'role-binding:reviewer-001:accept-sourced-memory',
    acceptedAt: T1,
  });
  const elderActive = store.confirm(elderRecord.recordId, {
    confirmationId: 'confirm-conflict-elder',
    level: 'C2',
    actorId: 'elder-001',
    actorRole: 'elder',
    confirmedAt: T1,
  });
  assert.equal(familyActive.attributedOnly, true);
  assert.equal(familyActive.activationAuthorityRef, 'role-binding:reviewer-001:accept-sourced-memory');
  assert.equal(elderActive.attributedOnly, false);
  const ordinary = requestFor(elder);
  assert.equal(store.retrieve(ordinary).length, 0);
  assert.throws(() => store.retrieve({ ...ordinary, mode: 'REVIEW' }), /reviewAuthorityRef/);
  const review = store.retrieve({
    ...ordinary,
    mode: 'REVIEW',
    reviewAuthorityRef: 'role-binding:reviewer-001:conflict-review',
  });
  assert.deepEqual(new Set(review.map(record => record.recordId)), new Set([familyActive.recordId, elderActive.recordId]));
  assert.deepEqual(new Set(review.map(record => record.candidate.sourceActor.actorId)), new Set(['daughter-001', 'elder-001']));
  assert.ok(review.every(record => record.candidate.conflictState === 'OPEN'));
});

test('retrieval enforces subject, family, purpose, authorization and visibility independently', async () => {
  const store = new InMemoryReferenceStore();
  const item = await candidate('M2-01');
  const active = activateAuto(store, item, 'scope');
  const allowed = requestFor(item);
  assert.deepEqual(store.retrieve(allowed).map(record => record.recordId), [active.recordId]);
  assert.equal(store.retrieve({ ...allowed, subjectId: 'elder-other' }).length, 0);
  assert.equal(store.retrieve({ ...allowed, familySpaceId: 'family-other' }).length, 0);
  assert.equal(store.retrieve({ ...allowed, purpose: 'family_broadcast' }).length, 0);
  assert.equal(store.retrieve({ ...allowed, authorizationVersion: 'auth-v2' }).length, 0);
  assert.equal(store.retrieve({ ...allowed, visibilityScope: ['family_admin'] }).length, 0);
});

test('retrieval rejects empty scope fields before consulting stored records', async () => {
  const store = new InMemoryReferenceStore();
  const item = await candidate('M2-01');
  activateAuto(store, item, 'invalid-empty-scope');
  const allowed = requestFor(item);
  const invalidRequests: Array<{
    request: ReferenceRetrievalRequest;
    expectedField: RegExp;
  }> = [
    { request: { ...allowed, subjectId: '   ' }, expectedField: /subjectId/ },
    { request: { ...allowed, familySpaceId: '' }, expectedField: /familySpaceId/ },
    { request: { ...allowed, purpose: '\t' }, expectedField: /purpose/ },
    { request: { ...allowed, authorizationVersion: '' }, expectedField: /authorizationVersion/ },
    { request: { ...allowed, visibilityScope: [] }, expectedField: /visibilityScope/ },
    { request: { ...allowed, visibilityScope: [''] }, expectedField: /visibilityScope item/ },
  ];

  for (const { request, expectedField } of invalidRequests) {
    assert.throws(() => store.retrieve(request), expectedField);
  }
});

test('asOf retrieval excludes records before validFrom and after validTo while including the interval boundaries', async () => {
  const store = new InMemoryReferenceStore();
  const base = await candidate('CI-02');
  const temporal: MemoryCandidate = {
    ...base,
    validFrom: '2026-09-01',
    validTo: '2026-09-07',
  };
  const active = activateAuto(store, temporal, 'temporal-window');
  const request = requestFor(temporal);
  const idsAt = (asOf: string) => store.retrieve({ ...request, asOf }).map(record => record.recordId);

  assert.deepEqual(idsAt('2026-08-31T23:59:59.999Z'), []);
  assert.deepEqual(idsAt('2026-09-01'), [active.recordId]);
  assert.deepEqual(idsAt('2026-09-04T12:00:00.000Z'), [active.recordId]);
  assert.deepEqual(idsAt('2026-09-07'), [active.recordId]);
  assert.deepEqual(idsAt('2026-09-08T00:00:00.000Z'), []);
});

test('revoke, delete and evidence withdrawal suppress current and restored retrieval without harming unrelated records', async () => {
  const store = new InMemoryReferenceStore();
  const revokedCandidate = await candidate('M2-01');
  const deletedCandidate = await candidate('M2-03', 'p-m2-03-a');
  const withdrawnCandidate = await candidate('CI-02');
  const unrelatedCandidate = await candidate('M2-03', 'p-m2-03-b');
  const revoked = activateAuto(store, revokedCandidate, 'revoke');
  const deleted = activateAuto(store, deletedCandidate, 'delete');
  const withdrawn = activateAuto(store, withdrawnCandidate, 'withdraw');
  const unrelated = activateAuto(store, unrelatedCandidate, 'unrelated');

  store.revoke(revoked.recordId, audit('revoke-current', 'ELDER_REVOKED'));
  const tombstone = store.delete(deleted.recordId, audit('delete-current', 'ELDER_DELETED'));
  assert.deepEqual(store.withdrawEvidence(
    withdrawnCandidate.evidenceRefs[0],
    audit('withdraw-evidence-current', 'SOURCE_WITHDRAWN'),
  ), [withdrawn.recordId]);

  assert.equal(store.retrieve(requestFor(revokedCandidate)).some(record => record.recordId === revoked.recordId), false);
  assert.equal(store.retrieve(requestFor(deletedCandidate)).some(record => record.recordId === deleted.recordId), false);
  assert.equal(store.retrieve(requestFor(withdrawnCandidate)).some(record => record.recordId === withdrawn.recordId), false);
  assert.deepEqual(store.retrieve(requestFor(unrelatedCandidate)).map(record => record.recordId), [unrelated.recordId]);

  assert.deepEqual(Object.keys(tombstone).sort(), [
    'deletedAt', 'logicalId', 'reasonCode', 'recordId', 'status', 'version',
  ].sort());
  assert.equal('candidate' in tombstone, false);

  const restored = InMemoryReferenceStore.restore(store.exportSnapshot());
  assert.equal(restored.retrieve(requestFor(revokedCandidate)).some(record => record.recordId === revoked.recordId), false);
  assert.equal(restored.retrieve(requestFor(deletedCandidate)).some(record => record.recordId === deleted.recordId), false);
  assert.equal(restored.retrieve(requestFor(withdrawnCandidate)).some(record => record.recordId === withdrawn.recordId), false);
  assert.deepEqual(restored.retrieve(requestFor(unrelatedCandidate)).map(record => record.recordId), [unrelated.recordId]);
  const restoredTombstone = restored.get(deleted.recordId);
  assert.ok(restoredTombstone && restoredTombstone.status === 'DELETED');
  assert.deepEqual(Object.keys(restoredTombstone).sort(), Object.keys(tombstone).sort());
});

test('stale search-index hits are rechecked against live store state before use', async () => {
  const store = new InMemoryReferenceStore();
  const staleCandidate = await candidate('CI-02');
  const liveCandidate = await candidate('M2-03', 'p-m2-03-a');
  const stale = activateAuto(store, staleCandidate, 'stale-index');
  const live = activateAuto(store, liveCandidate, 'live-index');
  store.revoke(stale.recordId, audit('revoke-stale-index', 'ELDER_REVOKED'));

  const request: ReferenceRetrievalRequest = {
    subjectId: liveCandidate.subjectId,
    familySpaceId: liveCandidate.familySpaceId,
    purpose: 'interview_orchestration',
    authorizationVersion: liveCandidate.authorizationVersion,
    visibilityScope: [...liveCandidate.visibilityScope],
  };
  const hits = gateReferenceIndexHits(store, [
    { recordId: stale.recordId, score: 0.99, source: 'stale-vector-index' },
    { recordId: live.recordId, score: 0.8, source: 'stale-vector-index' },
    { recordId: live.recordId, score: 0.7, source: 'duplicate-hit' },
    { recordId: 'unknown-record', score: 1, source: 'stale-vector-index' },
  ], request);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].hit.recordId, live.recordId);
  assert.equal(hits[0].record.recordId, live.recordId);

  assert.throws(
    () => gateReferenceIndexHits(store, [], { ...request, subjectId: ' ' }),
    /subjectId/,
  );
});
