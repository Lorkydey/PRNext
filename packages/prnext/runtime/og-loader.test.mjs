import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createElement } from 'react';
import { ImageResponse } from '../compat/og.cjs';
import { loadImageRenderer } from './og-loader.mjs';

// Construct WOFF from the shipped licensed font so the compressed-font path
// actually executes the patched inflater, without network or extra fixtures.
function woff(ttf) {
  const count=ttf.readUInt16BE(4),tables=[];let offset=44+20*count;
  for(let i=0;i<count;i++){
    const record=ttf.subarray(12+i*16,28+i*16),start=record.readUInt32BE(8),length=record.readUInt32BE(12);
    const raw=ttf.subarray(start,start+length),compressed=deflateSync(raw),data=compressed.length<length?compressed:raw;
    tables.push({record,data,offset,length});offset+=Math.ceil(data.length/4)*4;
  }
  const out=Buffer.alloc(offset);out.write('wOFF');ttf.copy(out,4,0,4);out.writeUInt32BE(offset,8);out.writeUInt16BE(count,12);out.writeUInt32BE(ttf.length,16);out.writeUInt16BE(1,20);
  tables.forEach(({record,data,offset,length},i)=>{const at=44+20*i;record.copy(out,at,0,4);out.writeUInt32BE(offset,at+4);out.writeUInt32BE(data.length,at+8);out.writeUInt32BE(length,at+12);record.copy(out,at+16,4,8);data.copy(out,offset)});
  return out;
}
test('packaged ImageResponse renders default and compressed WOFF fonts with the patched inflater',async()=>{
 const font=woff(await readFile(new URL('./og/Geist-Regular.ttf',import.meta.url)));
 for(const fonts of [undefined,[{name:'Test',data:font,weight:400,style:'normal'}]]){
  const response=new ImageResponse(createElement('div',{style:{display:'flex',fontSize:32,...(fonts?{fontFamily:'Test'}:{})}},'PRNext'),{width:300,height:100,...(fonts?{fonts}:{})});
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.ok(bytes.length>100);
 }
});

test('the OG loader renders PNG with exact dimensions and compatibility cancellation settles', async () => {
 const {ImageResponse: Render} = await loadImageRenderer();
 const response = new Render(createElement('div', {style: {display: 'flex', fontSize: 24}}, 'Loader'), {width: 240, height: 80});
 const bytes = Buffer.from(await response.arrayBuffer());
 assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
 assert.equal(bytes.readUInt32BE(16), 240);
 assert.equal(bytes.readUInt32BE(20), 80);
 const cancelled = new ImageResponse(createElement('div', {style: {display: 'flex'}}, 'Cancelled'), {width: 60, height: 30});
 await cancelled.body.cancel('consumer closed');
 assert.equal(cancelled.body.locked, false);
});

test('the shipped renderer refuses an unpatched optional SVG backend and uses adjacent WASM after relocation', async t => {
 const root = await mkdtemp(path.join(tmpdir(), 'prnext-og-svg-backend-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 await cp(new URL('./og/', import.meta.url), path.join(root, 'renderer'), {recursive: true});
 await mkdir(path.join(root, 'node_modules/sharp'), {recursive: true});
 await writeFile(path.join(root, 'node_modules/sharp/package.json'), '{"name":"sharp","type":"module","main":"index.mjs"}');
 await writeFile(path.join(root, 'node_modules/sharp/index.mjs'), `function forbidden(){throw Error('unpatched SVG backend was called')}forbidden.versions={rsvg:'2.63.1'};export default forbidden;`);
 const {ImageResponse: Render} = await import(pathToFileURL(path.join(root, 'renderer/index.node.mjs')).href);
 const response = new Render(createElement('div', {style: {display: 'flex', fontSize: 24}}, 'Safe fallback'), {width: 240, height: 80});
 const bytes = Buffer.from(await response.arrayBuffer());
 assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
 assert.equal(bytes.readUInt32BE(16), 240);
 assert.equal(bytes.readUInt32BE(20), 80);
});
