import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import {fork} from 'node:child_process';
import { PrerenderPool } from './prerender-pool.mjs';
import { validatePrerenderConfig, prerenderResources } from './prerender-config.mjs';
import { mapConcurrent } from './concurrent.mjs';

const resources = { cpus: 4, free: 4 * 1024 ** 3 };
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-prerender-pool-'));
  try {
    await mkdir(path.join(root, 'runtime'));
    await writeFile(path.join(root, 'runtime/render.mjs'), `
      import {appendFileSync,existsSync} from 'node:fs';import cache from ${JSON.stringify(new URL('../compat/data-cache.cjs', import.meta.url).href)};
      import headers from ${JSON.stringify(new URL('../compat/headers.cjs', import.meta.url).href)};
      import {installFetchCache} from ${JSON.stringify(new URL('../runtime/fetch-cache.mjs', import.meta.url).href)};
      installFetchCache();
      export async function prerenderRoute(options){
        const {path,log,fail,hang,cached}=options;
        if(options.startDelayMs)await new Promise(resolve=>setTimeout(resolve,options.startDelayMs));
        appendFileSync(log,JSON.stringify({type:'start',path,pid:process.pid,time:Date.now()})+'\\n');
        if(options.barrier){
          const deadline=Date.now()+15000;
          while(!existsSync(options.barrier)){
            if(Date.now()>deadline)throw new Error('parallel admission barrier timed out');
            await new Promise(resolve=>setTimeout(resolve,10));
          }
        }
        if(fail)throw new Error('deliberate-path-failure');
        if(hang)await new Promise(()=>setInterval(()=>{},1000));
        if(options.origin)return headers.runRequestContext({phase:'render',production:true,url:'http://prnext.local'+path,headers:new Headers()},async()=>{
          const response=await fetch(options.origin,options.fetchOptions);const body=await response.text();await cache.flushCacheWork();return{body:Buffer.from(body)};
        });
        let value;
        if(cached)value=(await cache.cachedValue('a'.repeat(64),async()=>{
          appendFileSync(log,JSON.stringify({type:'origin',pid:process.pid})+'\\n');
          await new Promise(resolve=>setTimeout(resolve,120));return Buffer.from('shared-cms-value');
        },{revalidate:60})).toString();
        const start=process.cpuUsage();let cpu;do{cpu=process.cpuUsage(start);}while(cpu.user+cpu.system<60000);
        const result={path,pid:process.pid,value,secret:globalThis.perBuild??'fresh'};globalThis.perBuild='retained-within-build';
        appendFileSync(log,JSON.stringify({type:'end',path,pid:process.pid,time:Date.now(),cpuMicros:cpu.user+cpu.system})+'\\n');
        return {body:Buffer.from(JSON.stringify(result)),dataJSON:'{}',revalidate:false,finalizeCache(){throw new Error('runtime has already finalized this response')}};
      }`);
    const log = path.join(root, 'events.jsonl');
    const create = () => new PrerenderPool(root, root, { config: {}, routes: [] }, { workers: 2, maxMemoryMb: 1024 }, resources);
    await run({ root, log, create });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const events = async log => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('prerender configuration and free-memory admission bound the total worker budget', () => {
  assert.deepEqual(validatePrerenderConfig(undefined), {});
  for (const value of [false, null, [], { workers: 0 }, { workers: 9 }, { workers: 1.5 }, { maxMemoryMb: 255 }, { maxMemoryMb: Infinity }, { unknown: true }]) assert.throws(() => validatePrerenderConfig(value), /prerender/);
  assert.equal(prerenderResources({ workers: 8, maxMemoryMb: 4096 }, { cpus: 16, free: 700 * 1024 ** 2 }).workers, 1);
  const result = prerenderResources({ workers: 8, maxMemoryMb: 1024 }, resources);
  assert.equal(result.workers, 2);
  assert.equal(result.maxMemoryMb, 1024);
  assert.ok(result.heapMb * result.workers < result.maxMemoryMb);
});

test('path jobs use two real CPU processes, bounded globally, and all children exit before completion', async () => fixture(async ({ root, log, create }) => {
  const pool = create();
  let pids;
  try {
    await pool.prepare(6);
    // Hold both initial jobs at a barrier so process/import scheduling cannot
    // turn a valid two-process pool into a timing-dependent overlap assertion.
    const barrier=path.join(root,'release-initial-jobs');
    const work=mapConcurrent(Array.from({ length: 6 }, (_, index) => index), index => pool.run('pages', {
      path: `/item/${index}`, log, ...(index<2?{barrier}:{}), ...(index===1?{startDelayMs:150}:{}),
    }), pool.parallelism);
    void work.catch(()=>{});
    const deadline=Date.now()+10000;
    let admitted;
    while((admitted=(await events(log).catch(()=>[])).filter(row=>row.type==='start')).length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(admitted.length,2,'both workers admit a job before either is released');
    assert.equal(new Set(admitted.map(row=>row.pid)).size,2);
    await writeFile(barrier,'release');
    const output = await work;
    assert.deepEqual(output.map(result => JSON.parse(result.body).path), ['/item/0', '/item/1', '/item/2', '/item/3', '/item/4', '/item/5']);
    pids = new Set(output.map(result => JSON.parse(result.body).pid));
    assert.equal(pids.size, 2); assert.ok(!pids.has(process.pid));
    const rows = await events(log); let active = 0, peak = 0;
    for (const event of rows) { if(event.type==='start')peak=Math.max(peak,++active);else if(event.type==='end')active--; }
    assert.equal(peak, 2); assert.equal(active, 0);
    const intervals = [...pids].map(pid => { const rowsForPid=rows.filter(row=>row.pid===pid);return [rowsForPid.find(row=>row.type==='start').time,rowsForPid.find(row=>row.type==='end').time]; });
    assert.ok(Math.max(...intervals.map(row=>row[0])) < Math.min(...intervals.map(row=>row[1])), 'jobs in distinct CPU processes are admitted concurrently');
    assert.ok(rows.filter(row=>row.type==='end').every(row=>row.cpuMicros>=60000),'every path performs real CPU work');
  } finally { await pool.close(); }
  assert.ok([...pids].every(pid=>!alive(pid)));
  const second=create();
  try { await second.prepare(2);const result=JSON.parse((await second.run('pages',{path:'/next-build',log})).body);assert.equal(result.secret,'fresh');assert.ok(!pids.has(result.pid)); }
  finally { await second.close(); }
}));

test('two simultaneous route batches share one process semaphore and observe refreshed error metadata',async()=>fixture(async({root,log,create})=>{
  const pool=create();
  try{
    await pool.prepare(8);
    await Promise.all(['first','second'].map(route=>mapConcurrent([0,1,2,3],index=>pool.run('pages',{path:`/${route}/${index}`,log}),4)));
    let active=0,peak=0;const rows=await events(log);
    for(const event of rows){if(event.type==='start')peak=Math.max(peak,++active);else if(event.type==='end')active--;}
    assert.equal(peak,2);assert.equal(rows.filter(row=>row.type==='start').length,8);
    pool.manifest.prerendered=[{path:'/404',status:404}];
    await writeFile(path.join(root,'runtime/route-static.mjs'),`export async function prerenderAppRouteHandler({manifest}){return {body:Buffer.from(JSON.stringify(manifest.prerendered))}}`);
    await pool.prepare(2);
    const result=await pool.run('handler',{path:'/metadata',log});
    assert.deepEqual(JSON.parse(result.body),[{path:'/404',status:404}]);
  }finally{await pool.close();}
}));

test('explicitly cached CMS reads coalesce across workers and the build-only store is discarded', async () => fixture(async ({ log, create }) => {
  const pool=create();
  try {
    await pool.prepare(2);
    const results=await Promise.all([pool.run('pages',{path:'/a',log,cached:true}),pool.run('pages',{path:'/b',log,cached:true})]);
    assert.ok(results.every(result=>JSON.parse(result.body).value==='shared-cms-value'));
    assert.equal((await events(log)).filter(row=>row.type==='origin').length,1);
  } finally { await pool.close(); }
  const second=create();
  try { await second.prepare(2);await second.run('pages',{path:'/new-build',log,cached:true}); }
  finally { await second.close(); }
  assert.equal((await events(log)).filter(row=>row.type==='origin').length,2);
}));

test('the existing fetch policy shares only explicit cacheable values, never no-store/auth defaults or Set-Cookie responses',async()=>fixture(async({log,create})=>{
  const counts=new Map();const origin=createServer((request,response)=>{
    counts.set(request.url,(counts.get(request.url)||0)+1);
    if(request.url==='/cookie')response.setHeader('set-cookie','session=private');
    setTimeout(()=>response.end(request.url),60);
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${origin.address().port}`;
  const pool=create();
  try{
    await pool.prepare(2);
    for(const [name,fetchOptions]of[
      ['cache',{cache:'force-cache'}],['no-store',{cache:'no-store'}],
      ['auth',{headers:{authorization:'private-fixture'}}],['cookie',{cache:'force-cache'}],
    ]){
      await Promise.all([0,1].map(index=>pool.run('pages',{path:`/${name}/${index}`,origin:base+'/'+name,fetchOptions,log})));
    }
    assert.deepEqual(Object.fromEntries(counts),{'/cache':1,'/no-store':2,'/auth':2,'/cookie':2});
  }finally{await pool.close();await new Promise(resolve=>{origin.close(resolve);origin.closeAllConnections();});}
}));

test('a failed path is never replayed, cancels other workers and reaps them before rejection completes', async () => fixture(async ({ log, create }) => {
  const pool=create();
  try {
    await pool.prepare(2);
    const pids=pool.children.map(worker=>worker.child.pid);
    await assert.rejects(mapConcurrent([0,1,2],index=>pool.run('pages',{path:`/fail/${index}`,log,fail:index===0,hang:index===1}),2),/deliberate-path-failure/);
    await pool.close();
    const rows=await events(log);
    assert.equal(rows.filter(row=>row.path==='/fail/0').length,1);
    assert.ok(!rows.some(row=>row.path==='/fail/2'));
    assert.ok(pids.every(pid=>!alive(pid)));
  } finally { await pool.close(); }
}));

test('RSS excess aborts the whole pool without retrying a completed path', async () => fixture(async ({ log, create }) => {
  const pool=create();
  try {
    await pool.prepare(2);const pids=pool.children.map(worker=>worker.child.pid);
    pool.resources.maxMemoryMb=1;
    await assert.rejects(pool.run('pages',{path:'/memory',log}),/RSS budget/);
    await pool.close();assert.ok(pids.every(pid=>!alive(pid)));
  } finally { await pool.close(); }
}));

test('explicit cancellation rejects queued work and waits for both blocked child processes to exit',async()=>fixture(async({log,create})=>{
  const pool=create();
  try{
    await Promise.all([pool.prepare(2),pool.prepare(2)]);
    assert.equal(pool.children.length,2,'simultaneous preparation must not duplicate the process pool');
    const pids=pool.children.map(worker=>worker.child.pid);
    const tasks=[0,1,2].map(index=>pool.run('pages',{path:`/cancel/${index}`,log,hang:true}));
    const observed=Promise.allSettled(tasks);
    for(let attempt=0;attempt<100;attempt++){
      const rows=await events(log).catch(()=>[]);if(rows.filter(row=>row.type==='start').length===2)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await pool.abort(new Error('cancelled-by-owner'));
    assert.ok(pids.every(pid=>!alive(pid)));
    const results=await observed;assert.ok(results.every(result=>result.status==='rejected'&&/cancelled-by-owner/.test(result.reason.message)));
    assert.ok(!(await events(log)).some(row=>row.path==='/cancel/2'));
  }finally{await pool.close();}
  await assert.rejects(pool.run('pages',{path:'/closed',log}),/cancelled-by-owner|not open/);
}));

test('tiny batches stay local and do not open a cache service or processes', async () => fixture(async ({ create }) => {
  const pool=create();try{await pool.prepare(1);assert.equal(pool.enabled,false);assert.equal(pool.children.length,0);assert.equal(pool.cache,undefined);}finally{await pool.close();}
}));

test('an ENOENT spawn emits close without exit and still rejects preparation and disposes its cache',async()=>fixture(async({root})=>{
  const pool=new PrerenderPool(root,root,{config:{},routes:[]},{workers:2,maxMemoryMb:1024},resources,{
    fork:(file,args,options)=>fork(file,args,{...options,execPath:path.join(root,'missing-node-executable')}),
  });
  const deadline=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('spawn cleanup did not settle')),2000);timer.unref();});
  await Promise.race([assert.rejects(pool.prepare(2),/ENOENT/),deadline]);
  await pool.close();
  await assert.rejects(fetch(pool.cache.env.PRNEXT_CACHE_URL),/fetch failed/);
}));

test('cancellation escalates to SIGKILL before waiting when a worker ignores SIGTERM',async()=>fixture(async({root,log})=>{
  const signals=[];
  const pool=new PrerenderPool(root,root,{config:{},routes:[]},{workers:2,maxMemoryMb:1024},resources,{
    killGraceMs:100,
    fork:(file,args,options)=>{
      const child=fork(file,args,options),kill=child.kill.bind(child);
      child.kill=signal=>{signals.push(signal);if(signal==='SIGTERM')return true;return kill(signal);};
      return child;
    },
  });
  try{
    await pool.prepare(2);const pids=pool.children.map(worker=>worker.child.pid);
    const work=pool.run('pages',{path:'/ignore-term',log,hang:true});const observed=work.catch(error=>error);
    for(let attempt=0;attempt<100;attempt++){if((await events(log).catch(()=>[])).length)break;await new Promise(resolve=>setTimeout(resolve,10));}
    await pool.abort(new Error('owner-cancelled'));
    assert.match((await observed).message,/owner-cancelled/);
    assert.ok(signals.includes('SIGTERM'));assert.ok(signals.includes('SIGKILL'));
    assert.ok(pids.every(pid=>!alive(pid)));
  }finally{await pool.close();}
}));

test('a lost manifest ACK from a real worker has a finite deadline and reaps the pool',async()=>fixture(async({root})=>{
  const pool=new PrerenderPool(root,root,{config:{},routes:[]},{workers:2,maxMemoryMb:1024},resources,{
    updateTimeoutMs:40,killGraceMs:50,
    fork:(file,args,options)=>{
      const child=fork(file,args,options),emit=child.emit.bind(child);
      child.emit=(event,...values)=>event==='message'&&values[0]?.type==='updated'?false:emit(event,...values);
      return child;
    },
  });
  try{
    await pool.prepare(2);const pids=pool.children.map(worker=>worker.child.pid);
    await assert.rejects(pool.prepare(2),/acknowledgement timed out/);
    await pool.close();assert.ok(pids.every(pid=>!alive(pid)));
  }finally{await pool.close();}
}));
