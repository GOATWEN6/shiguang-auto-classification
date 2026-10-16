import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 仅复制 lockfile 已安装依赖中的资源，不下载其他版本或调用模型。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const sources = [
  ['@ricky0123/vad-web', '0.0.30', ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']],
  ['onnxruntime-web', '1.26.0', ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']],
];
const output = join(root, 'public', 'vad');
const prepared = [];
function installedPackage(name) {
  let directory = dirname(require.resolve(name));
  while (true) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const metadata = JSON.parse(readFileSync(candidate, 'utf8'));
      if (metadata.name === name) return { directory, metadata };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`找不到已安装依赖 ${name}`);
    directory = parent;
  }
}
for (const [name, expectedVersion, files] of sources) {
  const { directory, metadata } = installedPackage(name);
  if (metadata.version !== expectedVersion) {
    throw new Error(`${name}: 预期 ${expectedVersion}，实际 ${metadata.version}；请先按 package-lock.json 安装。`);
  }
  for (const file of files) {
    const source = join(directory, 'dist', file);
    const bytes = readFileSync(source);
    prepared.push({ source, file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
mkdirSync(output, { recursive: true });
for (const item of prepared) {
  copyFileSync(item.source, join(output, item.file));
  console.log(`${item.file} sha256=${item.sha256}`);
}
