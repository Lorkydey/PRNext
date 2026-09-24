import React from 'react';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import path from 'node:path';
import { AppRouterProvider } from '../compat/app-context.cjs';
import { appContent } from './app-content.mjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { cachedValue, cacheGeneration, flushCacheWork } from '../compat/data-cache.cjs';
import { partialModel, preparePartialModel } from './app-partial-model.mjs';
import { MAX_RESPONSE_BYTES, escapeHtml } from './http.mjs';
import { fontPreloads } from './font-preload.mjs';
import { PartialArtifactCache } from './partial-artifact-cache.mjs';

const artifacts = new Map();
const parsedArtifacts = new PartialArtifactCache();
let artifactBytes = 0;
async function readArtifact(file) {
  const hit = artifacts.get(file);
  if (hit) { artifacts.delete(file); artifacts.set(file, hit); return hit.value; }
  if ((await stat(file)).size > MAX_RESPONSE_BYTES * 2) throw new Error('Partial prerender artifact exceeds 32 MiB');
  const source = await readFile(file, 'utf8');
  const value = JSON.parse(source);
  if (value.version !== 1 || typeof value.shell !== 'string' || typeof value.flight !== 'string' || !value.postponed) throw new Error('Invalid partial prerender artifact');
  const size = Buffer.byteLength(source);
  if (size <= 1024 * 1024) {
    while (artifacts.size && (artifacts.size >= 32 || artifactBytes + size > 8 * 1024 * 1024)) {
      const [key, old] = artifacts.entries().next().value;
      artifacts.delete(key); artifactBytes -= old.size;
    }
    artifacts.set(file, { value, size }); artifactBytes += size;
  }
  return value;
}

async function bytes(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) throw new Error('Partial prerender exceeds the 16 MiB response limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

export async function prerenderPartialHtml(model, route, { strictMode = true, unknownParams = false, navigation = false, timeoutMs = 25_000 } = {}) {
  const { prerender } = await import('react-dom/static');
  const abort = new AbortController();
  setMaxListeners(0, abort.signal);
  const postponedError = new Error('Rustyx request-dependent Suspense content');
  const timer = setTimeout(() => abort.abort(new Error('Partial prerender timed out')), timeoutMs);
  let scheduled = false, failure, clientDynamic = false;
  const suspended = new Promise(() => {});
  function onHole() {
    if (!scheduled) {
      scheduled = true;
      // Let all ready static siblings and fallbacks commit before recording the
      // opaque React continuation. No request work runs during this phase.
      setImmediate(() => setImmediate(() => abort.abort(postponedError)));
    }
  }
  try {
    await preparePartialModel(model, { signal: abort.signal });
    const tree = partialModel(model, { onHole, suspended });
    const rendered = await prerender(React.createElement(strictMode ? React.StrictMode : React.Fragment, null,
      React.createElement(AppRouterProvider, { router: tree.router, ...(!navigation ? { prerenderSearch() { clientDynamic = true; onHole(); throw suspended; } } : {}),
        ...(unknownParams ? { prerenderParams() { clientDynamic = true; onHole(); throw suspended; } } : {}) }, appContent(tree.tree))), {
      signal: abort.signal,
      onError(error) { if (error !== postponedError) failure ||= error; },
    });
    if (failure) throw failure;
    let shell = (await bytes(rendered.prelude)).toString();
    if (!/<html(?:\s|>)/i.test(shell) || !/<body(?:\s|>)/i.test(shell) || !/<\/head>/i.test(shell)) {
      return null;
    }
    const styles = fontPreloads(route.fonts) + (route.css || []).map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('');
    if (styles) shell = shell.replace(/<\/head>/i, `${styles}</head>`);
    return { shell, postponed: rendered.postponed, clientDynamic };
  } catch (error) {
    // Request data above every Suspense boundary has no reusable document shell.
    if (error === postponedError) return null;
    throw error;
  } finally { clearTimeout(timer); }
}

export async function partialArtifact({ request, route, manifest, filename, identity, regenerate, signal }) {
  const root = path.resolve(request.distDir);
  let build;
  if (filename) {
    const file = path.resolve(root, filename);
    if (!file.startsWith(root + path.sep) || !filename.startsWith('static/')) throw new Error('Invalid partial prerender artifact path');
    build = await readArtifact(file);
  }
  const external = build?.externalCache || Object.keys(manifest.config?.cacheHandlers || {}).length > 0;
  // Rust resolves the generation and reads/acquires the lease atomically.
  const key = createHash('sha256').update(`partial:${manifest.cacheId}:${route.id}:${identity || filename}`).digest('hex');
  return runRequestContext({ ...request, signal }, async () => {
    const context = currentRequest();
    let metadata = build || { revalidate: route.cacheConfig?.revalidate ?? false, tags: [], paths: [] };
    const producer = async ({ generation } = {}) => {
      const lifetime = build?.revalidate === false || build?.revalidate == null ? Infinity : build.revalidate * 1000;
      // Check after the native lease was acquired. An invalidation between the
      // versioned read and producing the shell must not reseed old bytes.
      if (build && !external && generation === 0 && Date.now() - build.generatedAt < lifetime && await cacheGeneration(signal) === 0) return Buffer.from(JSON.stringify(build));
      const next = await regenerate(build);
      if (next.dynamic) return Buffer.from(JSON.stringify({ dynamic: true }));
      metadata = next.partial ? { ...next.partial, ...next.metadata }
        : { version: 1, complete: true, shell: next.body, flight: next.flight.toString('base64'),
          status: next.status, headers: next.headers, generatedAt: next.generatedAt,
          revalidate: next.revalidate, tags: next.tags, paths: next.paths };
      return Buffer.from(JSON.stringify(metadata));
    };
    try {
      if (external || metadata.revalidate === 0) return JSON.parse((await producer()).toString());
      const value = await cachedValue(key, producer, { context, signal, tags: metadata.tags, paths: metadata.paths,
        revalidate: metadata.revalidate, resolveMetadata: () => ({ tags: metadata.tags, paths: metadata.paths,
          revalidate: metadata.revalidate, expire: metadata.revalidate === false ? undefined : metadata.revalidate }), forceFresh: true, versioned: true });
      return parsedArtifacts.parse(key, Buffer.isBuffer(value) ? value : Buffer.from(value));
    } finally { await flushCacheWork(context); }
  });
}

export function partialShell(artifact, route) {
  const bootstrap = '<script>self.__RUSTYX_FLIGHT_STREAM__=self.__RUSTYX_FLIGHT_STREAM__||[];</script>' +
    (route.client ? `<script type="module" async src="${escapeHtml(route.client)}"></script>` : '');
  const end = artifact.shell.lastIndexOf('</body>');
  if (end < 0 || !/<\/body><\/html>$/i.test(artifact.shell)) throw new Error('Invalid partial prerender document');
  return artifact.shell.slice(0, end) + bootstrap + artifact.shell.slice(end);
}
