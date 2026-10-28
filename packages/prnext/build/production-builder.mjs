import {fork} from 'node:child_process';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {watchProject} from '../runtime/watch-project.mjs';
import {createDevChangeFilter} from '../runtime/dev-file-changes.mjs';
import {incrementalCompilerStats} from './incremental.mjs';
import {withPrerenderSession} from './prerender-pool.mjs';
import {prerenderPages} from './prerender-pages.mjs';
import {prerenderApp} from './app-static.mjs';

/** Explicit reusable build session for integrations; always dispose it. */
export async function createBuilder(projectRoot,options={}){
  const root=await realpath(projectRoot);let disposed=false,pending=Promise.resolve();
  return {
    build(overrides={}){
      if(disposed)return Promise.reject(new Error('Builder has been disposed'));
      const task=pending.then(async()=>{const {build}=await import('./index.mjs');return build(root,{...options,...overrides,dev:false,incremental:true});});
      pending=task.catch(()=>{});return task;
    },
    stats:incrementalCompilerStats,
    async dispose(){disposed=true;await pending;const {disposeBuildSession}=await import('./index.mjs');await disposeBuildSession(root);},
  };
}

// Application imports, SSG and RSC isolates belong to one build only. Keeping
// esbuild's graph must not retain application globals or execute stale modules.
export async function prerenderProduction(root,stage,manifest,{prerender,signal}={}){
  await withPrerenderSession(root,stage,manifest,prerender,async()=>{
    await prerenderPages(stage,manifest,false);
    await prerenderApp(stage,manifest,false);
  },{signal});
  return manifest;
}

export function isolatedPrerender(root, stage, manifest, options = {}, dependencies = {}) {
  const spawn = dependencies.fork || fork;
  const { timeoutMs = 600000, abortGraceMs = 30000, killGraceMs = 5000 } = dependencies;
  return new Promise((resolve, reject) => {
    const child = spawn(new URL('./prerender-worker.mjs', import.meta.url), [], {
      cwd: root, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    });
    let result, failure, terminateTimer, killTimer, closed = false, terminating = false;
    const running = () => !closed && child.pid && child.exitCode === null && child.signalCode === null;
    const terminate = () => {
      if (!running() || terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      // SIGTERM is an application-observable signal on POSIX. Never wait on
      // its handler before arming the unconditional final termination.
      killTimer ||= setTimeout(() => { if (running()) child.kill('SIGKILL'); }, killGraceMs);
    };
    const fail = error => {
      failure ||= error;
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      terminate();
    };
    const send = message => {
      if (!child.connected) { fail(new Error('Prerender coordinator IPC disconnected')); return; }
      try { child.send(message, error => { if (error && !closed) fail(error); }); }
      catch (error) { fail(error); }
    };
    const timeout = setTimeout(() => {
      failure ||= new Error('Production prerender exceeded ten minutes');
      // Cooperative cancellation drains the coordinator's owned path workers.
      // A blocked application generator may never process this IPC message.
      send({ type: 'abort' });
      if (!closed) terminateTimer = setTimeout(terminate, abortGraceMs);
    }, timeoutMs);
    child.on('error', fail);
    child.once('disconnect', () => { if (!closed && !result) fail(new Error('Prerender coordinator IPC disconnected before completion')); });
    child.on('message', value => { if (typeof value?.ok === 'boolean') result = value; });
    // Failed spawns emit error+close without exit. Publish/reject only after
    // the final terminal event, so stage cleanup cannot race this process.
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timeout); clearTimeout(terminateTimer); clearTimeout(killTimer);
      if (!failure && result?.ok && code === 0) resolve(result.manifest);
      else reject(failure || new Error(result?.error || `Prerender exited ${signal || code}`));
    });
    send({ root, stage, manifest, options });
  });
}

/** Retain production graphs during local rebuilds; no HTTP listener/daemon. */
export async function watchProduction(root,options={}){
  let worker,watcher,stopping=false,timer,busy=false,queued=false;
  const changed=new Set(),filter=createDevChangeFilter(root);
  let output='.prnext';
  const stopWorker=async()=>{
    const old=worker;worker=undefined;if(!old||old.exitCode!==null||old.signalCode)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>old.kill(),5000);old.once('exit',()=>{clearTimeout(timer);resolve();});old.disconnect();});
  };
  const shutdown=async()=>{if(stopping)return;stopping=true;clearTimeout(timer);watcher?.close();await stopWorker();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  async function rebuild(){
    if(stopping)return;if(busy){queued=true;return;}busy=true;
    const pending=[...changed];changed.clear();
    try{
      const actual=await filter(pending);
      if(worker&&!actual.length)return;
      if(actual.some(file=>/(?:^|\/)(?:(?:next|prnext|contentlayer)\.config\.|package(?:-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.env)/.test(file)))await stopWorker();
      if(!worker){worker=fork(new URL('./dev-worker.mjs',import.meta.url),[],{cwd:root,execArgv:[],stdio:['inherit','inherit','inherit','ipc'],windowsHide:true});}
      const current=worker;
      const result=await new Promise((resolve,reject)=>{
        const cleanup=()=>{current.off('message',message);current.off('exit',exit);current.off('error',error);};
        const message=value=>{if(value?.type==='result'){cleanup();resolve(value);}};
        const exit=()=>{cleanup();reject(new Error('Production compiler exited'));};
        const error=value=>{cleanup();reject(value);};
        current.on('message',message);current.once('exit',exit);current.once('error',error);
        current.send({type:'build',root,options:{...options,dev:false,incremental:true}});
      });
      if(result.recycle)await stopWorker();
      if(!result.ok)throw new Error(result.error);
      filter.acceptInputs(result.inputs||[]);
      try{output=JSON.parse(await readFile(path.join(root,'.prnext-output.json'),'utf8')).distDir||output;}catch{}
      await watcher?.refresh();
      console.log(`Watching production sources (${result.compiler?.reused||0} compiler graph reuse(s)).`);
    }catch(error){console.error(error.stack||error);}
    finally{busy=false;if(queued&&!stopping){queued=false;void rebuild();}}
  }
  try{
    watcher=await watchProject(root,{ignore:relative=>relative===output||relative.startsWith(output+'/'),onError:error=>{console.error(error);process.exitCode=1;void shutdown();},onChange:file=>{changed.add(String(file).replaceAll(path.sep,'/'));clearTimeout(timer);timer=setTimeout(()=>void rebuild(),150);}});
    await rebuild();
    // The watcher owns the event-loop lifetime. Stop signals close it and the
    // compiler child; builds continue to publish through the existing lock.
    await new Promise(resolve=>{const poll=setInterval(()=>{if(stopping&&!worker){clearInterval(poll);resolve();}},100);});
  }finally{await shutdown();process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);}
}
