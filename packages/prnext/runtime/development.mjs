import {createDevCompilerBroker} from './dev-compiler-broker.mjs';
import {spawn} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,rm,link,copyFile,realpath,lstat} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rename} from './fs.mjs';
import {watchProject} from './watch-project.mjs';
import {createDevChangeFilter} from './dev-file-changes.mjs';
import {shouldWatchProjectFile} from './env.mjs';
import {privateCacheDirectory,pruneCompilerCache} from '../build/persistent-cache.mjs';
import {DevGateway} from './dev-gateway.mjs';
import {withBuildLock} from '../build/build-lock.mjs';
import {createDevToolsServer} from './dev-tools-server.mjs';
import {createDevSourceTools} from './dev-tools-source.mjs';
import {createDevMetricsCollector} from './dev-tools-metrics.mjs';
import {invalidateDevRouteCache} from './dev-cache-control.mjs';
import {parseDevLogLine} from './dev-worker-logs.mjs';
import {createDevRuntimePool} from './dev-runtime-pool.mjs';
import {tryDevCssUpdate} from '../build/dev-css-update.mjs';
import {devBuildReason} from './dev-build-reasons.mjs';
import {publishDependencyGraph,affectedDependencies,canSkipUnopenedRoutes} from './dev-dependency-graph.mjs';
import {prepareDevNotification} from './dev-notification.mjs';
import {writeAtomicFile} from './atomic-file.mjs';
import {lazyImportIdentifier,materializeDevImport} from './dev-lazy-imports.mjs';
import {pruneDevelopmentStyles} from './dev-style-retention.mjs';

const packageRoot=fileURLToPath(new URL('../',import.meta.url));
export function developmentRoute(routes,raw,config={}) {
  let pathname=new URL(raw,'http://local').pathname;
  const base=config.basePath||'';
  if(base){if(pathname!==base&&!pathname.startsWith(base+'/'))return;pathname=pathname.slice(base.length)||'/';}
  const data=/^\/(?:_prnext|_next)\/data\/[^/]+\/(.*)\.json$/.exec(pathname);
  if(data){pathname='/'+data[1];if(pathname==='/index')pathname='/';else if(pathname.startsWith('/index/index'))pathname=pathname.slice(6);}
  let parts;try{parts=pathname.replace(/\/$/,'').split('/').slice(1).map(decodeURIComponent);if(parts.length===1&&!parts[0])parts=[];}catch{return;}
  if(config.i18n?.locales.includes(parts[0]))parts.shift();
  const matches=[];
  for(const route of routes){
    if(route.internal)continue;
    const pattern=route.pattern==='/'?[]:route.pattern.split('/').slice(1);let index=0,valid=true;const rank=[];
    for(const part of pattern){
      if(/^\[\[\.\.\./.test(part)){index=parts.length;rank.push(0);break;}
      if(/^\[\.\.\./.test(part)){if(index===parts.length)valid=false;index=parts.length;rank.push(1);break;}
      if(/^\[/.test(part)){if(index>=parts.length)valid=false;rank.push(2);}
      else {if(parts[index]!==part)valid=false;rank.push(3);}
      index++;
    }
    if(valid&&index===parts.length)matches.push({route,rank});
  }
  return matches.sort((a,b)=>{for(let i=0;i<Math.max(a.rank.length,b.rank.length);i++){const difference=(b.rank[i]??4)-(a.rank[i]??4);if(difference)return difference;}return 0;})[0]?.route;
}
async function stop(child) {
  if(!child||child.exitCode!==null||child.signalCode)return;
  const compiler=child.connected;
  await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),compiler?1000:5000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.connected)child.disconnect();if(child.stdin)child.stdin.end();else child.kill('SIGTERM');});
}
async function snapshot(source,destination) {
  const files=[];
  async function walk(directory,relative=''){
    await mkdir(path.join(destination,relative),{recursive:true});
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const name=path.join(relative,entry.name),file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file,name);
      else if(entry.isFile())files.push(name);
      else throw Error('Development build snapshots cannot contain symbolic links');
    }
  }
  await walk(source);let next=0;
  const results=await Promise.allSettled(Array.from({length:8},async()=>{while(next<files.length){const file=files[next++];try{await link(path.join(source,file),path.join(destination,file));}catch(error){if(!['EXDEV','EPERM','ENOTSUP','EACCES'].includes(error.code))throw error;await copyFile(path.join(source,file),path.join(destination,file));}}}));
  const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
}
export {snapshot as snapshotDevelopmentBuild};
function serverOptions(args) {
  let hostname='127.0.0.1',port=3000,hostAi=false,profile,safe=false;const backend=[];
  for(let i=0;i<args.length;i++){
    const [flag,inline]=args[i].split('=',2);
    if(['--port','-p','--hostname'].includes(flag)){
      const value=inline??args[++i];if(flag==='--hostname')hostname=value;else if(/^\d+$/.test(value||'')&&Number(value)<=65535)port=Number(value);else throw Error('Invalid development port');
    }else if(flag==='--safe'){if(inline!==undefined)throw Error('Use --safe without a value');safe=true;}
    else if(flag==='--host-ai'&&inline===undefined)hostAi=true;else {if(flag==='--profile')profile=inline??args[i+1];backend.push(args[i]);}
  }
  return {hostname,port,backend,hostAi,profile,safe};
}
export async function develop(projectRoot,args,binary) {
  return withBuildLock(projectRoot,root=>runDevelopment(root,args,binary),{development:true});
}
async function runDevelopment(projectRoot,args,binary) {
  const root=await realpath(projectRoot),options=serverOptions(args),session=randomUUID();
  // Private IPC state survives compiler recycling without exposing the key in
  // the browser's session metadata or any development manifest/notification.
  const devActionSecret=randomBytes(32).toString('base64');
  const stateFile=path.join(root,'.prnext-dev.json'),home=path.join(root,'.prnext-dev',session);
  const diagnosticsDirectory=process.env.PRNEXT_INSPECT_DIR||path.join(home,'diagnostics');
  // The session is ours; never clean a path obtained from application config.
  const container=path.join(root,'.prnext-dev'),info=await lstat(container).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('Development directory must be a real directory');
  await mkdir(home,{recursive:true});
  await mkdir(diagnosticsDirectory,{recursive:true,mode:0o700});
  let compiler,gateway,watcher,timer,tools,hostRelay,hostRelayTask,stopping=false,current,discovery,typeChecker,readyState={state:'building'},typeErrors=[],sequence=0;
  let dependencyIndexValid=false;
  const lifecycle=new AbortController();
  let queue=Promise.resolve(),stateQueue=Promise.resolve(),output='.prnext',changes=new Set(),active=new Map(),failed=new Set();
  const failedPaths=new Set();
  const requestedImports=new Set();
  const generations=[],styleGenerations=[],retiring=new Set(),pins=new Map(),routeCache=new Map(),filter=createDevChangeFilter(root);
  const compilerBroker=await createDevCompilerBroker({compile:(pattern,sources)=>serialized(async()=>{
    if(stopping)throw Error('Development is stopping');
    if(!discovery)await discover();
    const patterns=[...new Set([pattern,...sources])];
    if(patterns.some(p=>!discovery.project.routes.some(route=>route.pattern===p)))await discover();
    if(patterns.some(p=>!discovery.project.routes.some(route=>route.pattern===p)))throw Error('Unknown deferred route pattern');
    for(const value of patterns)active.set(value,Date.now());
    if(!current||patterns.some(p=>!current.patterns.has(p)))await rebuild([...active.keys()]);
    return current.directory;
  })});
  const runtimePool=createDevRuntimePool({binary,root,home,environment:{PRNEXT_DEV_COMPILER:compilerBroker.descriptor,PRNEXT_INSPECT_DIR:diagnosticsDirectory,...(options.profile?{PRNEXT_PROFILE:options.profile}:{})},onChild:child=>captureOutput({stderr:child.stderr,once:child.once.bind(child)},'runtime',{forwardStdout:false})});
  const toolSnapshot=()=>({...readyState,safeMode:options.safe,sequence:readyState.sequence??sequence,session,typeErrors,
    routes:(discovery?.project.routes||[]).filter(route=>!route.internal).map(route=>({path:(discovery.config.basePath||'')+(route.pattern==='/'?'/':route.pattern),kind:route.kind,source:route.file?path.relative(root,route.file).replaceAll(path.sep,'/'):undefined,compiled:current?.patterns.has(route.pattern)||false,pinned:[...pins.values()].some(pin=>pin.pattern===route.pattern)})),
    cache:{activeRoutes:active.size,pinnedRoutes:new Set([...pins.values()].map(pin=>pin.pattern)).size,retainedGenerations:generations.length,lookupEntries:routeCache.size,compiler:readyState.compiler,transforms:readyState.transforms,persistentTransforms:true,dependencyIndex:dependencyIndexValid?{valid:true,...current?.manifest.devDependencyIndex}:{valid:false}}});
  function captureOutput(child,source,{forwardStdout=true}={}){
    for(const [stream,level] of [[child.stdout,'info'],[child.stderr,'error']]){
      stream?.setEncoding('utf8');
      const emit=(line,newline)=>{const {text,level:reported,...metadata}=parseDevLogLine(line);tools?.addServerLog(reported||level,text,{process:source,buildId:current?.id,...metadata});if(level==='error'||forwardStdout)(level==='error'?process.stderr:process.stdout).write(text+(newline?'\n':''));};
      let pending='';stream?.on('data',chunk=>{pending+=String(chunk);let end;while((end=pending.indexOf('\n'))>=0){emit(pending.slice(0,end),true);pending=pending.slice(end+1);}if(pending.length>32768){emit(pending.slice(0,16000)+' [line truncated]',true);pending='';}});
      child.once('exit',()=>{if(pending)emit(pending,false);});
    }
  }
  function findRoute(raw){
    const key=new URL(raw,'http://local').pathname;
    if(routeCache.has(key))return routeCache.get(key);
    const route=developmentRoute(discovery.project.routes,raw,discovery.config);
    if(routeCache.size>=256)routeCache.delete(routeCache.keys().next().value);routeCache.set(key,route);return route;
  }
  let publicationFailures=0,lastPublicationFailure;
  const writeState=value=>{
    const task=stateQueue.then(async()=>{
      const next=value||readyState;
      const {notification,text}=prepareDevNotification({...next,safeMode:options.safe,typeErrors,...(publicationFailures?{publication:{failures:publicationFailures,lastFailure:lastPublicationFailure}}:{})});
      try{await writeAtomicFile(stateFile,text);}
      catch(error){
        publicationFailures++;lastPublicationFailure=error.atomicFile||{operation:'publish-development-state',code:error.code||'UNKNOWN'};
        // A failed publication must leave the last complete state readable.
        // This private bounded receipt contains no source path or payload.
        await writeFile(path.join(diagnosticsDirectory,'state-publication.json'),JSON.stringify({failures:publicationFailures,lastFailure:lastPublicationFailure,lastSuccessfulSequence:readyState.sequence??null})+'\n',{mode:0o600}).catch(()=>{});
        tools?.addServerLog('error','Development state publication failed.',{process:'compiler',...lastPublicationFailure});
        throw error;
      }
      readyState=next;
      if(gateway&&!gateway.stopping)await gateway.request('notify',{value:notification});
    });
    stateQueue=task.catch(()=>{});return task;
  };
  const serialized=run=>{const task=queue.then(()=>{if(stopping)throw Error('Development is stopping');return run();});queue=task.catch(()=>{});return task;};
  async function compilerRequest(type,values={}){
    if(!compiler||compiler.exitCode!==null||compiler.signalCode){
      const cache=await privateCacheDirectory(root,'dev-compiler-v8');
      await pruneCompilerCache(cache);
      compiler=spawn(process.execPath,[path.join(packageRoot,'build/dev-worker.mjs')],{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true,env:{...process.env,NODE_ENV:process.env.NODE_ENV||'development',...(options.safe?{PRNEXT_BUILD_CACHE:'0'}:{}),...(cache?{NODE_COMPILE_CACHE:cache}:{})}});
      captureOutput(compiler,'compiler');
    }
    const child=compiler;
    const result=await new Promise((resolve,reject)=>{
      const clean=()=>{child.off('message',message);child.off('error',error);child.off('exit',exit);};
      const message=value=>{if(value?.type==='result'){clean();resolve(value);}};
      const error=value=>{clean();reject(value);};const exit=()=>error(Error('Development compiler exited'));
      child.on('message',message);child.once('error',error);child.once('exit',exit);child.send({type,root,...values});
    });
      if(result.recycle){compiler=undefined;await stop(child);}
    if(!result.ok)throw Error(result.error);return result;
  }
  async function discover(){
    discovery=(await compilerRequest('discover')).discovery;routeCache.clear();output=discovery.config.distDir;
    if(options.safe)discovery={...discovery,eager:true};
    const {writeTypedRoutes}=await import('../build/typed-routes.mjs');
    await writeTypedRoutes(root,discovery.project,discovery.config);
    if(!typeChecker||typeChecker.inactive){const {startTypeChecker}=await import('../build/typescript-dev.mjs');typeChecker=await startTypeChecker(root,discovery.config,errors=>{typeErrors=errors;if(!stopping)void writeState().catch(console.error);});}
  }
  async function launch(manifest,directory){
    const runtime=options.safe?undefined:await runtimePool.take(directory).catch(error=>{tools?.addServerLog('warn','Worker warmup was unavailable; starting a fresh worker.',{process:'runtime'});return undefined;});
    const env={...process.env,NODE_ENV:process.env.NODE_ENV||'development',PRNEXT_INSPECT_DIR:diagnosticsDirectory,PRNEXT_DEV_COMPILER:compilerBroker.descriptor};
    delete env.PRNEXT_DEV_BROKER;
    if(runtime)env.PRNEXT_DEV_BROKER=runtime.descriptor;
    const child=spawn(binary,['start',root,'--build-dir',directory,'--worker',path.join(root,directory,'runtime/worker.mjs'),'--node',process.execPath,'--hostname','127.0.0.1','--port','0','--shutdown-on-stdin-eof',...options.backend],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
    captureOutput(child,'runtime',{forwardStdout:false});
    let output='';
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail(Error('Development backend did not start')),15000);
      const clean=()=>{clearTimeout(timer);child.off('error',fail);child.off('exit',exit);};
      const fail=error=>{clean();reject(error);};const exit=()=>fail(Error('Development backend exited before listening'));
      child.once('error',fail);child.once('exit',exit);child.stdout.on('data',chunk=>{output=(output+chunk).slice(-8192);process.stdout.write(chunk);const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match){clean();resolve(Number(match[1]));}});
    }).catch(async error=>{await stop(child);await runtime?.close();throw error;});
    return {id:manifest.buildId,child,runtime,port,directory};
  }
  async function rebuild(patterns,changedFiles=[],affectedRoutes,affectedModules,cause){
    const startedAt=Date.now(),started=performance.now(),phases={};let mark=started;
    let reason=devBuildReason({initial:!current,safe:options.safe,changed:changedFiles,cause});
    await writeState({state:'building',reason});
    const changed=changedFiles.slice(0,32).map(file=>file.slice(0,256));
    try{
      if(!options.safe)void runtimePool.warm().catch(()=>{});
      if(current&&!discovery.eager&&discovery.cssFast){
        const directory=path.relative(root,path.join(home,'styles-'+randomUUID())).replaceAll(path.sep,'/');
        const styles=await tryDevCssUpdate({root,source:path.join(root,current.cssDirectory||current.directory),destination:path.join(root,directory),manifest:current.manifest,changed:changedFiles,sequence:sequence+1,cssEngine:discovery.config.cssEngine,snapshot,onFallback:code=>{reason=devBuildReason({changed:changedFiles,cause:code});}});
        if(styles){
          await gateway.request('assets',{generation:styles.buildId,directory});
          try{styles.devDependencyIndex=await publishDependencyGraph(gateway,styles);dependencyIndexValid=true;}catch(error){dependencyIndexValid=false;await gateway.request('graph',{routes:[]});tools?.addServerLog('warn','Selective HMR unavailable: '+error.message,{process:'compiler'});}
          styleGenerations.push({id:styles.buildId,directory});
          await pruneDevelopmentStyles(styleGenerations,gateway,root);
          sequence++;current.manifest=styles;current.cssDirectory=directory;current.cssOnly=true;current.affectedRoutes=undefined;current.changed=changed;
          reason=devBuildReason({cause:'css-only'});
          await writeState({state:'ready',reason,buildId:styles.buildId,clientManifest:styles.devClient,sequence,session,changed,cssOnly:true,listenerPid:gateway.child.pid,compiler:current.compiler,transforms:current.transforms});
          tools?.recordBuild({buildId:styles.buildId,reason:reason.summary,reasonCode:reason.code,sequence,time:Date.now(),startedAt,duration:performance.now()-started,phases:{styles:performance.now()-started},mode:'css',state:'ready'});
          console.log('Styles updated. '+reason.summary);
          await watcher?.refresh();return styles;
        }
      }
      const result=await compilerRequest('build',{options:{...(discovery.eager?{}:{devRoutes:patterns}),devSafe:options.safe,devSequence:++sequence,devSession:session,devActionSecret,devTools:tools?.bootstrap,devAffectedModules:affectedModules,devLazyActivated:[...requestedImports],devForceRefresh:options.safe||changedFiles.some(file=>/\.(?:css|scss|sass)$/.test(file)||/(?:postcss|browserslist|\.env|config)/.test(file))}});
      phases.compile=performance.now()-mark;mark=performance.now();
      if(stopping)throw Error('Development is stopping');
      const consumed=filter.acceptInputs(result.inputs||[]);
      // Config can change after the watch batch was captured but before the
      // compiler reads it. Publish that change once and acknowledge its bytes.
      for(const file of consumed)if(/(?:^|\/)(?:(?:prnext|next)\.config\.|\.env)/.test(file)&&!changed.includes(file))changed.push(file.slice(0,256));
      const manifest=result.manifest;
      const directory=path.relative(root,path.join(home,manifest.buildId)).replaceAll(path.sep,'/');
      await snapshot(manifest.outputDirectory,path.join(root,directory));
      phases.snapshot=performance.now()-mark;mark=performance.now();
      if(stopping)throw Error('Development is stopping');
      let next;try{next=await launch(manifest,directory);phases.launch=performance.now()-mark;mark=performance.now();if(stopping)throw Error('Development is stopping');await gateway.request('activate',{generation:next.id,port:next.port,directory});phases.activate=performance.now()-mark;if(stopping)throw Error('Development is stopping');}catch(error){await stop(next?.child);await rm(path.join(root,directory),{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;}
      try{manifest.devDependencyIndex=await publishDependencyGraph(gateway,manifest);dependencyIndexValid=true;}
      catch(error){dependencyIndexValid=false;await gateway.request('graph',{routes:[]});affectedRoutes=undefined;affectedModules=undefined;tools?.addServerLog('warn','Selective HMR unavailable: '+error.message,{process:'compiler'});}
      const previous=current;current=next;current.compiler=result.compiler;current.transforms=result.transforms;generations.push(next);failed.clear();failedPaths.clear();
      current.manifest=manifest;current.changed=changed;current.patterns=new Set(discovery.eager?discovery.project.routes.map(route=>route.pattern):patterns);
      for(const id of requestedImports)if(!manifest.devLazy?.modules.some(item=>item.id===id))requestedImports.delete(id);
      const affected=Object.keys(manifest.app?.actions||{}).length?undefined:affectedRoutes;
      current.affectedRoutes=affected;
      try{
        await writeState({state:'ready',reason,buildId:manifest.buildId,clientManifest:manifest.devClient,sequence:manifest.devSequence,session,changed,affectedRoutes:affected,listenerPid:gateway.child.pid,compiler:result.compiler,transforms:result.transforms,routes:manifest.routes.filter(route=>!route.internal&&!route.devDeferred).map(route=>route.pattern)});
        tools?.recordBuild({buildId:manifest.buildId,reason:reason.summary,reasonCode:reason.code,sequence:manifest.devSequence,time:Date.now(),startedAt,duration:performance.now()-started,phases,routes:patterns.length,state:'ready'});
        console.log('Source compiled. '+reason.summary);
      }finally{
        // Activation already succeeded. A locked readiness receipt must not
        // keep obsolete runtimes alive or bypass the generation bound. Retire
        // through the gateway so existing requests drain before their owner
        // closes; the newly activated current runtime remains available.
        if(previous){
          const retiringTask=(async()=>{await gateway.request('retire',{generation:previous.id}).catch(()=>{});await previous.runtime?.close();await stop(previous.child);})().finally(()=>retiring.delete(retiringTask));retiring.add(retiringTask);
        }
        while(generations.length>3){const old=generations.shift();
          // A deferred request may itself be awaiting this build. Never wait for
          // its generation lease while holding the serialized compiler queue.
          const cleanup=(async()=>{await gateway.request('retire',{generation:old.id});await old.runtime?.close();await stop(old.child);await gateway.request('forget',{generation:old.id});await rm(path.join(root,old.directory),{recursive:true,force:true,maxRetries:10,retryDelay:100});})().catch(error=>{if(!stopping)console.warn('Development generation cleanup: '+error.message);}).finally(()=>retiring.delete(cleanup));retiring.add(cleanup);
        }
      }
      await watcher?.refresh();
      return manifest;
    }catch(error){if(!stopping){tools?.recordBuild({sequence,reason:reason.summary,reasonCode:reason.code,time:Date.now(),startedAt,duration:performance.now()-started,phases,state:'error'});tools?.addServerLog('error',error.message,{process:'compiler'});console.error('Build failed: '+error.message);await writeState({state:'error',reason,error:error.message});}throw error;}
  }
  const updateInfo=()=>({buildId:current.manifest.buildId,clientManifest:current.manifest.devClient,pagesManifest:current.manifest.pagesManifest,sequence:current.manifest.devSequence,session,changed:current.changed,cssOnly:current.cssOnly,affectedRoutes:current.affectedRoutes});
  async function ensure(raw,client,exact=false){
    if(new URL(raw,'http://local').pathname.startsWith('/_prnext/lazy/'))return serialized(async()=>{
      const id=lazyImportIdentifier(raw);
      if(!id||!current)throw Error('Unknown deferred import identifier');
      const lazy=await materializeDevImport({root,current,id,compile:async request=>{
        const result=await compilerRequest('build',{options:{devRoutes:[...current.patterns],devSafe:options.safe,devSequence:sequence,devSession:session,devActionSecret,devTools:tools?.bootstrap,devLazyRequest:request}});
        return result.manifest;
      }});
      requestedImports.add(id);
      return {lazy};
    });
    const resolve=()=>exact?discovery.project.routes.find(route=>route.pattern===raw):findRoute(raw);
    const warm=discovery&&resolve();
    if(!stopping&&current&&warm&&active.has(warm.pattern)&&current.patterns.has(warm.pattern)){
      active.set(warm.pattern,Date.now());if(pins.has(client))pins.get(client).pattern=warm.pattern;
      return updateInfo();
    }
    return serialized(async()=>{
    if(!discovery)try{await discover();}catch(error){failedPaths.add(raw);await writeState({state:'error',error:error.message});throw error;}
    let route=resolve();
    // A newly written route can be requested before the watcher's debounce.
    // Resolve that miss against the filesystem instead of returning a stale 404.
    if(!route){await discover();route=resolve();}
    if(route)active.set(route.pattern,Date.now());
    if(route&&pins.has(client))pins.get(client).pattern=route.pattern;
    const max=Math.max(0,Math.min(64,discovery.config.onDemandEntries?.pagesBufferLength??5));
    const pinned=new Set([...pins.values()].map(value=>value.pattern));
    if(route)pinned.add(route.pattern);
    const inactive=[...active].filter(([pattern])=>!pinned.has(pattern)).sort((a,b)=>a[1]-b[1]);
    const age=Math.min(86400000,discovery.config.onDemandEntries?.maxInactiveAge??60000);
    while(inactive.length>max&&(Date.now()-inactive[0][1]>=age||active.size>64+pinned.size))active.delete(inactive.shift()[0]);
    const graphChanged=current&&discovery.project.routes.some(candidate=>!current.manifest.routes.some(built=>built.id===candidate.id));
    if(!current || graphChanged || route&&!current.patterns.has(route.pattern)){
      try{await rebuild([...active.keys()]);}catch(error){if(route){failed.add(route.pattern);active.delete(route.pattern);}throw error;}
    }
    return updateInfo();
  });}
  async function changed(){
    try{
    const pending=[...changes];changes.clear();
    const actual=await filter(pending.filter(file=>file!==output&&!file.startsWith(output+'/')&&!output.startsWith(file+'/')));if(!actual.length)return;
    if(actual.some(file=>/(?:^|\/)(?:package(?:-lock)?\.json|(?:pnpm-lock\.yaml|yarn\.lock)|(?:prnext|next|contentlayer)\.config\.|\.env)/.test(file))){const old=compiler;compiler=undefined;if(old){old.disconnect();await stop(old);}await typeChecker?.close();typeChecker=undefined;typeErrors=[];}
    await discover();
    for(const raw of failedPaths){const route=findRoute(raw);if(route)active.set(route.pattern,Date.now());}
    const valid=new Set(discovery.project.routes.map(route=>route.pattern));for(const pattern of active.keys())if(!valid.has(pattern))active.delete(pattern);
    let affected,modules,cause;
    if(current&&!dependencyIndexValid)cause='dependency-capacity';
    if(current&&dependencyIndexValid&&!discovery.eager&&!failed.size&&!failedPaths.size){
      const result=await affectedDependencies(gateway,actual);
      if(result.unknown.length)cause='unknown-dependency';
      if(!result.complete)cause='dependency-capacity';
      const dormant=new Set(discovery.project.routes.filter(route=>!current.patterns.has(route.pattern)).map(route=>path.relative(root,route.file).replaceAll(path.sep,'/')));
      if(canSkipUnopenedRoutes(result,actual,dormant,dependencyIndexValid)){const skipped=devBuildReason({cause:'outside-active-graph'});tools?.recordBuild({time:Date.now(),duration:0,state:'skipped',reason:skipped.summary,reasonCode:skipped.code,changed:actual});return;}
      if(!result.unknown.length&&result.complete){
        if(result.modules.length)modules=result.modules;
        if(result.routes.length)affected=result.routes;
      }
    }
    if(current||failed.size||failedPaths.size)await rebuild([...new Set([...active.keys(),...failed])],actual,affected,modules,cause);
    }catch(error){if(!stopping&&readyState.state!=='error'){console.error('Build failed: '+error.message);await writeState({state:'error',error:error.message});}}
  }
  let closing;
  const shutdown=()=>{
    if(closing)return closing;stopping=true;lifecycle.abort();clearTimeout(timer);watcher?.close();
    closing=(async()=>{
      await Promise.all([gateway?.close(),hostRelay?.close(),hostRelayTask,stop(compiler),typeChecker?.close()]);
      // Keep each native data-cache bridge alive until its externally owned
      // Node process has drained after() work and cache fills on stdin EOF.
      await runtimePool.close();
      await Promise.all([tools?.close(),...generations.map(g=>stop(g.child)),...retiring]);
      await queue.catch(()=>{});await compilerBroker.close();await stateQueue;await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(stateFile,{force:true});
    })();return closing;
  };
  const fatal=error=>{if(!stopping){console.error(error.message);process.exitCode=1;void shutdown();}};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  try{
    tools=await createDevToolsServer({root,session,snapshot:toolSnapshot,sourceTools:await createDevSourceTools(root),collectMetrics:createDevMetricsCollector(diagnosticsDirectory),ensureRoute:raw=>ensure(raw,'mcp'),invalidateRoute:raw=>serialized(async()=>{
      if(!discovery)await discover();const route=findRoute(raw);if(!route)throw Error('No project route matches this pathname');
      if(!current||current.child.exitCode!==null)return {invalidated:false,scope:'native-route-cache',reason:'No active runtime cache yet. Visit the route first.'};
      const base=discovery.config.basePath||'',logical=base&&(raw===base||raw.startsWith(base+'/'))?raw.slice(base.length)||'/':raw;
      const result=await invalidateDevRouteCache({root,directory:current.directory,session,buildId:current.id,paths:[raw,logical]});
      return {...updateInfo(),...result};
    })});
    await writeState({state:'building',session});
    gateway=new DevGateway(binary,root,{...options,onEnsure:ensure,onFatal:fatal,
      onOpen:message=>{const route=discovery&&findRoute(message.path);if(route)pins.set(message.client,{pattern:route.pattern,connection:message.connection});},
      onClose:message=>{if(pins.get(message.client)?.connection===message.connection)pins.delete(message.client);}});
    const listener=await gateway.ready;
    tools.setAppUrl(`http://${options.hostname.includes(':')?'['+options.hostname+']':options.hostname}:${listener.port}`);
    if(options.hostAi){
      tools.setHostRelayState({enabled:true,linked:false});
      hostRelayTask=import('./dev-host-relay.mjs').then(({startDevHostRelay})=>startDevHostRelay({root,tools,signal:lifecycle.signal})).then(async relay=>{hostRelay=relay;if(stopping)await relay.close();}).catch(error=>{if(!stopping){tools.setHostRelayState({enabled:true,linked:false,error:error.message});tools.addServerLog('warn','Host AI relay is unavailable. Local development remains running.',{process:'host-relay'});}});
    }
    console.log(`PRNext development · http://${options.hostname.includes(':')?'['+options.hostname+']':options.hostname}:${listener.port} · on-demand routes`);
    if(options.safe)console.log('Safe mode: full route builds, fresh compilers and no worker warmup.');
    watcher=await watchProject(root,{ignore:relative=>relative===output||relative.startsWith(output+'/'),onError:fatal,onChange:(file,event)=>{
      typeChecker?.invalidate?.(file,event);
      if(stopping||!shouldWatchProjectFile(file))return;changes.add(String(file).replaceAll(path.sep,'/'));clearTimeout(timer);timer=setTimeout(()=>void serialized(changed).catch(()=>{}),75);
    }});
    await serialized(discover).catch(async error=>{console.error('Build failed: '+error.message);await writeState({state:'error',error:error.message});});
    await gateway.closed;
  }finally{await shutdown();process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);}
}
