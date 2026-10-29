import {drainTraces} from './trace.mjs';
import {advancedRoutingSources} from './app-routing-state.mjs';
import {initializeInstrumentation,withInstrumentation} from './instrumentation.mjs';
import {deferredCompiler} from './dev-compiler-broker.mjs';
// prnext-transport:socket-v2
// prnext-concurrency:512
import { requestFrames } from './request-transport.mjs';
import {scheduleCompileCacheFlush} from './compile-cache.mjs';
import {preloadModules} from './preload.mjs';
import { requestWork } from './request-work.mjs';
import { freezeClientModules } from './worker-metadata.mjs';
import { AsyncResource } from 'node:async_hooks';
const workScope = new AsyncResource('PRNextWorkObserver', { triggerAsyncId: 0 });
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Console } from 'node:console';
import { navigationResponse } from './navigation.mjs';
import { createProtocolOutput, ProtocolWriteError } from './transport.mjs';
import { loadEnvConfig } from './env.mjs';
import diagnostics from '../compat/diagnostics.cjs';

if (diagnostics.enabled) diagnostics.record('wake', { phase: 'node-entry', uptimeMs: process.uptime() * 1000, bootstrapMs: performance.nodeTiming.bootstrapComplete });

// stdout is exclusively the transport, including when user packages log during import.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const distDir = path.resolve(projectRoot, process.argv[3] || '.prnext');
process.chdir(projectRoot);
let manifest;
try { manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8')); }
catch (error) { console.error('PRNext worker could not read build manifest:', error.message); process.exit(1); }
process.env.NODE_ENV ??= manifest.dev ? 'development' : 'production';
loadEnvConfig(projectRoot, { dev: !!manifest.dev });
// NODE_ENV=test selects .env.test above. React itself must match the compiled
// browser graph and the RSC worker's mode, including dev launched from CI.
process.env.NODE_ENV = manifest.dev ? 'development' : 'production';
const production = !manifest.dev;
const compilerDescriptor=process.env.PRNEXT_DEV_COMPILER;
delete process.env.PRNEXT_DEV_COMPILER;
process.env.NEXT_RUNTIME='nodejs';
await initializeInstrumentation(distDir,manifest);
let dispatchRequest=handleRequest;
if(!production){
  const {createDevWorkerConsole}=await import('./dev-worker-logs.mjs'),logs=createDevWorkerConsole();globalThis.console=logs.console;
  dispatchRequest=(input,...args)=>logs.run({requestId:input.id,route:routes.get(input.routeId)?.pattern},()=>handleRequest(input,...args));
  const {publishDevCacheCapability}=await import('./dev-cache-control.mjs');
  await publishDevCacheCapability({root:projectRoot,distDir,manifest}).catch(()=>{console.warn('[prnext] Local cache controls are unavailable for this development generation.');});
}
if (production) freezeClientModules(manifest.app?.clientModules);
// Load each renderer beside the application only when that request needs it.
// Middleware and API workers do not pay for React or the Pages/App renderers.
const runtimeModule = async (name,directory=distDir) => {
  const started = diagnostics.enabled ? performance.now() : 0;
  const module = await import(pathToFileURL(path.join(directory, `runtime/${name}.mjs`)).href);
  scheduleCompileCacheFlush();
  if (diagnostics.enabled) diagnostics.record('wake', { phase: 'module', module: name, durationMs: performance.now() - started });
  return module;
};
let errorResponse;
try { ({ errorResponse } = await runtimeModule('http')); }
catch (error) { console.error('PRNext worker could not load the project runtime:', error.message); process.exit(1); }
const routes = new Map(manifest.routes.map(route => [route.id, route]));
const prerendered = new Set((manifest.prerendered || []).map(item => item.path));
const deployment={distDir,manifest,routes,prerendered,modules:new Map()};
const deployments=new Map([[distDir,deployment]]);
const compileDeferred=!production&&compilerDescriptor?deferredCompiler(compilerDescriptor,{root:projectRoot,home:path.dirname(distDir)}):undefined;
async function deferredDeployment(route,signal,sources=[]){
  if(!compileDeferred)throw Error('Deferred development compiler is unavailable');
  const next=await compileDeferred(route.pattern,signal,sources);
  let value=deployments.get(next.distDir);
  if(!value){value={...next,routes:new Map(next.manifest.routes.map(route=>[route.id,route])),prerendered:new Set(),modules:new Map()};deployments.set(next.distDir,value);while(deployments.size>4)deployments.delete(deployments.keys().next().value);}
  const resolved=value.routes.get(route.id);
  if(!resolved||resolved.devDeferred)throw Error('Compiler did not materialize the selected route');
  return value;
}

async function drainRuntime(){
  for(const value of deployments.values())if(value.modules.has('app-render')||value.modules.has('app-static')){
    const runtime=await(value.modules.get('app-render')||import(pathToFileURL(path.join(value.distDir,'runtime/app-render.mjs')).href));
    await runtime.drainAppRuntime();
  }
  await drainTraces();
}

async function handleRequest(input, output, signalController, responseComplete, selected=deployment) {
  const {manifest,distDir,routes,prerendered}=selected;
  const renderer=async name=>{
    if(selected.modules.has(name))return selected.modules.get(name);
    // Imports share one pending job, then retain only the namespace. Starting
    // outside the visitor's ALS scope prevents the module cache retaining it.
    const pending=workScope.runInAsyncScope(()=>runtimeModule(name,distDir));
    selected.modules.set(name,pending);
    try{const module=await pending;selected.modules.set(name,module);return module;}
    catch(error){if(selected.modules.get(name)===pending)selected.modules.delete(name);throw error;}
  };
  let responseStarted = false;
  const finalizers = new Set();
  try {
    if(input.routeId==='__prnext_preload'&&['preload','prewarm'].includes(input.renderMode)){
      const frameworkOnly=input.renderMode==='prewarm';
      const options=manifest.config?.workerPreload||(frameworkOnly?{routes:[],maxRssMb:256,timeoutMs:15000}:undefined);
      if(!production||!options){await output(input.id,{status:204,body:''},input);return;}
      if(frameworkOnly){
        if(manifest.routes.some(route=>route.router==='app'&&route.kind==='page'))await(await renderer('app-render')).prewarmAppRenderer(options);
        if(manifest.routes.some(route=>route.kind==='page'&&route.router!=='app'))await renderer('render');
        if(manifest.routes.some(route=>route.kind==='api'))await renderer('api');
        scheduleCompileCacheFlush();await output(input.id,{status:204,body:''},input);return;
      }
      const selected=options.routes.map(pattern=>manifest.routes.find(route=>route.pattern===pattern&&!route.internal)).filter(Boolean);
      const deadline=performance.now()+options.timeoutMs;
      for(const route of selected){
        if(performance.now()>=deadline||process.memoryUsage().rss>=options.maxRssMb*1024*1024)break;
        const remaining={...options,timeoutMs:Math.max(1,deadline-performance.now())};
        if(route.router==='app'&&route.kind==='page'){
          const appRuntime=await renderer('app-render');
          await appRuntime.preloadAppRoutes([path.resolve(distDir,route.module)],remaining);
        }else{
          if(route.kind==='page')await renderer('render');else await renderer('api');
          await preloadModules([path.resolve(distDir,route.module)],remaining);
        }
        if(process.memoryUsage().rss>=options.maxRssMb*1024*1024)break;
      }
      scheduleCompileCacheFlush();await output(input.id,{status:204,body:''},input);return;
    }
    if (input.renderMode === 'incremental-cache' && input.routeId === '__prnext_incremental_cache') {
      const incrementalRuntime = await renderer('incremental-cache');
      const result = await incrementalRuntime.runIncrementalCache({ ...input, manifest, distDir, production, signal: signalController.signal });
      input.body = undefined;
      responseStarted = true;
      await output(input.id, result, { ...input, production, signalController });
      return;
    }
    const isMiddleware = input.renderMode === 'middleware' && input.routeId === '__prnext_middleware';
    const route = isMiddleware && manifest.middleware
      ? { ...manifest.middleware, id: '__prnext_middleware', kind: 'middleware' }
      : routes.get(input.routeId);
    if (!route) { await output(input.id, { status: 404, body: 'Not Found' }, input); return; }
    const sourceModules=!production&&route.router==='app'&&route.kind==='page'?advancedRoutingSources({...input,basePath:manifest.config?.basePath||''},manifest.routes):[];
    const deferredSources=sourceModules.length?manifest.routes.filter(candidate=>candidate.devDeferred&&sourceModules.includes(candidate.module)).map(candidate=>candidate.pattern):[];
    if(route.devDeferred||deferredSources.length){
      const next=await deferredDeployment(route,signalController.signal,deferredSources);
      return await handleRequest(input,output,signalController,responseComplete,next);
    }
    const requestedPath = new URL(input.url).pathname;
    if (route.router !== 'app' && !['isr', 'error404', 'error500'].includes(input.renderMode) && route.fallback === false && !prerendered.has(requestedPath) && !prerendered.has(requestedPath.replace(/\/$/, '') || '/')) {
      await output(input.id, { status: 404, body: 'Not Found' }, input); return;
    }
    const options = { ...input, modulePath: path.resolve(distDir, route.module), route, production, manifest, distDir, signal: signalController.signal, deferFinalizer: finalize => finalizers.add(finalize) };
    return await withInstrumentation(options,async()=>{
    let result;
    if (isMiddleware) {
      const middlewareRuntime = await renderer('middleware');
      result = await middlewareRuntime.runMiddleware(options);
    } else if (route.router === 'app' && route.kind === 'page') {
      if (input.renderMode === 'isr') {
        const appStaticRuntime = await renderer('app-static');
        result = await appStaticRuntime.renderAppIsrPage(options);
      } else {
        const appRuntime = await renderer('app-render');
        result = await appRuntime.renderAppPage(options);
      }
    } else if (route.router === 'app' && route.kind === 'api' && input.renderMode === 'isr') {
      const routeStaticRuntime = await renderer('route-static');
      result = await routeStaticRuntime.renderRouteHandlerIsr(options);
    } else if (route.kind === 'api') {
      const apiRuntime = await renderer('api');
      result = await apiRuntime.runApi(options);
    } else {
      const pagesRuntime = await renderer('render');
      result = input.renderMode === 'isr' ? await pagesRuntime.renderIsrPage({ ...options, capturePageFailure: true })
        : await pagesRuntime.renderPageRequest({ ...options, nativeErrors: true });
    }
    // Long responses should retain only the application's decoded request,
    // not the original JSON line and an extra base64 copy of its body.
    input.body = undefined;
    options.body = undefined;
    responseStarted = true;
    if (result.finalizeCache) finalizers.add(result.finalizeCache);
    await output(input.id, result, { ...input, production, signalController });
    responseComplete?.();
    });
  } catch (error) {
    const cancelled = signalController.signal.aborted || error instanceof ProtocolWriteError;
    signalController.abort(error);
    if (responseStarted || cancelled) {
      // A broken pipe or invalid transport cannot be repaired with a second
      // response on the same request. Rust discards the incomplete lane.
      throw error;
    }
    // The application's scope was aborted above, but the lane is still valid
    // for its one error/redirect response. Do not mistake that cleanup signal
    // for a client disconnect while writing the replacement headers.
    await output(input?.id ?? null, navigationResponse(error) || errorResponse(error, production), { ...input, production });
    responseComplete?.();
  } finally {
    if (finalizers.size) {
      const pending = (async () => {
        for (const finalize of finalizers) {
          try { await finalize(); }
          catch (error) { console.error('[prnext] Post-response work failed:', error?.stack || error); }
        }
      })();
      // Release this socket's response lane while retaining worker activity.
      // Otherwise an immediate follow-up request waits behind after() work.
      const track = signalController.signal[requestWork];
      if (track) track(pending);
      else await pending;
    }
  }
}

// Native lanes use separate sockets, so backpressure or cancellation on one
// response never blocks another response's bytes or aborts its request context.
const laneLimit = Math.min(512, Math.max(1, Number(process.env.PRNEXT_WORKER_SOCKET) || 1));
const token = process.env.PRNEXT_WORKER_TOKEN;
const reportActivity = process.env.PRNEXT_WORKER_ACTIVITY === '1';
delete process.env.PRNEXT_WORKER_TOKEN;
delete process.env.PRNEXT_WORKER_SOCKET;
delete process.env.PRNEXT_WORKER_ACTIVITY;
if (token && laneLimit > 1) {
  const expected = Buffer.from(token);
  const sockets = new Set();
  const invocations = new Set();
  let shuttingDown = false;
  let reportedBusy = false;
  const announceActivity = () => {
    if (!reportActivity || !invocations.size || reportedBusy || shuttingDown) return;
    reportedBusy = true;
    writeProtocol('busy\n');
  };
  let exiting=false;
  const exitWhenDrained = () => { if (shuttingDown && !invocations.size&&!exiting){exiting=true;void drainRuntime().catch(error=>console.error('[prnext] Runtime drain failed:',error?.message)).finally(()=>process.exit(0));} };
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
          let pendingWork = 0, unsupervisedWork = 0, finished = false, backgroundDeadline = 0;
          invocations.add(active);
          announceActivity();
          active.signal[requestWork] = (promise, options) => {
            pendingWork++;
            // RSC owns both its foreground deadline and its post-response
            // responsiveness watchdog. Do not apply legacy orphan timeouts to
            // legitimate cache work merely because its HTTP body has ended.
            const supervised = options?.supervised === true;
            if (!supervised) unsupervisedWork++;
            if (!supervised && Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 300000) {
              backgroundDeadline = Math.max(backgroundDeadline, performance.now() + options.timeoutMs);
              if (active.signal.aborted) { clearTimeout(workTimer); retireIfAbandoned(); }
            }
            const settled = () => {
              pendingWork--;
              if (!supervised) unsupervisedWork--;
              if (pendingWork && !unsupervisedWork) clearTimeout(workTimer);
              if (!pendingWork && finished) {
                clearTimeout(workTimer);
                invocations.delete(active); exitWhenDrained();
              }
            };
            workScope.runInAsyncScope(() => Promise.resolve(promise).then(settled, settled));
          };
          let workTimer;
          const retireIfAbandoned = () => {
            if (pendingWork && !unsupervisedWork) return;
            workTimer = setTimeout(() => {
              if (invocations.has(active) && (!pendingWork || unsupervisedWork)) process.exit(70);
            }, Math.max(5000, backgroundDeadline - performance.now()));
            workTimer.unref();
          };
          active.signal.addEventListener('abort', retireIfAbandoned, { once: true });
          try { await dispatchRequest(input, output, active, () => { controller = undefined; }); }
          finally {
            finished = true;
            if (!pendingWork) { invocations.delete(active); clearTimeout(workTimer); }
            else {
              if (unsupervisedWork && !active.signal.aborted) {
                workTimer = setTimeout(() => { if (invocations.has(active) && unsupervisedWork) process.exit(70); }, Math.max(30000, backgroundDeadline - performance.now()));
                workTimer.unref();
              }
            }
            controller = undefined;
            exitWhenDrained();
          }
        }
      } catch (error) {
        if (!socket.destroyed && !socket.readableEnded && !(error instanceof ProtocolWriteError)) console.error('[prnext] Request lane failed:', error?.message || error);
      } finally { socket.destroy(); }
    })();
  });
  // The stdin pipe is a parent-lifetime guard even though requests use sockets.
  let heartbeat;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const socket of sockets) socket.destroy();
    server.close();
    exitWhenDrained();
  };
  process.stdin.resume();
  process.stdin.once('end', shutdown);
  // The native pool can close its control reader before Node observes stdin
  // EOF. Treat that broken parent pipe as the same graceful shutdown; ordinary
  // stdout failures remain fatal instead of silently losing protocol errors.
  process.stdout.on('error', error => {
    if (error.code === 'EPIPE') shutdown();
    else throw error;
  });
  server.listen(0, '127.0.0.1', () => {
    if(!production&&typeof globalThis.__PRNEXT_DEV_WORKER_READY__==='function'){
      globalThis.__PRNEXT_DEV_WORKER_READY__({port:server.address().port,binary:true,gracefulShutdown:true});
      delete globalThis.__PRNEXT_DEV_WORKER_READY__;
    }
    writeProtocol(JSON.stringify({ port: server.address().port, binary: true, heartbeat: true, activity: reportActivity, gracefulShutdown: true }) + '\n');
    heartbeat = setInterval(() => {
      // Coalesce the idle transition with the existing heartbeat. Normal
      // request completion adds no stdout messages, and short cache bursts
      // cannot add two messages for every response.
      reportedBusy = reportActivity && invocations.size > 0;
      writeProtocol(reportedBusy ? 'busy\n' : 'alive\n');
      if(!production)globalThis.__PRNEXT_DEV_WORKER_PULSE__?.(reportedBusy?'busy\n':'alive\n');
    }, 1000).unref();
  });
} else {
  const output = createProtocolOutput(writeProtocol, { cork: () => process.stdout.cork(), uncork: () => process.stdout.uncork() });
  for await (let line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const input = JSON.parse(line); line = '';
    try { await dispatchRequest(input, output, new AbortController()); }
    catch (error) { console.error('[prnext] Worker transport failed:', error?.stack || error); process.exit(1); }
  }
  // The maintenance/ISR transport is serial and awaits its own finalizers.
  // RSC settlement can still outlive its terminal frame; drain it explicitly
  // before closing the isolate's MessagePorts after parent EOF.
  await drainRuntime();
}
