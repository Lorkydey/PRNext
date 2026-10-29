import test from 'node:test';
import assert from 'node:assert/strict';
import {flightTap} from './flight-tap.mjs';

test('SSR bootstrap groups available bytes without changing the decoder stream',async()=>{
  const chunks=Array.from({length:80},(_,n)=>new Uint8Array(2048).fill(n));
  const tap=flightTap(new ReadableStream({start(c){for(const b of chunks)c.enqueue(b);c.close();}}));
  const decoded=Buffer.from(await new Response(tap.body).arrayBuffer());tap.startOutput();
  const output=[];for(;;){const x=await tap.next();if(x.done)break;output.push(x.value);}
  assert.equal(output.length,5);assert.deepEqual(Buffer.concat(output),decoded);
});
test('SSR tap publishes a shell chunk before a delayed source and cancellation is idempotent',async()=>{
  let pulls=0,cancels=0;
  const tap=flightTap(new ReadableStream({pull(c){if(++pulls===1)c.enqueue(new Uint8Array([1,2]));},cancel(){cancels++;}},{highWaterMark:0}));
  const decoder=tap.body.getReader();await decoder.read();tap.startOutput();
  assert.deepEqual((await tap.next()).value,new Uint8Array([1,2]));assert.equal(pulls,1);
  await Promise.all([tap.cancel(),tap.cancel()]);assert.equal(cancels,1);assert.equal((await tap.next()).done,true);
});
