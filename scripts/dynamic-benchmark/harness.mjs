import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,symlink,rm,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {freePort,repositoryRoot,binary} from '../../tests/support.mjs';
import {files,dynamicRoutes} from './fixture.mjs';

export const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
export const directory=path.resolve(process.env.DYNAMIC_BENCH_OUTPUT||'reports/dynamic-parity');
export const rootFor=engine=>path.join(directory,'projects',engine);
export const auditFile=engine=>path.join(directory,engine+'.executions.ndjson');
export const sha=content=>createHash('sha256').update(content).digest('hex');
export const sourceHash=sha(JSON.stringify(files));
export async function harnessHash(){const names=['fixture.mjs','backend.mjs','protocol.mjs','load.mjs','harness.mjs','parity.mjs','runner.mjs'];return sha((await Promise.all(names.map(async name=>name+'\n'+await readFile(path.join(here,name),'utf8')))).join('\n'))}
async function verifySources(){for(const engine of ['next','rustyx'])for(const [name,content] of Object.entries(files))assert.equal(await readFile(path.join(rootFor(engine),name),'utf8'),content,engine+' application file differs: '+name)}
export async function audit(engine){return (await readFile(auditFile(engine),'utf8')).split('\n').filter(Boolean).map(JSON.parse)}
export async function clearAudit(engine){await writeFile(auditFile(engine),'')}
export async function backendControl(backend,body={}){return (await fetch(backend.url+'/__control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json()}
export async function launchBackend(){
  const child=spawn(process.execPath,[path.join(here,'backend.mjs')],{stdio:['ignore','pipe','pipe','ipc']});
  const {url}=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('Backend exited '+code)))});
  return {child,url,async close(){if(child.exitCode!==null||child.signalCode)return;child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}};
}
export function environment(engine,backend){
  const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',BENCH_AUDIT_FILE:auditFile(engine),BENCH_BACKEND_URL:backend.url};
  for(const key of Object.keys(env))if(key.startsWith('PRNEXT_'))delete env[key];
  delete env.NODE_OPTIONS;
  return env;
}
export async function prepare(backend){
  await mkdir(directory,{recursive:true});
  const reference=path.resolve(process.env.DYNAMIC_BENCH_REFERENCE||path.join(repositoryRoot,'../nextjs-test-blog'));
  const require=createRequire(path.join(reference,'package.json'));
  // A fresh checkout can install the pinned fixture package, then set the reference path.
  const packages=['next','react','react-dom','scheduler'];
  const versions=Object.fromEntries(packages.map(name=>[name,require(name+'/package.json').version]));
  versions['react-server-dom-webpack']=createRequire(import.meta.url)('react-server-dom-webpack/package.json').version;
  versions.nextBundledReact=require('next/dist/compiled/react').version;
  versions.nextBundledReactDOM=require('next/dist/compiled/react-dom').version;
  for(const name of ['next','react','react-dom','react-server-dom-webpack'])assert.equal(versions[name],JSON.parse(files['package.json']).dependencies[name],'Pinned fixture dependency '+name);
  const builds=[];
  for(const engine of ['next','rustyx']){
    const root=rootFor(engine);await mkdir(root,{recursive:true});
    for(const [name,content] of Object.entries(files)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content)}
    await mkdir(path.join(root,'node_modules'),{recursive:true});
    for(const name of [...packages,'react-server-dom-webpack']){
      const resolver=name==='react-server-dom-webpack'?createRequire(import.meta.url):require;
      const target=path.dirname(resolver.resolve(name+'/package.json')),link=path.join(root,'node_modules',name);
      await rm(link,{force:true,recursive:true});await symlink(target,link,'dir');
    }
    await clearAudit(engine);
    const started=performance.now(),command=engine==='next'?require.resolve('next/dist/bin/next'):path.join(repositoryRoot,'packages/prnext/cli.mjs');
    try{const result=await exec(process.execPath,[command,'build',root],{cwd:root,env:environment(engine,backend),maxBuffer:8*1024**2});await writeFile(path.join(directory,`build-${engine}.log`),result.stdout+result.stderr)}
    catch(error){await writeFile(path.join(directory,`build-${engine}.log`),(error.stdout||'')+(error.stderr||''));throw error}
    const build={engine,elapsedMs:performance.now()-started,buildExecutions:await audit(engine)};
    if(engine==='next'){
      const manifest=JSON.parse(await readFile(path.join(root,'.next/prerender-manifest.json'),'utf8'));build.prerendered=Object.keys(manifest.routes);build.dynamicPrerendered=Object.keys(manifest.dynamicRoutes);
    }else{
      const manifest=JSON.parse(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'));build.prerendered=manifest.prerendered;build.dynamicPrerendered=[];
    }
    build.unexpectedPrerender=dynamicRoutes.filter(route=>JSON.stringify(build.prerendered).includes('"'+route+'"')||build.dynamicPrerendered.includes(route));
    builds.push(build);console.log('BUILT',engine,Math.round(build.elapsedMs)+'ms',JSON.stringify(build.unexpectedPrerender));
  }
  await verifySources();
  const prepared={sourceHash,harnessSha256:await harnessHash(),binarySha256:sha(await readFile(binary)),versions,builds,preparedAt:new Date().toISOString()};
  await writeFile(path.join(directory,'preparation.json'),JSON.stringify(prepared,null,2)+'\n');return prepared;
}
export async function launch(engine,backend,label,environmentOverrides={}){
  const root=rootFor(engine),port=await freePort(),require=createRequire(path.join(root,'package.json'));
  // Reset persisted application data, but keep compiled production artifacts.
  await rm(path.join(root,engine==='next'?'.next/cache/fetch-cache':'.prnext-cache'),{recursive:true,force:true});
  await clearAudit(engine);
  const args=engine==='next'?[require.resolve('next/dist/bin/next'),'start',root,'--hostname','127.0.0.1','--port',String(port)]:['start',root,'--hostname','127.0.0.1','--port',String(port)];
  const child=spawn(engine==='next'?process.execPath:binary,args,{cwd:root,env:{...environment(engine,backend),...environmentOverrides},detached:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);const url='http://127.0.0.1:'+port;
  const close=async()=>{if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{};await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);try{process.kill(-child.pid,'SIGKILL')}catch{}}await writeFile(path.join(directory,`server-${engine}-${label}.log`),log)};
  try{for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(log);try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(500)});if(await r.text()==='dynamic-parity-v1')return {child,url,close,output:()=>log}}catch{};await delay(25)}throw new Error('Server readiness timeout')}
  catch(error){await close();throw error}
}
export async function loadChild(options){const {stdout}=await exec(process.execPath,[path.join(here,'load.mjs'),JSON.stringify(options)],{maxBuffer:2*1024**2,timeout:300000});return JSON.parse(stdout)}
export async function prepared(){const data=JSON.parse(await readFile(path.join(directory,'preparation.json'),'utf8'));if(data.sourceHash!==sourceHash)throw new Error('Fixture changed: rebuild required');if(data.binarySha256!==sha(await readFile(binary)))throw new Error('PRNext binary changed: rebuild required');if(data.harnessSha256!==await harnessHash())throw new Error('Benchmark harness changed: a new parity campaign is required');await verifySources();return data}
