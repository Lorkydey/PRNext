import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {isMainModule} from '../../scripts/main-module.mjs';
import {createRedisCache} from '../../packages/prnext/compat/redis-cache.cjs';
import {spawnReferenceProcess} from './process.mjs';

async function bounded(promise,milliseconds,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
function connection(createClient,url){
  const client=createClient({url,disableOfflineQueue:true,commandsQueueMaxLength:16,socket:{connectTimeout:250,reconnectStrategy:false}});
  client.on('error',()=>{});return client;
}

/** Owned ephemeral Redis only. Persistence is disabled so restart changes incarnation. */
async function restartableRedis(createClient,executable){
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-cache-fault-'));
  let processHandle,closed=false,port,log='';
  const listener=createServer();
  try{
    await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    port=listener.address().port;await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  }catch(error){listener.close();await rm(directory,{recursive:true,force:true});throw error;}
  const url=`redis://127.0.0.1:${port}`;
  const start=async()=>{
    if(closed||processHandle)throw new Error('Invalid isolated Redis start state.');
    const owned=spawnReferenceProcess(executable,['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--protected-mode','yes','--dir',directory],{stdio:['ignore','pipe','pipe']});
    processHandle=owned;let exited=false;void owned.closed.then(()=>{exited=true;});
    for(const stream of [owned.child.stdout,owned.child.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-12000);});
    const until=performance.now()+5000;
    while(performance.now()<until){
      if(exited)throw new Error('The isolated Redis process exited before readiness.');
      const client=connection(createClient,url);
      try{await client.connect();await client.sendCommand(['PING'],{abortSignal:AbortSignal.timeout(500)});return;}
      catch{await delay(30);}
      finally{if(client.isOpen)client.destroy();}
    }
    throw new Error('The isolated Redis process exceeded its readiness deadline.');
  };
  const crash=async()=>{
    if(!processHandle)throw new Error('No owned Redis process is running.');
    const owned=processHandle;
    assert.ok(owned.child.kill('SIGKILL'),'the injected crash must reach the owned process');
    await bounded(owned.closed,5000,'The owned Redis process did not exit after crash.');
    processHandle=undefined;
  };
  const close=async()=>{
    closed=true;
    if(processHandle){await processHandle.stop();processHandle=undefined;}
    await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  };
  try{await start();return {url,start,crash,close,get diagnosticLog(){return log;}};}
  catch(error){await close();throw error;}
}

const value=text=>({tags:['products'],timestamp:Date.now(),stale:30,revalidate:60,expire:3600,value:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}})});
const read=async entry=>entry?new Response(entry.value).text():undefined;

export async function qualifyCacheFaults({outputDirectory,redisExecutable=process.env.PRNEXT_REDIS_SERVER||(process.platform==='win32'?undefined:'redis-server')}={}){
  if(!redisExecutable)throw new Error('Set PRNEXT_REDIS_SERVER to an isolated-test Redis executable.');
  // Resolve the existing locked integration client only when this campaign runs.
  const {createClient}=await import('../toolchain/node_modules/redis/dist/index.js');
  const report={version:1,complete:false,platform:process.platform,node:process.version,checks:[],scope:'disposable loopback Redis, no persistence, no application database'};
  let server,client,cache,primary;
  const namespace='fault-'+randomUUID();
  const handler=client=>createRedisCache({namespace,client,commandTimeoutMs:200,waitMs:200,leaseMs:1000});
  const checked=message=>report.checks.push(message);
  const save=async()=>{if(outputDirectory){await mkdir(outputDirectory,{recursive:true});await writeFile(path.join(outputDirectory,'cache-faults.json'),JSON.stringify(report,null,2)+'\n');}};
  try{
    server=await restartableRedis(createClient,redisExecutable);client=connection(createClient,server.url);await client.connect();cache=handler(client);
    const info=await client.info('server');report.redisVersion=/^redis_version:([^\r\n]+)/m.exec(info)?.[1]||'unknown';
    const seed=await cache.acquire('seed');assert.equal(await cache.set('seed',Promise.resolve(value('before restart')),{lease:seed}),true);await seed.release();
    assert.equal(await read(await cache.get('seed')),'before restart');checked('Actual Redis stores and returns a pre-crash value.');
    const interrupted=await cache.acquire('interrupted');
    await client.sendCommand(['CLIENT','PAUSE','1000','ALL'],{abortSignal:AbortSignal.timeout(1000)});
    const started=performance.now();let finished=false;
    const pending=cache.set('interrupted',Promise.resolve(value('must not publish')),{lease:interrupted}).then(result=>({ok:true,result}),error=>({ok:false,code:error.code||error.name})).finally(()=>{finished=true;});
    await delay(10);assert.equal(finished,false,'the write must still be in flight when Redis crashes');
    await server.crash();const outcome=await bounded(pending,2000,'The interrupted Redis write did not fail within its budget.');
    report.interruptedWriteMs=Math.round((performance.now()-started)*100)/100;
    assert.equal(outcome.ok,false);assert.ok(report.interruptedWriteMs<2000);checked('A write interrupted by a real Redis process crash fails within two seconds.');
    await assert.rejects(bounded(cache.updateTags(['products'],{expire:0}),2000,'Disconnected invalidation did not terminate.'),error=>error.message!=='Disconnected invalidation did not terminate.');
    checked('Disconnected invalidation fails visibly instead of reporting success.');
    await cache.close();cache=undefined;if(client.isOpen)client.destroy();client=undefined;
    await server.start();client=connection(createClient,server.url);await client.connect();cache=handler(client);
    assert.equal(await cache.get('seed'),undefined);assert.equal(await cache.get('interrupted'),undefined);
    assert.equal(await cache.set('interrupted',Promise.resolve(value('obsolete producer')),{lease:interrupted}),false);
    const current=await cache.acquire('interrupted');assert.notEqual(current.incarnation,interrupted.incarnation);
    assert.equal(await cache.set('interrupted',Promise.resolve(value('recovered')),{lease:current}),true);
    assert.equal(await cache.set('interrupted',Promise.resolve(value('late obsolete producer')),{lease:interrupted}),false);
    await cache.release('interrupted',interrupted);assert.equal(await read(await cache.get('interrupted')),'recovered');await current.release();
    checked('A fresh Redis incarnation rejects old leases, including release and overwrite after a new producer publishes.');
    const invalidated=await cache.acquire('invalidated');await cache.updateTags(['products'],{expire:0});
    assert.equal(await cache.get('interrupted'),undefined);assert.equal(await cache.set('invalidated',Promise.resolve(value('invalidated producer')),{lease:invalidated}),false);await invalidated.release();
    const retry=await cache.acquire('invalidated');assert.equal(await cache.set('invalidated',Promise.resolve(value('explicit retry')),{lease:retry}),true);await retry.release();assert.equal(await read(await cache.get('invalidated')),'explicit retry');
    checked('Post-restart invalidation fences in-flight producers; a new explicit lease recovers normal reads and writes.');
    report.providerSha256=createHash('sha256').update(await readFile(new URL('../../packages/prnext/compat/redis-cache.cjs',import.meta.url))).digest('hex');
  }catch(error){primary=error;report.failure={name:error.name,message:error.message};}
  finally{
    try{await cache?.close();if(client?.isOpen)client.destroy();await server?.close();report.resourcesClosed=true;}
    catch(error){report.cleanupFailure=error.message;primary||=error;}
    report.complete=!primary;await save();
  }
  if(primary)throw primary;
  return report;
}

if(isMainModule(import.meta.url)){
  try{
    const {values}=parseArgs({options:{run:{type:'boolean'},'output-directory':{type:'string'}}});
    if(!values.run)throw new Error('Pass --run to start the disposable Redis fault campaign.');
    const report=await qualifyCacheFaults({outputDirectory:values['output-directory']&&path.resolve(values['output-directory'])});
    console.log(JSON.stringify(report,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
