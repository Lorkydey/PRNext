import {readFile, writeFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {partialShell, sha256, NATIVE_PPR_ARTIFACT_BYTES, NATIVE_PPR_PREFIX_BYTES} from '../runtime/native-ppr.mjs';

// Only concrete build-time shells are certified. Runtime regeneration, generic
// params, middleware and external caches stay on the authoritative Node path.
export async function prepareNativePprShells(stage, manifest) {
  delete manifest.config.nativePprArtifacts;
  if (!manifest.config.nativePprShell || !manifest.config.cacheComponents || manifest.dev || manifest.middleware || manifest.config.basePath || manifest.config.cacheHandler || Object.keys(manifest.config.cacheHandlers || {}).length) return;
  const descriptors = [];
  let total = 0;
  for (const route of [...manifest.routes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (route.kind !== 'page' || route.router !== 'app' || route.internal || route.parallel || route.cacheConfig?.runtime === 'edge') continue;
    for (const [pathname, artifactFile] of Object.entries(route.ppr || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (descriptors.length >= 32) break;
      const file = path.resolve(stage, artifactFile);
      if (!artifactFile.startsWith('static/') || !file.startsWith(path.resolve(stage) + path.sep) || (await stat(file)).size > NATIVE_PPR_ARTIFACT_BYTES) continue;
      const bytes = await readFile(file);
      const artifact = JSON.parse(bytes);
      if (artifact.version !== 1 || !artifact.postponed || artifact.complete || artifact.generic || artifact.externalCache || artifact.revalidate === 0 || typeof artifact.flight !== 'string' || Object.keys(artifact.headers || {}).length) continue;
      const prefix = Buffer.from(partialShell(artifact, route).replace(/<\/body><\/html>$/i, ''));
      if (prefix.length > NATIVE_PPR_PREFIX_BYTES || total + prefix.length > 4 * 1024 * 1024) continue;
      if (!Number.isSafeInteger(artifact.generatedAt) || artifact.generatedAt < 0 || !(artifact.revalidate == null || artifact.revalidate === false || Number.isSafeInteger(artifact.revalidate) && artifact.revalidate > 0)) continue;
      const prefixHash = sha256(prefix);
      const prefixFile = `static/native-ppr-${prefixHash}.html`;
      await writeFile(path.join(stage, prefixFile), prefix);
      descriptors.push({routeId: route.id, path: pathname, artifact: artifactFile, artifactHash: sha256(bytes), prefix: prefixFile, prefixHash, identity: sha256(artifact.flight), generatedAt: artifact.generatedAt, revalidate: artifact.revalidate ?? false});
      total += prefix.length;
    }
  }
  manifest.config.nativePprArtifacts = descriptors;
}
