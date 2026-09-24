import { decodeReply, decodeAction, decodeFormState, createTemporaryReferenceSet } from 'react-server-dom-webpack/server.node';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { navigationResponse } from './navigation.mjs';
import { appTimeoutError } from './app-errors.mjs';
import { flushCacheWork } from '../compat/data-cache.cjs';

export const MAX_ACTION_BYTES = 1024 * 1024;
const modules = new Map();
const loaders = new Map();
const manifests = new WeakMap();

function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

globalThis.__webpack_require__ = id => {
  if (!modules.has(id)) throw badRequest('Unknown Server Action module');
  return modules.get(id);
};
globalThis.__webpack_chunk_load__ = id => {
  if (!loaders.has(id)) return Promise.reject(badRequest('Unknown Server Action module'));
  return loaders.get(id)();
};

export function actionManifest(request) {
  const root = path.resolve(request.distDir);
  const actions = request.actions;
  const edge = request.cacheConfig?.runtime === 'edge';
  const cached = request.production && actions && manifests.get(actions);
  if (cached && cached.root === root && cached.edge === edge) return cached.value;
  const entries = Object.create(null);
  for (const [id, info] of Object.entries(request.actions || {})) {
    if (typeof info?.module !== 'string' || typeof info?.export !== 'string') throw new Error('Invalid Server Action manifest');
    const selected = request.cacheConfig?.runtime === 'edge' && info.edgeModule !== undefined ? info.edgeModule : info.module;
    if (typeof selected !== 'string') throw new Error('Invalid Server Action runtime module');
    const filename = path.resolve(root, selected);
    if (!filename.startsWith(root + path.sep)) throw new Error('Server Action module is outside the build directory');
    const url = pathToFileURL(filename).href;
    if (!loaders.has(url)) loaders.set(url, async () => {
      if (!modules.has(url)) modules.set(url, await import(url));
    });
    entries[id] = { id: url, chunks: [url, url], name: info.export };
  }
  // React's webpack decoder permits an "id#export" fallback. Reject unknown
  // IDs on the first lookup, including inherited names and fabricated exports.
  const value = new Proxy(entries, { get(target, id) {
    if (typeof id !== 'string' || !Object.hasOwn(target, id)) throw badRequest('Unknown Server Action reference');
    return target[id];
  } });
  if (request.production && actions) manifests.set(actions, { root, edge, value });
  return value;
}

export function registerCacheClientModule(id, namespace) { modules.set(id, namespace); }

export async function loadActionReference(id, bound = null) {
  const manifest = actionManifest(currentRequest());
  const reference = manifest[id];
  await loaders.get(reference.id)();
  const namespace = modules.get(reference.id);
  if (!Object.hasOwn(namespace, reference.name) || typeof namespace[reference.name] !== 'function') throw badRequest('Invalid Server Action export');
  const fn = namespace[reference.name];
  if (bound === null) return fn;
  const values = await bound;
  if (!Array.isArray(values) || values.length > 1000) throw badRequest('Invalid Server Action bound arguments');
  return fn.bind(null, ...values);
}

function errorPayload(error, production) {
  const digest = createHash('sha256').update(String(error?.stack || error?.message || error)).digest('hex').slice(0, 16);
  return { message: production ? 'An error occurred while executing this action. See the server logs for details.' : error?.message || String(error), digest };
}

async function actionBody(action, limit = MAX_ACTION_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw badRequest('Invalid Server Action body limit');
  if ((action.body || '').length > Math.ceil(limit / 3) * 4) throw badRequest(`Server Action body exceeds the ${limit} byte limit`);
  const bytes = Buffer.from(action.body || '', 'base64');
  if (bytes.byteLength > limit) throw badRequest(`Server Action body exceeds the ${limit} byte limit`);
  const contentType = action.contentType || 'text/plain';
  if (/^(multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(contentType)) {
    try { return await new Response(bytes, { headers: { 'content-type': contentType } }).formData(); }
    catch { throw badRequest('Malformed Server Action form data'); }
  }
  if (action.id && /^(text\/plain|application\/json)(?:;|$)/i.test(contentType)) return bytes.toString('utf8');
  throw badRequest('Unsupported Server Action content type');
}

export async function invokeAction(request) {
  const manifest = actionManifest(request);
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await actionBody(request.action, request.serverActions?.bodySizeLimit);
  return runRequestContext({ ...request, phase: 'action', mutableCookies: true }, async () => {
    const context = currentRequest();
    let operation;
    try {
      if (request.action.id) {
        const reference = manifest[request.action.id];
        const args = await decodeReply(body, manifest, { temporaryReferences, arraySizeLimit: 10_000 });
        if (!Array.isArray(args) || args.length > 1000) throw badRequest('Invalid Server Action arguments');
        await loaders.get(reference.id)();
        const namespace = modules.get(reference.id);
        if (!Object.hasOwn(namespace, reference.name) || typeof namespace[reference.name] !== 'function') throw badRequest('Invalid Server Action export');
        operation = () => namespace[reference.name](...args);
      } else {
        operation = await decodeAction(body, manifest);
        if (typeof operation !== 'function') throw badRequest('No Server Action was selected by the form');
      }
    } catch (error) {
      if (error?.statusCode === 504) throw error;
      if (error?.statusCode === 400) throw error;
      throw badRequest('Invalid Server Action payload');
    }

    let actionResult;
    let actionError;
    let actionRedirect;
    let actionNotFound;
    let failure;
    try { actionResult = await operation(); }
    catch (error) {
      const navigation = navigationResponse(error);
      if (navigation?.headers?.location) {
        const type = error.digest.split(';')[1];
        actionRedirect = { url: navigation.headers.location, type: type === 'push' ? 'push' : 'replace' };
      } else if (navigation?.status === 404) {
        actionNotFound = true;
      } else {
        console.error('[rustyx]', error?.stack || error);
        actionError = errorPayload(error, request.production);
        failure = { message: error?.message || String(error), stack: error?.stack, digest: error?.digest };
      }
    }
    // An invalidation must finish before the updated component tree is read,
    // including actions that redirect or report an application error.
    await flushCacheWork(context);
    const headers = new Headers(request.headers || {});
    headers.set('cookie', context.cookies.toString());
    let formState = null;
    if (!request.action.id && !failure && !actionRedirect && !actionNotFound) formState = await decodeFormState(actionResult, body, manifest);
    return { actionResult, actionError, actionRedirect, actionNotFound, failure, formState, temporaryReferences,
      headers: Object.fromEntries(headers), setCookies: [...context.outgoingCookies.values()], native: !request.action.id };
  });
}

export async function runAction(request) {
  const timeoutMs = request.renderTimeoutMs ?? 25_000;
  let timeout;
  try {
    return await Promise.race([
      invokeAction(request),
      new Promise((_, reject) => { timeout = setTimeout(() => {
        const error = appTimeoutError('Server Action', timeoutMs);
        // An async mutation cannot be cancelled safely; retire the isolate so
        // its pending work never overlaps a subsequent request.
        error.retireWorker = true;
        reject(error);
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timeout); }
}
