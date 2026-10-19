import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryReferenceStore } from '../../../src/lib/memory-runtime/reference-store.ts';
import type { CanonicalMemoryRepository } from '../../../src/lib/memory-runtime/canonical-repository.ts';

test('Reference Store satisfies the algorithm-side CanonicalMemory repository port', () => {
  const repository: CanonicalMemoryRepository = new InMemoryReferenceStore();

  assert.equal(repository.canonicalWriteCapability, false);
  assert.equal(typeof repository.submitCandidate, 'function');
  assert.equal(typeof repository.retrieve, 'function');
  assert.equal(typeof repository.revoke, 'function');
  assert.equal(typeof repository.delete, 'function');
  assert.equal(typeof repository.withdrawEvidence, 'function');
});
