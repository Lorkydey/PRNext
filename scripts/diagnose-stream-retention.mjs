// Diagnostic only. Explicit GC distinguishes live chunk retention from V8 RSS.
// This script is not used to measure production throughput or CPU per response.
import {spawnSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {streamSelector} from '../packages/prnext/runtime/stream-select.mjs';

const variant=process.argv[2];
if(variant){
  assert.equal(typeof global.gc,'function');
  const collect=async()=>{for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}};
  await collect();const before=process.memoryUsage();
  let resolve;
  const stalled=new Promise(done=>{resolve=done;});
  const references=[];
  const selector=variant==='selector'?streamSelector():null;
  selector?.watch('flight',stalled);
  for(let i=0;i<4096;i++){
    const chunk=new Uint8Array(4096);chunk.fill(i%256);references.push(new WeakRef(chunk));
    if(selector){selector.watch('html',Promise.resolve({value:chunk,done:false}));assert.equal((await selector.next()).value[0],i%256);}
    else assert.equal((await Promise.race([Promise.resolve({type:'html',value:chunk,done:false}),stalled])).value[0],i%256);
  }
  await collect();const blocked=process.memoryUsage(),retained=references.filter(ref=>ref.deref()).length;
  resolve({type:'flight',done:true});if(selector){await selector.next();selector.close();}
  await collect();const released=process.memoryUsage();
  console.log(JSON.stringify({variant,chunks:4096,chunkBytes:4096,retainedChunksWhileOtherSourceStalled:retained,before,blocked,released}));
}else{
  const results=['race','selector'].map(mode=>{const child=spawnSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),mode],{encoding:'utf8',timeout:30000});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);});
  assert.equal(results[0].retainedChunksWhileOtherSourceStalled,4096);
  assert.ok(results[1].retainedChunksWhileOtherSourceStalled<=1);
  const output=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/runtime-resources');await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'stream-retention.json'),JSON.stringify({note:'Synthetic asymmetric stream, 16 MiB of chunks, forced GC only in this diagnostic; not a production RSS or throughput benchmark.',results},null,2)+'\n');
  console.log(results.map(r=>({variant:r.variant,retained:r.retainedChunksWhileOtherSourceStalled,liveBufferMiB:(r.blocked.arrayBuffers-r.before.arrayBuffers)/1024**2})));
}
