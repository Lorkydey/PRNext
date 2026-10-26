import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {binary} from './support.mjs';
import {DevGateway} from '../packages/prnext/runtime/dev-gateway.mjs';
import {publishDependencyGraph,affectedDependencies} from '../packages/prnext/runtime/dev-dependency-graph.mjs';

test('native batched graph keeps the listener alive above 64 KiB and atomically replaces dependencies',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-native-graph-'));let fatal;
  const gateway=new DevGateway(binary,root,{hostname:'127.0.0.1',port:0,onEnsure:()=>({}),onOpen:()=>{},onClose:()=>{},onFatal:error=>{fatal=error;}});
  t.after(async()=>{await gateway.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});await gateway.ready;
  const files=Array.from({length:12000},(_,i)=>`components/deep/shared-component-${i}.tsx`);
  const records=files.map((file,i)=>({route:file,module:true,files:[file,...i?[files[i-1]]:[]]}));
  const manifest={buildId:'large-graph',devDependencies:[{route:'/wide',files},{route:'/other',files:[files[500]]}],devModules:records};
  assert.ok(Buffer.byteLength(JSON.stringify(manifest))>65536);
  const stats=await publishDependencyGraph(gateway,manifest);assert.equal(stats.files,12000);assert.ok(stats.bytes<16*1024*1024);
  const result=await affectedDependencies(gateway,[files[0]]);assert.equal(result.complete,false,'large transitive result conservatively requests a complete refresh');
  const direct=await gateway.request('affected',{files:[files[500]]});assert.deepEqual(direct.routes,['/other','/wide']);
  await gateway.request('graph-begin',{transaction:'incomplete',files:1,records:1,edges:1});
  await gateway.request('graph-files',{transaction:'incomplete',files:['new.ts']});
  await assert.rejects(gateway.request('graph-commit',{transaction:'incomplete'}),/Incomplete/);
  assert.deepEqual((await gateway.request('affected',{files:[files[500]]})).routes,['/other','/wide']);
  await gateway.request('graph-abort',{transaction:'incomplete'});
  await publishDependencyGraph(gateway,{buildId:'replacement',devDependencies:[{route:'/new',files:['new.ts']}]});
  assert.deepEqual((await gateway.request('affected',{files:[files[500]]})).unknown,[files[500]]);
  assert.deepEqual((await gateway.request('affected',{files:['new.ts']})).routes,['/new']);assert.equal(fatal,undefined);
});
