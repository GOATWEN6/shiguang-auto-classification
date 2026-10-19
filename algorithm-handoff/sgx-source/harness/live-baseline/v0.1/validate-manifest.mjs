import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const scenarios = JSON.parse(readFileSync(join(root, manifest.scenarioManifest), 'utf8'));

const expectedModules = [
  'asr',
  'tts',
  'daily_chat',
  'formal_interview',
  'memory',
  'story_draft',
  'profile_draft',
];

assert.equal(manifest.paidExecutionEnabled, false, 'Phase 0 must not enable paid execution');
assert.equal(manifest.authorization.canonicalWriteCapability, false, 'Model must not write CanonicalMemory');
assert.equal(manifest.budget.hardCap, 60, 'Budget hard cap drifted');
assert.equal(manifest.budget.pauseBeforeExposureReaches, 45, 'Budget review point drifted');
assert.ok(manifest.budget.pauseBeforeExposureReaches < manifest.budget.hardCap);
assert.equal(
  manifest.budget.phases.reduce((sum, phase) => sum + phase.cap, 0),
  manifest.budget.hardCap,
  'Phase caps must sum to the hard cap'
);
assert.equal(manifest.attemptPolicy.maxRetriesAfterInitial, 3);
assert.equal(manifest.attemptPolicy.maxAttemptsPerCase, 4);
assert.equal(manifest.attemptPolicy.allAttemptsRemainInLedger, true);
assert.equal(manifest.attemptPolicy.noBestOfSelection, true);

assert.deepEqual(manifest.moduleBaselines.map(item => item.module), expectedModules);
for (const moduleBaseline of manifest.moduleBaselines) {
  assert.equal(moduleBaseline.fixedCases, 8, `${moduleBaseline.module} fixed denominator drifted`);
  assert.ok(moduleBaseline.minimumSuccessfulCalls >= 5, `${moduleBaseline.module} requires fewer than five successes`);
  assert.ok(moduleBaseline.minimumSuccessfulCalls <= moduleBaseline.fixedCases);
}

assert.equal(scenarios.fictionalOnly, true);
assert.deepEqual(scenarios.modulesPerScenario, expectedModules);
assert.equal(scenarios.scenarios.length, 8, 'Scenario denominator must remain eight');
assert.equal(new Set(scenarios.scenarios.map(item => item.id)).size, 8, 'Scenario IDs must be unique');
assert.equal(scenarios.scenarios.filter(item => item.requiredActualStory).length, 5);
assert.equal(scenarios.scenarios.filter(item => item.requiredActualProfile).length, 5);
for (const scenario of scenarios.scenarios) {
  assert.ok(scenario.facts.length > 0, `${scenario.id} needs facts`);
  assert.ok(scenario.expected.length > 0, `${scenario.id} needs expected behavior`);
  assert.ok(scenario.mustNot.length > 0, `${scenario.id} needs prohibited behavior`);
  assert.ok(scenario.asrCondition, `${scenario.id} needs an ASR condition`);
}

assert.equal(manifest.endToEnd.sessions.length, 3);
assert.equal(manifest.endToEnd.sessions.reduce((sum, item) => sum + item.turns, 0), 24);
assert.equal(manifest.endToEnd.interruptions, 10);
assert.equal(manifest.dataLifecycle.retentionDaysFromSourceCapture, 40);
assert.equal(manifest.dataLifecycle.deletionSlaHours, 24);
assert.equal(manifest.dataLifecycle.withdrawalImmediateInvalidation, true);
assert.equal(manifest.dataLifecycle.retainedAuditContainsContent, false);
assert.equal(manifest.runtimeGovernance.durableRepositoryRequiredForPaidExecution, true);
assert.equal(manifest.runtimeGovernance.atomicSnapshotRequired, true);
assert.equal(manifest.runtimeGovernance.frozenCostCatalogRequired, true);
assert.equal(manifest.runtimeGovernance.requiredDeletionSurfaceReceipts, true);
assert.ok(manifest.hardStops.includes('budget_exposure_would_reach_or_exceed_45_without_owner_review'));
assert.deepEqual(manifest.budget.ownerReviewGate.triggers, [
  'exposure_reaches_or_exceeds_45',
  'remaining_budget_cannot_cover_next_stage',
]);
assert.ok(manifest.budget.ownerReviewGate.requiredReportFields.includes('failed_attempts'));
assert.ok(manifest.budget.ownerReviewGate.requiredReportFields.includes('additional_budget_reason'));
assert.ok(manifest.budget.ownerReviewGate.authorizationMustBind.includes('review_report_hash'));
assert.ok(manifest.budget.ownerReviewGate.authorizationMustBind.includes('manifest_hash'));
assert.ok(manifest.hardStops.includes('model_can_write_canonical_memory'));
assert.ok(manifest.hardStops.includes('provider_data_terms_fail_confirmed_retention_boundary'));
assert.ok(manifest.hardStops.includes('durable_governance_repository_unavailable'));
assert.ok(manifest.hardStops.includes('required_deletion_receipts_incomplete'));

const serialized = JSON.stringify({ manifest, scenarios }).toLowerCase();
for (const forbiddenSecretField of ['apikey', 'api_key', 'accesskey', 'privatekey']) {
  assert.equal(serialized.includes(forbiddenSecretField), false, `Secret-like field found: ${forbiddenSecretField}`);
}

console.log(JSON.stringify({
  status: 'PASS',
  paidExecutionEnabled: manifest.paidExecutionEnabled,
  modules: manifest.moduleBaselines.length,
  fixedModuleCases: manifest.moduleBaselines.reduce((sum, item) => sum + item.fixedCases, 0),
  minimumSuccessfulCalls: manifest.moduleBaselines.reduce((sum, item) => sum + item.minimumSuccessfulCalls, 0),
  scenarioPacks: scenarios.scenarios.length,
  maximumAttemptsPerCase: manifest.attemptPolicy.maxAttemptsPerCase,
  hardCapCny: manifest.budget.hardCap,
  pauseBeforeExposureReachesCny: manifest.budget.pauseBeforeExposureReaches,
  endToEndTurns: manifest.endToEnd.sessions.reduce((sum, item) => sum + item.turns, 0),
  interruptions: manifest.endToEnd.interruptions,
}, null, 2));
