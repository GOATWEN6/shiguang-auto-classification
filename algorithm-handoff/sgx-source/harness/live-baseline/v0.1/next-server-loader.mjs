import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Test-only Node loader. Next exposes `next/server` through its bundler
 * package map, while a direct Node route-handler test needs the concrete file.
 * This does not participate in the application build or production runtime.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') {
    return nextResolve(pathToFileURL(resolvePath(process.cwd(), 'node_modules/next/server.js')).href, context);
  }
  return nextResolve(specifier, context);
}
