import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encodePresentationPacket,presentationPacketReader} from './presentation-packet.mjs';

test('adaptive packets preserve scalar values and select binary only for substantial estimated savings',()=>{
  const scalars=[null,undefined,0,-0,NaN,Infinity,-Infinity,'é漢字😀','\ud800','< & \"\u0000'];
  const flat=encodePresentationPacket(scalars);assert.ok(flat.__prnextFlat);scalars.forEach((x,i)=>assert.ok(Object.is(presentationPacketReader(flat).at(i),x)));
  const values=Array.from({length:2048},(_,i)=>i%3===0?('repeated long display value <&> '.repeat(10)):scalars[i%scalars.length]);
  const binary=encodePresentationPacket(values);assert.ok(binary.__prnextBinary);const reader=presentationPacketReader(binary);values.forEach((x,i)=>assert.ok(Object.is(reader.at(i),x)));
  assert.throws(()=>reader.at(-1),/offset/);assert.throws(()=>reader.range(0,values.length+1),/range/);
  assert.throws(()=>presentationPacketReader({__prnextBinary:[new Uint8Array(1),new Float64Array(2),[]]}));
});

test('binary display packets survive the actual official Flight codec without reconstruction of rows',async()=>{
  const script=`import assert from'node:assert/strict';import{renderToReadableStream}from'react-server-dom-webpack/server.node';import{createFromReadableStream}from'react-server-dom-webpack/client.edge';import{encodePresentationPacket,presentationPacketReader}from ${JSON.stringify(new URL('./presentation-packet.mjs',import.meta.url).href)};const values=Array.from({length:1024},(_,i)=>i%5===0?-0:'Unicode é漢字😀 & < '.repeat(20));const packet=encodePresentationPacket(values);assert.ok(packet.__prnextBinary);const decoded=await createFromReadableStream(renderToReadableStream(packet,{}),{serverConsumerManifest:{moduleMap:{},serverModuleMap:null,moduleLoading:null}});const reader=presentationPacketReader(decoded);values.forEach((v,i)=>assert.ok(Object.is(reader.at(i),v)));`;
  await promisify(execFile)(process.execPath,['--conditions=react-server','--input-type=module','-e',script],{env:{...process.env,NODE_ENV:'production'},timeout:30000});
});
