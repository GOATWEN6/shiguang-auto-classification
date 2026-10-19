import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const files = [
  'deploy/macos/run-algorithm-service.sh',
  'deploy/macos/run-public-gateway.sh',
  'deploy/macos/install-local-runtime.sh',
  'deploy/macos/com.sgx.algorithm-service.plist.example',
  'deploy/macos/com.sgx.public-gateway.plist.example',
  'deploy/macos/README.md',
].map(path => [path, readFileSync(resolve(root, path), 'utf8')] as const);
const all = files.map(([, content]) => content).join('\n');

test('macOS services bind only to protected loopback ports and use the standalone production build', () => {
  assert.match(all, /HOSTNAME="127\.0\.0\.1"/u);
  assert.match(all, /PORT="3100"/u);
  assert.match(all, /server\.js/u);
  assert.match(all, /127\.0\.0\.1:3200/u);
  assert.doesNotMatch(all, /(?:0\.0\.0\.0|localhost):3100/u);
  assert.doesNotMatch(all, /0\.0\.0\.0:3200/u);
  assert.match(all, /<key>KeepAlive<\/key><true\/>/u);
  assert.match(all, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(all, /Library\/Application Support\/SGX\/current/u);
});

test('versioned service templates contain no credentials and source only private env files', () => {
  assert.match(all, /\.config\/sgx\/algorithm-runtime\.env/u);
  assert.match(all, /\.config\/sgx\/public-gateway\.env/u);
  assert.match(all, /SGX_PUBLIC_GATEWAY_PASSWORD_FILE/u);
  assert.match(all, /provider\.env/u);
  assert.doesNotMatch(all, /-----BEGIN [A-Z ]*PRIVATE KEY-----/u);
  assert.doesNotMatch(all,
    /^\s*(?:API[_-]?KEY|ACCESS[_-]?KEY|PASSWORD)\s*=\s*[^<\n\s][^\n]*/imu);
});
