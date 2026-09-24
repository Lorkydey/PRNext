import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Node already retains ESM namespaces. Keep only a bounded index of resolved
// Pages modules, never import promises (which can retain a request's ALS frame).
const resolvedPages = new Map();
export function loadedPagesModule(modulePath) { return resolvedPages.get(modulePath); }

export async function loadModule(modulePath, rememberPage = false) {
  // CJS must keep honoring application changes to require.cache/exports.
  if (modulePath.endsWith('.cjs')) return require(modulePath);
  const imported = import(pathToFileURL(modulePath).href);
  if (!rememberPage) return imported;
  const namespace = await imported;
  if (!resolvedPages.has(modulePath)) {
    if (resolvedPages.size >= 256) resolvedPages.delete(resolvedPages.keys().next().value);
    resolvedPages.set(modulePath, namespace);
  }
  return namespace;
}
