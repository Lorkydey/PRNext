import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, binary } from './support.mjs';

async function waitFor(check, milliseconds = 10000) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('shutdown fixture condition timed out');
}

async function readMarker(markers,name,server){
  try{return await readFile(path.join(markers,name),'utf8');}
  catch(error){throw new Error('Missing shutdown marker '+name+'; native output: '+server.output(),{cause:error});}
}

async function start(root, markers, id, host = false, options = {}) {
  const config = path.join(root, `shutdown-host-${id}.json`);
  if (host) await writeFile(config, JSON.stringify({hostname:'127.0.0.1',port:0,memoryMb:512,
    apps:[{name:'shutdown',root,hosts:['127.0.0.1'],memoryMb:512,idleSeconds:options.idleSeconds ?? 300,workers:1,profile:'balanced',
      env:{SHUTDOWN_PROBE_DIR:markers,SHUTDOWN_PROBE_ID:id}},
      ...(options.secondRoot ? [{name:'other',root:options.secondRoot,hosts:['localhost'],memoryMb:512,idleSeconds:300,workers:1}] : [])]}));
  const child = spawn(binary, host
    ? ['host', config, '--node', process.execPath, '--shutdown-on-stdin-eof']
    : ['start', root, '--hostname', '127.0.0.1', '--port', '0', '--workers', '1', '--node', process.execPath, '--shutdown-on-stdin-eof', ...(options.workerIdle ? ['--worker-idle-seconds','1','--lane-idle-seconds','1'] : [])],
  {cwd:root, env:{...process.env,NODE_ENV:'production',SHUTDOWN_PROBE_DIR:markers,SHUTDOWN_PROBE_ID:id},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output = '';
  const append = value => { output = (output + value).slice(-65536); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code,signal}));
  });
  // Observe an early spawn failure immediately, and retain the original promise
  // for later assertions. Readiness failure must not leave an unreturned child.
  void exit.catch(() => {});
  let url;
  try {
    url = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit.catch(() => {});
    throw error;
  }
  return {child,exit,url,output:()=>output,async finish(mode, maximum = 8000, expectedCode = 0) {
    const started = performance.now();
    if (mode === 'SIGTERM') child.kill('SIGTERM'); else child.stdin.end();
    let timer;
    try {
      const result = await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('native drain exceeded test bound: '+output)),maximum);})]);
      assert.deepEqual(result,{code:expectedCode,signal:null},output);
      return performance.now()-started;
    } finally { clearTimeout(timer); }
  },async cleanup() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  }};
}

test('native shutdown, sleep and eviction preserve tracked work with bounded cleanup', {timeout:360000}, async () => {
  const fixture = await appFixture();
  const realRoot = await realpath(fixture.root);
  const realTemp = await realpath(os.tmpdir());
  assert.equal(path.dirname(realRoot), realTemp);
  assert.ok(path.basename(realRoot).startsWith('prnext-app-independent-'));
  let server;
  try {
    const appDirectory=path.join(realRoot,'app');
    assert.equal(await realpath(appDirectory),appDirectory);
    assert.equal(path.dirname(appDirectory),realRoot);
    await rm(appDirectory,{recursive:true});
    const files = {
      'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
      'app/page.jsx': `export default function Page(){return <p>shutdown-fixture</p>}`,
      'app/shutdown-check/route.js': `
        import {after} from 'next/server';
        import {cookies} from 'next/headers';
        import {unstable_cache} from 'next/cache';
        import {writeFileSync,appendFileSync} from 'node:fs';
        import path from 'node:path';
        const mark=(name,value='yes')=>writeFileSync(path.join(process.env.SHUTDOWN_PROBE_DIR,process.env.SHUTDOWN_PROBE_ID+'-'+name),value);
        export const maxDuration=60;
        export async function GET(request) {
          const q=new URL(request.url).searchParams;
          process.once('exit',()=>mark('normal-exit'));
          if(q.has('warm')) return Response.json({pid:process.pid});
          after(async()=>{
            mark('START',String(Date.now()));
            if(q.has('hang')) await new Promise(()=>setInterval(()=>{},1000));
            await new Promise(resolve=>setTimeout(resolve,q.has('long')?35000:750));
            const read=unstable_cache(async()=>{appendFileSync(path.join(process.env.SHUTDOWN_PROBE_DIR,'cache-producers'),'x');return 'cache-ok'},['shutdown-'+process.env.SHUTDOWN_PROBE_ID],{tags:['shutdown-proof']});
            if(await read()!=='cache-ok') throw new Error('cache read failed');
            // Public revalidateTag rejects phase after in this version; the
            // private Pages RPC below still tests dependent worker regeneration.
            const response=await fetch(new URL('/pages/revalidate',process.env.PRNEXT_CACHE_URL),{
              method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.PRNEXT_CACHE_TOKEN},
              body:JSON.stringify({path:'/shutdown-isr'}),signal:AbortSignal.timeout(5000)});
            if(!response.ok || !(await response.json()).revalidated) throw new Error('private Pages revalidation failed');
            mark('DONE',JSON.stringify({user:(await cookies()).get('user')?.value,pid:process.pid}));
            after(()=>mark('nested'));
          });
          return Response.json({pid:process.pid});
        }
      `,
      'app/shutdown-action/action.js': `'use server';
        import {after} from 'next/server';
        import {cookies} from 'next/headers';
        import {writeFileSync} from 'node:fs';import path from 'node:path';
        const mark=(name,value='yes')=>writeFileSync(path.join(process.env.SHUTDOWN_PROBE_DIR,process.env.SHUTDOWN_PROBE_ID+'-'+name),value);
        export async function shutdownAction(){
          after(async()=>{
            mark('START',String(Date.now()));
            await new Promise(resolve=>setTimeout(resolve,750));
            mark('DONE',JSON.stringify({user:(await cookies()).get('user')?.value,pid:process.pid}));
            after(()=>mark('nested'));
          });
          return 'shutdown-action-result';
        }
      `,
      'app/shutdown-action/page.jsx': `
        import {shutdownAction} from './action';
        export const dynamic='force-dynamic';
        export default function Page(){return <main><form action={shutdownAction}><button>Invoke</button></form><p>shutdown-action-proof</p></main>}
      `,
      'pages/shutdown-isr.jsx': `
        import {writeFileSync} from 'node:fs';import path from 'node:path';
        export async function getStaticProps(){
          if(process.env.SHUTDOWN_PROBE_DIR)writeFileSync(path.join(process.env.SHUTDOWN_PROBE_DIR,process.env.SHUTDOWN_PROBE_ID+'-ISR'),String(process.pid));
          return {props:{value:'isr-proof'},revalidate:60};
        }
        export default function Page({value}){return <p>{value}</p>}
      `,
      'app/shutdown-stream/route.js': `
        export const maxDuration=120;
        export function GET(){let timer;return new Response(new ReadableStream({
          start(controller){controller.enqueue(new TextEncoder().encode('started'));timer=setInterval(()=>controller.enqueue(new Uint8Array([120])),500)},
          cancel(){clearInterval(timer)}
        }))}
      `,
    };
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(realRoot, name);
      await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,source);
    }
    await build(realRoot);
    const manifest=JSON.parse(await readFile(path.join(realRoot,'.prnext/manifest.json'),'utf8'));
    const actionIds=Object.keys(manifest.app.actions);
    assert.equal(actionIds.length,1,'the isolated fixture has exactly its one Server Action');
    const actionId=actionIds[0];
    const markers = path.join(realRoot,'shutdown-private-markers');
    await mkdir(markers);
    const scenarios = [{id:'standalone-control',mode:'CONTROL',host:false},{id:'standalone-eof',mode:'EOF',host:false},{id:'host-eof',mode:'EOF',host:true}];
    if(process.platform!=='win32')scenarios.push({id:'standalone-sigterm',mode:'SIGTERM',host:false});
    scenarios.push({id:'action-after',mode:process.platform==='win32'?'EOF':'SIGTERM',host:false,action:true});
    for(const scenario of scenarios) {
      server=await start(realRoot,markers,scenario.id,scenario.host);
      const warm=scenario.action ? await (await fetch(server.url+'/shutdown-check?warm',{signal:AbortSignal.timeout(15000)})).json() : null;
      const response=await fetch(server.url+(scenario.action?'/shutdown-action':'/shutdown-check'),{
        ...(scenario.action?{method:'POST',body:'[]'}:{}),
        headers:{cookie:'user=grace',...(scenario.action?{'Next-Action':actionId,'Content-Type':'text/plain',origin:server.url}:{})},
        signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,200,server.output());
      let body;
      if(scenario.action){assert.match(await response.text(),/shutdown-action-proof/,server.output());body=warm;}
      else body=await response.json();
      const started=await waitFor(()=>readFile(path.join(markers,scenario.id+'-START'),'utf8').catch(()=>null));
      assert.ok(Date.now()-Number(started)<700,'signal must precede the 750 ms delayed completion');
      if(scenario.mode==='CONTROL')await waitFor(()=>readFile(path.join(markers,scenario.id+'-DONE'),'utf8').catch(()=>null));
      await server.finish(scenario.mode==='CONTROL'?'EOF':scenario.mode);
      assert.deepEqual(JSON.parse(await readMarker(markers,scenario.id+'-DONE',server)),{user:'grace',pid:body.pid},server.output());
      assert.equal(await readMarker(markers,scenario.id+'-nested',server),'yes');
      assert.equal(await readMarker(markers,scenario.id+'-normal-exit',server),'yes');
      if(!scenario.action){
        const isrPid=Number(await readMarker(markers,scenario.id+'-ISR',server));
        assert.ok(Number.isInteger(isrPid)&&isrPid>0,server.output());
        assert.notEqual(isrPid,body.pid,'private Pages regeneration must activate its distinct pool: '+server.output());
      }
      assert.doesNotMatch(server.output(),/Post-response work failed|\[prnext\] after\(\) failed|bounded deadline|failed to reap/);
      server=null;
    }
    // Longer than both the old three-second kill and the service's 30 s drain.
    // Real public after()
    // plus cache/ISR and nested work must survive idle and capacity retirement.
    const secondRoot=path.join(realRoot,'other-app');
    await mkdir(path.join(secondRoot,'app'),{recursive:true});
    await writeFile(path.join(secondRoot,'package.json'),JSON.stringify({name:'other',private:true,type:'module'}));
    await writeFile(path.join(secondRoot,'app/layout.jsx'),files['app/layout.jsx']);
    await writeFile(path.join(secondRoot,'app/page.jsx'),`export default function Page(){return <p>other-application</p>}`);
    await build(secondRoot);
    for(const scenario of [
      {id:'lane-idle',host:false,options:{workerIdle:true}},
      {id:'host-idle',host:true,options:{idleSeconds:1}},
      {id:'host-eviction',host:true,options:{secondRoot}},
      {id:'host-eviction-cancel',host:true,options:{secondRoot},cancel:true},
    ]) {
      server=await start(realRoot,markers,scenario.id,scenario.host,scenario.options);
      const reply=await fetch(server.url+'/shutdown-check?long',{headers:{cookie:'user=long-work'},signal:AbortSignal.timeout(15000)});
      assert.equal(reply.status,200,server.output());
      const original=await reply.json();
      await waitFor(()=>readFile(path.join(markers,scenario.id+'-START'),'utf8').catch(()=>null));
      let eviction, evictionReady=false;
      const evictionAbort=new AbortController();
      if(scenario.options.secondRoot) {
        // Node's http client preserves an explicit Host on Node 22 and 24.
        const {get}=await import('node:http');
        eviction=new Promise((resolve,reject)=>{
          const req=get(server.url,{headers:{host:'localhost'},signal:AbortSignal.any([AbortSignal.timeout(50000),evictionAbort.signal])},res=>{
            let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);
            res.on('end',()=>resolve({status:res.statusCode,body}));
          });req.on('error',reject);
        }).then(result=>{evictionReady=true;return result;});
        void eviction.catch(()=>{});
      }
      await delay(4200);
      assert.doesNotThrow(()=>process.kill(original.pid,0),'after worker must outlive the former retirement cutoff');
      if(eviction) assert.equal(evictionReady,false,'capacity stays reserved until the previous app finishes draining');
      if(scenario.host) {
        const status=JSON.parse(await readFile(path.join(realRoot,`shutdown-host-${scenario.id}.status.json`),'utf8'));
        assert.equal(status.apps[0].state,'draining');
        assert.ok(status.apps[0].pid>0,'status retains the live draining process');
        assert.ok(Date.now()-status.time<3500,'long retirement must not block the monitor');
        assert.equal(status.reservedMb,512);
      }
      assert.equal(await readFile(path.join(markers,scenario.id+'-DONE'),'utf8').catch(()=>null),null);
      if(scenario.cancel) evictionAbort.abort();
      await waitFor(()=>readFile(path.join(markers,scenario.id+'-nested'),'utf8').catch(()=>null),40000);
      assert.deepEqual(JSON.parse(await readMarker(markers,scenario.id+'-DONE',server)),{user:'long-work',pid:original.pid});
      assert.ok(Number(await readMarker(markers,scenario.id+'-ISR',server))>0);
      if(scenario.cancel) await assert.rejects(eviction,{code:'ABORT_ERR'});
      else if(eviction){const next=await eviction;assert.equal(next.status,200,server.output());assert.match(next.body,/other-application/);}
      if(scenario.host) await waitFor(()=>readFile(path.join(markers,scenario.id+'-normal-exit'),'utf8').catch(()=>null));
      await server.finish('EOF');
      await waitFor(()=>{try{process.kill(original.pid,0);return false;}catch{return true;}});
      assert.doesNotMatch(server.output(),/Post-response work failed|bounded deadline|failed to reap/);
      server=null;
    }
    server=await start(realRoot,markers,'warm');
    await (await fetch(server.url+'/shutdown-check?warm',{signal:AbortSignal.timeout(10000)})).text();
    assert.ok(await server.finish('EOF')<3000,'warm shutdown should not wait for the 30 s maximum');
    server=null;
    server=await start(realRoot,markers,'hung');
    await (await fetch(server.url+'/shutdown-check?hang',{signal:AbortSignal.timeout(10000)})).text();
    await waitFor(()=>readFile(path.join(markers,'hung-START'),'utf8').catch(()=>null));
    const elapsed=await server.finish('EOF',37000);
    assert.ok(elapsed>=25000 && elapsed<37000,'tracked unending work must get bounded grace, then terminate');
    assert.equal(await readFile(path.join(markers,'hung-DONE'),'utf8').catch(()=>null),null);
    server=null;
    server=await start(realRoot,markers,'active-stream');
    const stream=await fetch(server.url+'/shutdown-stream',{signal:AbortSignal.timeout(45000)});
    const reader=stream.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'started');
    try {
      const elapsed=await server.finish('EOF',37000,1);
      assert.ok(elapsed>=25000 && elapsed<37000,'the global deadline must include active HTTP streaming');
      assert.match(server.output(),/HTTP shutdown deadline exceeded/);
    } finally { await reader.cancel().catch(()=>{}); }
    server=null;
  } catch(error) {
    const markerDirectory=path.join(realRoot,'shutdown-private-markers');
    const names=(await readdir(markerDirectory).catch(()=>[])).sort().slice(0,64);
    const markerValues={};for(const name of names)markerValues[name]=(await readFile(path.join(markerDirectory,name),'utf8').catch(e=>'READ ERROR '+e.message)).slice(0,4096);
    console.error('SHUTDOWN_TEST_CONTEXT '+JSON.stringify({error:error.message,output:server?.output()||'',markers:markerValues}));
    throw error;
  } finally {
    await server?.cleanup();
    // Only remove the fresh fixture whose real parent and prefix were checked.
    assert.equal(await realpath(fixture.root),realRoot);
    assert.equal(path.dirname(realRoot),await realpath(os.tmpdir()));
    assert.ok(path.basename(realRoot).startsWith('prnext-app-independent-'));
    await fixture.remove();
  }
});
