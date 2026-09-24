// rustyx-transport:socket-v2
// rustyx-concurrency:512
import { requestFrames } from './request-transport.mjs';
import { requestWork } from './request-work.mjs';
import { AsyncResource } from 'node:async_hooks';
const workScope = new AsyncResource('RustyxWorkObserver', { triggerAsyncId: 0 });
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Console } from 'node:console';
import { navigationResponse } from './navigation.mjs';
import { createProtocolOutput } from './transport.mjs';
import { loadEnvConfig } from './env.mjs';

// stdout is exclusively the transport, including when user packages log during import.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const distDir = path.resolve(projectRoot, process.argv[3] || '.rustyx');
process.chdir(projectRoot);
let manifest;
try { manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8')); }
catch (error) { console.error('Rustyx worker could not read build manifest:', error.message); process.exit(1); }
process.env.NODE_ENV ??= manifest.dev ? 'development' : 'production';
loadEnvConfig(projectRoot, { dev: !!manifest.dev });
// NODE_ENV=test selects .env.test above. React itself must match the compiled
// browser graph and the RSC worker's mode, including dev launched from CI.
process.env.NODE_ENV = manifest.dev ? 'development' : 'production';
const production = !manifest.dev;
// Load each renderer beside the application only when that request needs it.
// Middleware and API workers do not pay for React or the Pages/App renderers.
const runtimeModule = name => import(pathToFileURL(path.join(distDir, `runtime/${name}.mjs`)).href);
let errorResponse;
try { ({ errorResponse } = await runtimeModule('http')); }
catch (error) { console.error('Rustyx worker could not load the project runtime:', error.message); process.exit(1); }
const routes = new Map(manifest.routes.map(route => [route.id, route]));
const prerendered = new Set((manifest.prerendered || []).map(item => item.path));
let appRuntime;
let appStaticRuntime;
let routeStaticRuntime;
let middlewareRuntime;
let pagesRuntime;
let apiRuntime;
let incrementalRuntime;

async function handleRequest(input, output, signalController) {
  let responseStarted = false;
  try {
    if (input.renderMode === 'incremental-cache' && input.routeId === '__rustyx_incremental_cache') {
      incrementalRuntime ??= await runtimeModule('incremental-cache');
      const result = await incrementalRuntime.runIncrementalCache({ ...input, manifest, distDir, production, signal: signalController.signal });
      input.body = undefined;
      responseStarted = true;
      await output(input.id, result, { ...input, production, signalController });
      return;
    }
    const isMiddleware = input.renderMode === 'middleware' && input.routeId === '__rustyx_middleware';
    const route = isMiddleware && manifest.middleware
      ? { ...manifest.middleware, id: '__rustyx_middleware', kind: 'middleware' }
      : routes.get(input.routeId);
    if (!route) { await output(input.id, { status: 404, body: 'Not Found' }, input); return; }
    const requestedPath = new URL(input.url).pathname;
    if (route.router !== 'app' && !['isr', 'error404', 'error500'].includes(input.renderMode) && route.fallback === false && !prerendered.has(requestedPath) && !prerendered.has(requestedPath.replace(/\/$/, '') || '/')) {
      await output(input.id, { status: 404, body: 'Not Found' }, input); return;
    }
    const options = { ...input, modulePath: path.resolve(distDir, route.module), route, production, manifest, distDir, signal: signalController.signal };
    let result;
    if (isMiddleware) {
      middlewareRuntime ??= await import(pathToFileURL(path.join(distDir, 'runtime/middleware.mjs')).href);
      result = await middlewareRuntime.runMiddleware(options);
    } else if (route.router === 'app' && route.kind === 'page') {
      if (input.renderMode === 'isr') {
        appStaticRuntime ??= await import(pathToFileURL(path.join(distDir, 'runtime/app-static.mjs')).href);
        result = await appStaticRuntime.renderAppIsrPage(options);
      } else {
        appRuntime ??= await import(pathToFileURL(path.join(distDir, 'runtime/app-render.mjs')).href);
        result = await appRuntime.renderAppPage(options);
      }
    } else if (route.router === 'app' && route.kind === 'api' && input.renderMode === 'isr') {
      routeStaticRuntime ??= await import(pathToFileURL(path.join(distDir, 'runtime/route-static.mjs')).href);
      result = await routeStaticRuntime.renderRouteHandlerIsr(options);
    } else if (route.kind === 'api') {
      apiRuntime ??= await runtimeModule('api');
      result = await apiRuntime.runApi(options);
    } else {
      pagesRuntime ??= await runtimeModule('render');
      result = input.renderMode === 'isr' ? await pagesRuntime.renderIsrPage({ ...options, capturePageFailure: true })
        : await pagesRuntime.renderPageRequest({ ...options, nativeErrors: true });
    }
    // Long responses should retain only the application's decoded request,
    // not the original JSON line and an extra base64 copy of its body.
    input.body = undefined;
    options.body = undefined;
    responseStarted = true;
    try { await output(input.id, result, { ...input, production, signalController }); }
    finally { await result.finalizeCache?.(); }
  } catch (error) {
    signalController.abort(error);
    if (responseStarted) {
      // A broken pipe or invalid transport cannot be repaired with a second
      // response on the same request. Rust replaces this failed worker.
      throw error;
    }
    await output(input?.id ?? null, navigationResponse(error) || errorResponse(error, production), { ...input, production, signalController });
  }
}

// Native lanes use separate sockets, so backpressure or cancellation on one
// response never blocks another response's bytes or aborts its request context.
const laneLimit = Math.min(512, Math.max(1, Number(process.env.RUSTYX_WORKER_SOCKET) || 1));
const token = process.env.RUSTYX_WORKER_TOKEN;
delete process.env.RUSTYX_WORKER_TOKEN;
delete process.env.RUSTYX_WORKER_SOCKET;
if (token && laneLimit > 1) {
  const expected = Buffer.from(token);
  const sockets = new Set();
  const invocations = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= laneLimit) { socket.destroy(); return; }
    sockets.add(socket); socket.setNoDelay(true);
    let controller;
    const authTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(authTimer); sockets.delete(socket); });
    // A handler may stop consuming the async iterator while awaiting npm code.
    // Observe EOF even in paused mode without draining or buffering more input.
    socket.on('readable', () => { if (socket.readableLength === 0) socket.read(0); });
    const disconnected = () => {
      const abandoned = controller;
      if (!abandoned || abandoned.signal.aborted) return;
      abandoned.abort(new Error('Request transport closed'));

    };
    socket.on('end', disconnected);
    socket.on('close', disconnected);
    const output = createProtocolOutput(socket.write.bind(socket), { cork: () => socket.cork(), uncork: () => socket.uncork() });
    void (async () => {
      try {
        for await (const input of requestFrames(socket, { authenticate(line) {
          const candidate = Buffer.from(line);
          if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error('Worker authentication failed');
          clearTimeout(authTimer); socket.write('ready\n');
        } })) {
          if (invocations.size >= laneLimit) throw new Error('Worker invocation capacity exceeded');
          controller = new AbortController();
          const active = controller;
          let pendingWork = 0, finished = false;
          invocations.add(active);
          active.signal[requestWork] = promise => {
            pendingWork++;
            const settled = () => { if (--pendingWork === 0 && finished) invocations.delete(active); };
            workScope.runInAsyncScope(() => Promise.resolve(promise).then(settled, settled));
          };
          const retireIfAbandoned = () => {
            const timer = setTimeout(() => { if (invocations.has(active)) process.exit(70); }, 5000);
            timer.unref();
          };
          active.signal.addEventListener('abort', retireIfAbandoned, { once: true });
          try { await handleRequest(input, output, active); }
          finally {
            finished = true;
            if (!pendingWork) invocations.delete(active);
            else if (!active.signal.aborted) {
              // Background code after sending a complete response still has a
              // finite lifetime, matching the native request deadline.
              const timer = setTimeout(() => { if (invocations.has(active)) process.exit(70); }, 30000);
              timer.unref();
            }
            controller = undefined;
          }
        }
      } catch (error) {
        if (!socket.destroyed) console.error('[rustyx] Request lane failed:', error?.message || error);
      } finally { socket.destroy(); }
    })();
  });
  // The stdin pipe is a parent-lifetime guard even though requests use sockets.
  process.stdin.resume();
  process.stdin.once('end', () => { for (const socket of sockets) socket.destroy(); server.close(); process.exit(0); });
  server.listen(0, '127.0.0.1', () => {
    writeProtocol(JSON.stringify({ port: server.address().port, binary: true, heartbeat: true }) + '\n');
    setInterval(() => writeProtocol('alive\n'), 1000).unref();
  });
} else {
  const output = createProtocolOutput(writeProtocol, { cork: () => process.stdout.cork(), uncork: () => process.stdout.uncork() });
  for await (let line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const input = JSON.parse(line); line = '';
    try { await handleRequest(input, output, new AbortController()); }
    catch (error) { console.error('[rustyx] Worker transport failed:', error?.stack || error); process.exit(1); }
  }
}
