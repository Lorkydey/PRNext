import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {escapeHtml} from './http.mjs';

export const NATIVE_PPR_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const NATIVE_PPR_PREFIX_BYTES = 128 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function partialShell(artifact, route) {
  const bootstrap = '<script>self.__PRNEXT_FLIGHT_STREAM__=self.__PRNEXT_FLIGHT_STREAM__||[];</script>' +
    (route.client ? `<script type="module" async src="${escapeHtml(route.client)}"></script>` : '');
  const end = artifact.shell.lastIndexOf('</body>');
  if (end < 0 || !/<\/body><\/html>$/i.test(artifact.shell)) throw new Error('Invalid partial prerender document');
  return artifact.shell.slice(0, end) + bootstrap + artifact.shell.slice(end);
}

// This is a private transport field, never an HTTP header. Rust has already
// checked cache generation and committed these exact build bytes. Pinning the
// same artifact gives the request one snapshot even if invalidation races Node.
export async function nativePprArtifact({renderMode, manifest, route, url, distDir}) {
  if (!renderMode?.startsWith('native-ppr:')) return null;
  if (!manifest.config?.nativePprShell || manifest.dev || !/^[a-f\d]{64}$/.test(renderMode.slice(11))) throw new Error('Invalid native PPR continuation');
  const pathname = new URL(url).pathname;
  const descriptor = manifest.config.nativePprArtifacts?.find(item => item.routeId === route.id && item.path === pathname && item.artifactHash === renderMode.slice(11));
  if (!descriptor || new URL(url).search || descriptor.artifact !== route.ppr?.[pathname]) throw new Error('Native PPR artifact does not match the route');
  const filename = path.resolve(distDir, descriptor.artifact);
  if (!descriptor.artifact.startsWith('static/') || !filename.startsWith(path.resolve(distDir) + path.sep) || (await stat(filename)).size > NATIVE_PPR_ARTIFACT_BYTES) throw new Error('Invalid native PPR artifact path or size');
  const bytes = await readFile(filename);
  if (bytes.length > NATIVE_PPR_ARTIFACT_BYTES || sha256(bytes) !== descriptor.artifactHash) throw new Error('Native PPR artifact changed after publication');
  const artifact = JSON.parse(bytes);
  const prefix = Buffer.from(partialShell(artifact, route).replace(/<\/body><\/html>$/i, ''));
  if (artifact.version !== 1 || !artifact.postponed || artifact.complete || artifact.generic || sha256(prefix) !== descriptor.prefixHash || sha256(artifact.flight) !== descriptor.identity) throw new Error('Invalid native PPR snapshot');
  return {artifact, descriptor};
}
