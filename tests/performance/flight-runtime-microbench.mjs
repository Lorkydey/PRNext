// Opt-in allocation/encoding probe, not an HTTP benchmark or a gain promise.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { flightBootstrap } from '../../packages/prnext/runtime/html-envelope.mjs';
import { workerStreamChannel } from '../../packages/prnext/runtime/app-stream-channel.mjs';

const {values}=parseArgs({options:{run:{type:'boolean'},iterations:{type:'string'}},allowPositionals:false});
if(!values.run)console.log('Opt-in: node tests/performance/flight-runtime-microbench.mjs --run --iterations 1000. This is not an HTTP performance result.');
else{
  const iterations=Number(values.iterations??1000);assert.ok(Number.isSafeInteger(iterations)&&iterations>0&&iterations<=20000);
  const nonce=' nonce="benchmark"',legacy=value=>Buffer.from(`<script${nonce}>(self.__PRNEXT_FLIGHT_STREAM__||=[]).push("${Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')}");document.currentScript.remove()</script>`);
  const samples=[];let checksum=0;
  for(const bytes of[128,2048,32768])for(const chunksPerResponse of[1,8]){
    const input=Uint8Array.from({length:bytes},(_,index)=>index%251),expected=legacy(input);
    assert.deepEqual(flightBootstrap(nonce)(input),expected);
    const cases={legacy:[],candidate:[]};
    for(let repetition=0;repetition<5;repetition++)for(const mode of(repetition%2?['candidate','legacy']:['legacy','candidate'])){
      const started=performance.now(),cpu=process.cpuUsage();
      for(let response=0;response<iterations;response++){
        const encode=mode==='candidate'?flightBootstrap(nonce):legacy;
        for(let chunk=0;chunk<chunksPerResponse;chunk++){const output=encode(input);checksum=(checksum+output.length+output[0]+output[output.length-1])>>>0;}
      }
      const used=process.cpuUsage(cpu);cases[mode].push({elapsedMs:performance.now()-started,cpuMs:(used.user+used.system)/1000});
    }
    const median=items=>[...items].sort((a,b)=>a-b)[Math.floor(items.length/2)];
    samples.push({inputBytes:bytes,chunksPerResponse,iterations,outputBytes:expected.length,cases,elapsedRatio:median(cases.candidate.map(row=>row.elapsedMs))/median(cases.legacy.map(row=>row.elapsedMs))});
  }
  // Actual channel calls, with synchronous structured-clone transfer semantics.
  // This counts transient envelope/list identities rather than pretending to
  // model MessagePort scheduling or network throughput.
  const envelopes=new Set(),lists=new Set();let frames=0,writer;
  writer=workerStreamChannel({postMessage(message,transfer){envelopes.add(message);lists.add(transfer);const copy=structuredClone(message,{transfer});assert.equal(copy.byteLength,1);frames++;writer.credit();}},1);
  writer.start({status:200});for(let index=0;index<1000;index++)await writer.write(new Uint8Array([index%251]),undefined,index===999);
  console.log(JSON.stringify({kind:'flight-runtime-allocation-microbench-v1',node:process.version,platform:process.platform,samples,checksum,structural:{frames,messageEnvelopeIdentities:envelopes.size,transferListIdentities:lists.size,legacyPerFrameObjects:2},limits:['Local encoding/allocation microprobe; no HTTP, latency, bandwidth or application gain is qualified.','Process CPU includes runtime/GC; short measurements are sensitive to order/JIT/host noise.','Structural clone model counts actual emitted object identities, not native MessagePort allocations or timings.']},null,2));
}
