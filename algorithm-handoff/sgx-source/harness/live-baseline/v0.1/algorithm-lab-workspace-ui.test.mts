import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const source = readFileSync(resolve(root, 'src/app/algorithm-lab/page.tsx'), 'utf8');

test('algorithm lab restores and persists the complete reviewable UI state', () => {
  for (const field of [
    'messages', 'turns', 'messageRatings', 'reviewFeedback', 'latestView',
    'latestResult', 'derivedRequested', 'activeSessionHandle',
  ]) assert.match(source, new RegExp(`\\b${field}\\b`, 'u'), `missing persisted field ${field}`);

  assert.match(source, /fetch\(`\$\{workspaceBase\}\/bootstrap`, \{ method: 'POST'/u);
  assert.match(source, /schemaVersion: 'test-workspace-ui-update-v0\.1', expectedRevision: revision, ui/u);
  assert.match(source, /response\.status === 409/u);
  assert.match(source, /mergeWorkspaceUi\(workspaceUiFromEnvelope\(currentBody\), localUi\)/u);
  assert.match(source, /if \(!workspaceHydrated\) return;[\s\S]*fetch\(`\$\{base\}\/health`/u,
    'public runtime reads must wait until bootstrap has issued the workspace cookie');
  assert.match(source, /\}, \[workspaceHydrated\]\);/u);
});

test('workspace snapshots exclude audio, base64 and credential-shaped fields', () => {
  const snapshotStart = source.indexOf('function currentWorkspaceUi()');
  const snapshotEnd = source.indexOf('function restoreWorkspaceUi', snapshotStart);
  const snapshot = source.slice(snapshotStart, snapshotEnd);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  assert.doesNotMatch(snapshot, /savedPcm|base64Audio|audioURL|subjectBinding/u);

  for (const blocked of ['audio', 'base64', 'cookie', 'credential', 'authorization', 'password', 'secret', 'token']) {
    assert.match(source, new RegExp(`normalized\\.includes\\('${blocked}'\\)`, 'u'));
  }
  assert.match(source, /value\.startsWith\('data:audio\/'\)/u);
});

test('export saves the latest CAS revision before requesting the isolated server export', () => {
  const exportStart = source.indexOf('async function exportFeedback()');
  const exportEnd = source.indexOf('\n  const memories =', exportStart);
  const body = source.slice(exportStart, exportEnd);
  const save = body.indexOf('await queueWorkspaceSave');
  const download = body.indexOf('fetch(`${workspaceBase}/current/export`');
  assert.ok(save >= 0 && download > save, 'server export must run after latest workspace save');
  assert.match(body, /if \(!saved\)[\s\S]*本次没有下载旧版本/u);
  assert.match(body, /导出不包含音频、凭据或其他设备资料/u);
});

test('an expired algorithm session keeps restored history and rotates only on the next turn', () => {
  assert.match(source, /preserveHistoryOnNextSession\.current = true/u);
  assert.match(source, /createSession\(\{ preserveHistory: preserveHistoryOnNextSession\.current \}\)/u);
  assert.match(source, /if \(!options\.preserveHistory\) \{[\s\S]*setMessages\(\[\]\)/u);
  assert.match(source, /\[401, 403, 404, 409, 410\]\.includes\(sessionResponse\.status\)/u);
});
