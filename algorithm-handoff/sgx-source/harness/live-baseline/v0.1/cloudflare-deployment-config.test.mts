import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const configPath = resolve(root, 'deploy/cloudflare/config.yml.example');
const readmePath = resolve(root, 'deploy/cloudflare/README.md');

const config = readFileSync(configPath, 'utf8');
const readme = readFileSync(readmePath, 'utf8');

test('named tunnel template only forwards the protected loopback gateway', () => {
  assert.match(config, /^tunnel:\s*<TUNNEL_UUID>\s*$/mu);
  assert.match(config, /^\s*credentials-file:\s*.+<TUNNEL_UUID>\.json\s*$/mu);
  assert.match(config, /^\s*- hostname:\s*<PUBLIC_TEST_HOSTNAME>\s*$/mu);
  assert.match(config, /^\s*service:\s*http:\/\/127\.0\.0\.1:3200\s*$/mu);
  assert.match(config, /^\s*- service:\s*http_status:404\s*$/mu);

  assert.doesNotMatch(config, /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):3100/u);
  assert.doesNotMatch(config, /0\.0\.0\.0:3200/u);
  assert.doesNotMatch(config, /^\s*(?:path|httpHostHeader):/mu);
  assert.doesNotMatch(config, /^\s*hostname:\s*.*[*?]/mu);
});

test('versioned tunnel files contain placeholders, never deployment credentials or real hostnames', () => {
  assert.doesNotMatch(config, /^\s*(?:token|password|secret|api[_-]?key|authorization):/imu);
  assert.doesNotMatch(config, /-----BEGIN [A-Z ]*PRIVATE KEY-----/u);
  assert.doesNotMatch(config, /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/iu);
  assert.doesNotMatch(config, /^\s*hostname:\s*(?!<PUBLIC_TEST_HOSTNAME>\s*$)\S+/mu);
  assert.match(config, /<LOCAL_ACCOUNT>/u);
});

test('operator guide states the availability and security boundaries', () => {
  for (const required of [
    'Quick Tunnel',
    'Named Tunnel',
    '127.0.0.1:3200',
    '不得把 `3100`',
    '本机休眠',
    '云主机',
    'Apache-2.0',
    'https://developers.cloudflare.com/',
    'https://github.com/cloudflare/cloudflared',
  ]) assert.ok(readme.includes(required), `README missing boundary: ${required}`);
});
