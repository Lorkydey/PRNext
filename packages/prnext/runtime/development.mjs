import {spawn} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,rm,link,copyFile,realpath,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rename} from './fs.mjs';
import {watchProject} from './watch-project.mjs';
import {createDevChangeFilter} from './dev-file-changes.mjs';
import {shouldWatchProjectFile} from './env.mjs';
import {privateCacheDirectory,pruneCompilerCache} from '../build/persistent-cache.mjs';
import {DevGateway} from './dev-gateway.mjs';
import {withBuildLock} from '../build/build-lock.mjs';

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
function serverOptions(args) {
  let hostname='127.0.0.1',port=3000;const backend=[];
  for(let i=0;i<args.length;i++){
    const [flag,inline]=args[i].split('=',2);
    if(['--port','-p','--hostname'].includes(flag)){
      const value=inline??args[++i];if(flag==='--hostname')hostname=value;else if(/^\d+$/.test(value||'')&&Number(value)<=65535)port=Number(value);else throw Error('Invalid development port');
    }else backend.push(args[i]);
  }
  return {hostname,port,backend};
}
export async function develop(projectRoot,args,binary) {
  return withBuildLock(projectRoot,root=>runDevelopment(root,args,binary),{development:true});
}
async function runDevelopment(projectRoot,args,binary) {
  const root=await realpath(projectRoot),options=serverOptions(args),session=randomUUID();
  const stateFile=path.join(root,'.prnext-dev.json'),home=path.join(root,'.prnext-dev',session);
  // The session is ours; never clean a path obtained from application config.
  const container=path.join(root,'.prnext-dev'),info=await lstat(container).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('Development directory must be a real directory');
  await mkdir(home,{recursive:true});
  let compiler,gateway,watcher,timer,stopping=false,current,discovery,typeChecker,readyState={state:'building'},typeErrors=[],sequence=0;
  let queue=Promise.resolve(),stateQueue=Promise.resolve(),output='.prnext',changes=new Set(),active=new Map(),failed=new Set();
  const failedPaths=new Set();
  const generations=[],retiring=new Set(),pins=new Map(),routeCache=new Map(),filter=createDevChangeFilter(root);
  function findRoute(raw){
    const key=new URL(raw,'http://local').pathname;
    if(routeCache.has(key))return routeCache.get(key);
    const route=developmentRoute(discovery.project.routes,raw,discovery.config);
    if(routeCache.size>=256)routeCache.delete(routeCache.keys().next().value);routeCache.set(key,route);return route;
  }
  const writeState=value=>{
    const task=stateQueue.then(async()=>{if(value)readyState=value;const temporary=stateFile+'.'+randomUUID()+'.tmp';
      const notification={...readyState,typeErrors};let text=JSON.stringify(notification);
      if(Buffer.byteLength(text)>60*1024){
        delete notification.routes;delete notification.compiler;delete notification.transforms;
        if(notification.error)notification.error=String(notification.error).slice(0,4000);
        notification.typeErrors=typeErrors.length?[typeErrors.join('\n').slice(0,4000)]:[];
        text=JSON.stringify(notification);
      }
      try{await writeFile(temporary,text);await rename(temporary,stateFile);}finally{await rm(temporary,{force:true});}});
    stateQueue=task.catch(()=>{});return task;
  };
  const serialized=run=>{const task=queue.then(()=>{if(stopping)throw Error('Development is stopping');return run();});queue=task.catch(()=>{});return task;};
  async function compilerRequest(type,values={}){
    if(!compiler||compiler.exitCode!==null||compiler.signalCode){
      const cache=await privateCacheDirectory(root,'dev-compiler-v8');
      await pruneCompilerCache(cache);
      compiler=spawn(process.execPath,[path.join(packageRoot,'build/dev-worker.mjs')],{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true,env:{...process.env,NODE_ENV:process.env.NODE_ENV||'development',...(cache?{NODE_COMPILE_CACHE:cache}:{})}});
      compiler.stdout.on('data',chunk=>process.stdout.write(chunk));compiler.stderr.on('data',chunk=>process.stderr.write(chunk));
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
    if(discovery.eager)console.log('Development uses the complete route graph for middleware, rewrites or parallel routing.');
    const {writeTypedRoutes}=await import('../build/typed-routes.mjs');
    await writeTypedRoutes(root,discovery.project,discovery.config);
    if(!typeChecker||typeChecker.inactive){const {startTypeChecker}=await import('../build/typescript-dev.mjs');typeChecker=await startTypeChecker(root,discovery.config,errors=>{typeErrors=errors;if(!stopping)void writeState().catch(console.error);});}
  }
  async function launch(manifest,directory){
    const child=spawn(binary,['start',root,'--build-dir',directory,'--worker',path.join(root,directory,'runtime/worker.mjs'),'--node',process.execPath,'--hostname','127.0.0.1','--port','0','--shutdown-on-stdin-eof',...options.backend],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_ENV:process.env.NODE_ENV||'development'}});
    let output='';child.stderr.on('data',chunk=>process.stderr.write(chunk));
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail(Error('Development backend did not start')),15000);
      const clean=()=>{clearTimeout(timer);child.off('error',fail);child.off('exit',exit);};
      const fail=error=>{clean();reject(error);};const exit=()=>fail(Error('Development backend exited before listening'));
      child.once('error',fail);child.once('exit',exit);child.stdout.on('data',chunk=>{output=(output+chunk).slice(-8192);process.stdout.write(chunk);const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match){clean();resolve(Number(match[1]));}});
    }).catch(async error=>{await stop(child);throw error;});
    return {id:manifest.buildId,child,port,directory};
  }
  async function rebuild(patterns,changedFiles=[]){
    await writeState({state:'building'});
    const changed=changedFiles.slice(0,32).map(file=>file.slice(0,256));
    try{
      const result=await compilerRequest('build',{options:{...(discovery.eager?{}:{devRoutes:patterns}),devSequence:++sequence,devSession:session}});
      if(stopping)throw Error('Development is stopping');
      const consumed=filter.acceptInputs(result.inputs||[]);
      // Config can change after the watch batch was captured but before the
      // compiler reads it. Publish that change once and acknowledge its bytes.
      for(const file of consumed)if(/(?:^|\/)(?:(?:prnext|next)\.config\.|\.env)/.test(file)&&!changed.includes(file))changed.push(file.slice(0,256));
      const manifest=result.manifest;
      const directory=path.relative(root,path.join(home,manifest.buildId)).replaceAll(path.sep,'/');
      await snapshot(manifest.outputDirectory,path.join(root,directory));
      if(stopping)throw Error('Development is stopping');
      let next;try{next=await launch(manifest,directory);if(stopping)throw Error('Development is stopping');await gateway.request('activate',{generation:next.id,port:next.port,directory});if(stopping)throw Error('Development is stopping');}catch(error){await stop(next?.child);await rm(path.join(root,directory),{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;}
      const previous=current;current=next;generations.push(next);failed.clear();failedPaths.clear();
      current.manifest=manifest;current.changed=changed;current.patterns=new Set(discovery.eager?discovery.project.routes.map(route=>route.pattern):patterns);
      await writeState({state:'ready',buildId:manifest.buildId,clientManifest:manifest.devClient,sequence:manifest.devSequence,session,changed,listenerPid:gateway.child.pid,compiler:result.compiler,transforms:result.transforms,routes:manifest.routes.filter(route=>!route.internal).map(route=>route.pattern)});
      console.log('Source compiled. React Fast Refresh applied in connected browsers.');
      if(previous){
        const retiringTask=(async()=>{await gateway.request('retire',{generation:previous.id}).catch(()=>{});await stop(previous.child);})().finally(()=>retiring.delete(retiringTask));retiring.add(retiringTask);
      }
      while(generations.length>3){const old=generations.shift();await gateway.request('retire',{generation:old.id});await stop(old.child);await gateway.request('forget',{generation:old.id});await rm(path.join(root,old.directory),{recursive:true,force:true,maxRetries:10,retryDelay:100});}
      await watcher?.refresh();
      return manifest;
    }catch(error){if(!stopping){console.error('Build failed: '+error.message);await writeState({state:'error',error:error.message});}throw error;}
  }
  const updateInfo=()=>({buildId:current.manifest.buildId,clientManifest:current.manifest.devClient,pagesManifest:current.manifest.pagesManifest,sequence:current.manifest.devSequence,session,changed:current.changed});
  async function ensure(raw,client){
    const warm=discovery&&findRoute(raw);
    if(!stopping&&current&&warm&&active.has(warm.pattern)&&current.patterns.has(warm.pattern)){
      active.set(warm.pattern,Date.now());if(pins.has(client))pins.get(client).pattern=warm.pattern;
      return updateInfo();
    }
    return serialized(async()=>{
    if(!discovery)try{await discover();}catch(error){failedPaths.add(raw);await writeState({state:'error',error:error.message});throw error;}
    let route=findRoute(raw);
    // A newly written route can be requested before the watcher's debounce.
    // Resolve that miss against the filesystem instead of returning a stale 404.
    if(!route){await discover();route=findRoute(raw);}
    if(route)active.set(route.pattern,Date.now());
    if(route&&pins.has(client))pins.get(client).pattern=route.pattern;
    const max=Math.max(0,Math.min(64,discovery.config.onDemandEntries?.pagesBufferLength??5));
    const pinned=new Set([...pins.values()].map(value=>value.pattern));
    if(route)pinned.add(route.pattern);
    const inactive=[...active].filter(([pattern])=>!pinned.has(pattern)).sort((a,b)=>a[1]-b[1]);
    const age=Math.min(86400000,discovery.config.onDemandEntries?.maxInactiveAge??60000);
    while(inactive.length>max&&(Date.now()-inactive[0][1]>=age||active.size>64+pinned.size))active.delete(inactive.shift()[0]);
    if(!current || route&&!current.patterns.has(route.pattern)){
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
    if(current||failed.size||failedPaths.size)await rebuild([...new Set([...active.keys(),...failed])],actual);
    }catch(error){if(!stopping&&readyState.state!=='error'){console.error('Build failed: '+error.message);await writeState({state:'error',error:error.message});}}
  }
  let closing;
  const shutdown=()=>{
    if(closing)return closing;stopping=true;clearTimeout(timer);watcher?.close();
    closing=(async()=>{
      await Promise.all([gateway?.close(),stop(compiler),typeChecker?.close(),...generations.map(g=>stop(g.child)),...retiring]);
      await queue.catch(()=>{});await stateQueue;await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(stateFile,{force:true});
    })();return closing;
  };
  const fatal=error=>{if(!stopping){console.error(error.message);process.exitCode=1;void shutdown();}};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  try{
    await writeState({state:'building',session});
    gateway=new DevGateway(binary,root,{...options,onEnsure:ensure,onFatal:fatal,
      onOpen:message=>{const route=discovery&&findRoute(message.path);if(route)pins.set(message.client,{pattern:route.pattern,connection:message.connection});},
      onClose:message=>{if(pins.get(message.client)?.connection===message.connection)pins.delete(message.client);}});
    const listener=await gateway.ready;
    console.log(`PRNext development · http://${options.hostname.includes(':')?'['+options.hostname+']':options.hostname}:${listener.port} · on-demand routes`);
    watcher=await watchProject(root,{ignore:relative=>relative===output||relative.startsWith(output+'/'),onError:fatal,onChange:file=>{
      if(stopping||!shouldWatchProjectFile(file))return;changes.add(String(file).replaceAll(path.sep,'/'));clearTimeout(timer);timer=setTimeout(()=>void serialized(changed).catch(()=>{}),75);
    }});
    await serialized(discover).catch(async error=>{console.error('Build failed: '+error.message);await writeState({state:'error',error:error.message});});
    await gateway.closed;
  }finally{await shutdown();process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);}
}
