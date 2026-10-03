#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);

if (roots.length === 0) {
  console.error('Usage: node scripts/voice-secret-scan.mjs <file-or-dir> [...]');
  process.exit(2);
}

const ignoredDirs = new Set(['.git', '.next', 'node_modules', 'dist', 'build', 'coverage']);
const textExtensions = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.env',
  ''
]);

const secretPatterns = [
  {
    name: 'ark-style-key',
    pattern: /ark-[A-Za-z0-9_-]{20,}/g
  },
  {
    name: 'api-key-assignment',
    pattern: /\b(?:DOUBAO(?:_[A-Z0-9]+)*|VOLCENGINE(?:_[A-Z0-9]+)*|OPENAI|LLM|SEARCH|QWEN|ZHIPU|SILICONFLOW|MINIMAX(?:_[A-Z0-9]+)*)_API_KEY\s*=\s*["']?[A-Za-z0-9._-]{12,}/g
  },
  {
    name: 'provider-secret-assignment',
    pattern: /\b(?:DOUBAO_REALTIME|VOLC)_(?:ACCESS_KEY|APP_KEY)\s*=\s*["']?[A-Za-z0-9._-]{12,}/g
  },
  {
    name: 'aws-access-key',
    pattern: /AKIA[0-9A-Z]{16}/g
  }
];

const findings = [];

function shouldScan(filePath) {
  return textExtensions.has(path.extname(filePath));
}

function walk(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const stat = fs.statSync(targetPath);

  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) {
        continue;
      }
      walk(path.join(targetPath, entry.name));
    }
    return;
  }

  if (!stat.isFile() || !shouldScan(targetPath)) {
    return;
  }

  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    for (const { name, pattern } of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        if (name === 'api-key-assignment' && /(your-api-key|=\s*\.\.\.)/.test(line)) {
          continue;
        }
        if (name === 'provider-secret-assignment' && /(不写入仓库|secret storage|process\.env|\|\s*是\s*\|)/.test(line)) {
          continue;
        }
        findings.push({
          file: targetPath,
          line: lineIndex + 1,
          pattern: name
        });
      }
    }
  }
}

for (const root of roots) {
  walk(root);
}

if (findings.length > 0) {
  console.error('Potential secrets found:');
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.pattern}`);
  }
  process.exit(1);
}

console.log('voice secret scan ok');
