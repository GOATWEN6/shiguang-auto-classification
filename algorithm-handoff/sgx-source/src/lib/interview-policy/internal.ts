/**
 * Test-only compatibility surface used to prove parity with the frozen v0.2
 * harness. Production callers must import from index.ts, which does not export
 * this reducer because it accepts no live identity.
 */
export {
  decideCandidateNextAction as decideFrozenCompatibilityNextAction,
} from './reducer.ts';
export {
  assertDirectionPlan,
  assertPlanState,
  directionPlanIdFor,
} from './direction-plan.ts';
