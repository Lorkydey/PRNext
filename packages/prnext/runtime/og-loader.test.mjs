import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { createElement } from 'react';
import { ImageResponse } from '../compat/og.cjs';

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
