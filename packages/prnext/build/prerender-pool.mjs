import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { prerenderResources } from './prerender-config.mjs';
import { createPrerenderCache } from './prerender-cache.mjs';
import { mapConcurrent } from './concurrent.mjs';

const storage = new AsyncLocalStorage();
const MIB = 1024 * 1024;

export async function withPrerenderSession(root, stage, manifest, config, callback, {signal}={}) {
  if (storage.getStore()) return callback();
  const session = new PrerenderPool(root, stage, manifest, config);
  const abort=()=>void session.abort(signal.reason instanceof Error?signal.reason:new Error('Prerender cancelled'));
  signal?.addEventListener('abort',abort,{once:true});
  try { signal?.throwIfAborted();const result=await storage.run(session,callback);signal?.throwIfAborted();return result; }
  finally { signal?.removeEventListener('abort',abort);await session.close(); }
}

export async function mapPrerender(items, run) {
  const values = Array.from(items), session = storage.getStore();
  if (!session) return mapConcurrent(values, run);
  await session.prepare(values.length);
  try { return await mapConcurrent(values, run, session.parallelism); }
  catch (error) { await session.abort(error); throw error; }
}

export function prerenderPath(kind, options, local) {
  const session = storage.getStore();
  return session?.enabled ? session.run(kind, options) : local(options);
}

export class PrerenderPool {
  constructor(root, stage, manifest, config, resources, dependencies = {}) {
    this.root = root; this.stage = stage; this.manifest = manifest;
    this.resources = prerenderResources(config, resources);
    this.children = []; this.enabled = false; this.parallelism = this.resources.workers;
    this.queue = []; this.revision = 0;
    this.sequence = 0; this.failure = undefined; this.closing = false;
    this.fork = dependencies.fork || fork;
    this.killGraceMs = dependencies.killGraceMs ?? 5000;
    this.updateTimeoutMs = dependencies.updateTimeoutMs ?? 30000;
  }
  async prepare(count) {
    if (this.failure) throw this.failure;
    if(this.preparing){await this.preparing;return;}
    // Starting a second Node/React runtime costs more than a tiny local render.
    if(this.enabled){await this.updateManifest();return;}
    if (this.parallelism < 2 || count < (this.resources.explicit ? 2 : 4)) return;
    this.preparing=(async()=>{
      this.parallelism = Math.min(this.parallelism, count);
      this.cache = await createPrerenderCache();
      try {
        if(this.failure)throw this.failure;
        await Promise.all(Array.from({ length: this.parallelism }, () => this.start()));
        this.enabled = true;
      } catch (error) { await this.abort(error); throw error; }
    })();
    try{await this.preparing;}finally{this.preparing=undefined;}
  }
  start() {
    return new Promise((resolve, reject) => {
      const child = this.fork(new URL('./prerender-process-worker.mjs', import.meta.url), [], {
        cwd: this.root, execArgv: [`--max-old-space-size=${this.resources.heapMb}`], serialization: 'advanced',
        env: { ...process.env, ...this.cache.env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
      });
      const worker = { child, rss: 0, busy: false, ready: false, updates: new Map() };
      this.children.push(worker);
      // A failed spawn emits error+close without exit. close is also the final
      // stdio/IPC terminal event for a successfully spawned process.
      worker.exited = new Promise(done => child.once('close', done));
      const timeout = setTimeout(() => void this.abort(new Error('Prerender worker startup exceeded 30 seconds')), 30_000);
      child.once('close',()=>clearTimeout(timeout));
      worker.startReject = reject;
      child.on('error', error => void this.abort(error));
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        if (!this.closing) void this.abort(new Error(`Prerender worker exited (${signal || code}); its path was not retried`));
      });
      child.on('message', message => {
        if (Number.isSafeInteger(message.rss)) worker.rss = message.rss;
        if (this.children.reduce((sum, value) => sum + value.rss, 0) > this.resources.maxMemoryMb * MIB) {
          void this.abort(new Error(`Prerender workers exceeded the ${this.resources.maxMemoryMb} MiB RSS budget`)); return;
        }
        if (message.type === 'ready') { clearTimeout(timeout); worker.ready = true; worker.startReject = undefined; resolve(); }
        else if(message.type==='updated'){const update=worker.updates.get(message.revision);worker.updates.delete(message.revision);clearTimeout(update?.timer);update?.resolve();}
        else if (message.type === 'failure') { void this.abort(Object.assign(new Error(message.error), { code: message.code })); }
        else if (message.type === 'result') {
          if (!worker.current || worker.current.id !== message.id) { void this.abort(new Error('Invalid prerender worker response')); return; }
          clearTimeout(worker.current.timer);
          const current = worker.current; worker.current = undefined; worker.busy = false; current.resolve(message.rendered);this.dispatch();
        }
      });
      child.send({ type: 'init', stage: this.stage, manifest: this.manifest }, error => { if (error) void this.abort(error); });
    });
  }
  run(kind, options) {
    if (this.failure) return Promise.reject(this.failure);
    if(this.closing||this.closed||!this.enabled)return Promise.reject(new Error('Prerender pool is not open'));
    if(this.queue.length>=32)return Promise.reject(new Error('Prerender scheduler exceeded its bounded waiting queue'));
    return new Promise((resolve, reject) => {
      this.queue.push({kind,options,resolve,reject});this.dispatch();
    });
  }
  dispatch(){
    if(this.failure||this.closing)return;
    for(const worker of this.children){
      if(!worker.ready||worker.busy||!this.queue.length)continue;
      const {kind,options,resolve,reject}=this.queue.shift();
      worker.busy=true;const id=++this.sequence;
      const timeoutMs = Math.min(300_000, (options.route?.cacheConfig?.maxDuration || 60) * 1000);
      const timer = setTimeout(() => void this.abort(new Error(`Prerender path ${options.path} exceeded ${timeoutMs} ms; it was not retried`)), timeoutMs);
      worker.current = { id, resolve, reject, timer };
      const { manifest, ...serialized } = options;
      worker.child.send({ type: 'job', id, kind, options: serialized }, error => { if (error) void this.abort(error); });
    }
  }
  async updateManifest(){
    const revision=++this.revision;
    await Promise.all(this.children.map(worker=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>void this.abort(new Error('Prerender manifest acknowledgement timed out')),this.updateTimeoutMs);
      worker.updates.set(revision,{resolve,reject,timer});
      worker.child.send({type:'update',revision,manifest:this.manifest},error=>{if(error)void this.abort(error);});
    })));
  }
  async abort(error) {
    this.failure ||= error;
    this.closing = true;
    for(const job of this.queue.splice(0))job.reject(this.failure);
    for (const worker of this.children) {
      worker.startReject?.(this.failure); worker.startReject = undefined;
      for(const update of worker.updates.values()){clearTimeout(update.timer);update.reject(this.failure);}worker.updates.clear();
      if (worker.current) { clearTimeout(worker.current.timer); worker.current.reject(this.failure); worker.current = undefined; }
    }
    await this.stopChildren(true);
  }
  stopChildren(force) {
    if(this.stopping)return this.stopping;
    this.stopping=(async()=>{
      for(const {child}of this.children){
        if(!child.pid||child.exitCode!==null||child.signalCode!==null)continue;
        if(force)child.kill('SIGTERM');
        else child.send({type:'close'},()=>{});
      }
      // User code may install a SIGTERM handler. Arm escalation before waiting
      // for any terminal event, including on the error/cancellation path.
      const killer=setTimeout(()=>{
        for(const {child}of this.children)if(child.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      },this.killGraceMs);
      try{await Promise.all(this.children.map(worker=>worker.exited));}
      finally{clearTimeout(killer);}
    })();
    return this.stopping;
  }
  async close() {
    if (this.closed) return this.closed;
    this.closed = (async () => {
      await this.preparing?.catch(()=>{});
      if(this.queue.length||this.children.some(worker=>worker.current))await this.abort(new Error('Prerender session closed with unfinished paths; they were not retried'));
      this.closing = true;
      try { await this.stopChildren(Boolean(this.failure)); }
      finally { await this.cache?.close(); }
    })();
    return this.closed;
  }
}
