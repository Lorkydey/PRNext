import test from 'node:test';
import assert from 'node:assert/strict';
import {encode,decode,MAX_VALUE,MAX_META} from '../compat/cache-wire.cjs';

test('cache framing preserves opaque values including empty, null bytes and the full size limit',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from([0,255,128,123,34]),Buffer.alloc(MAX_VALUE,0xab)]){
    const request=Buffer.concat(encode({op:'commit',key:'a'.repeat(64),lease:'b'.repeat(64),value:bytes}));
    const n=request.readUInt32BE();const metadata=JSON.parse(request.subarray(4,n+4));
    assert.equal(metadata.value,undefined);assert.deepEqual(request.subarray(n+4),bytes);
    const json=Buffer.from(JSON.stringify({state:'fresh',value:true})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(json.length);
    assert.deepEqual(decode(Buffer.concat([prefix,json,bytes])).value,bytes);
  }
});
test('cache framing rejects truncation, ambiguity and over-limit payloads before returning a value',()=>{
  const frame=(metadata,raw=Buffer.alloc(0))=>{const json=Buffer.from(JSON.stringify(metadata)),head=Buffer.alloc(4);head.writeUInt32BE(json.length);return Buffer.concat([head,json,raw]);};
  for(const value of [Buffer.alloc(0),Buffer.from([0,0,0,9,123]),frame(null),frame([]),frame({value:'base64'}),frame({state:'pending'},Buffer.from('x')),frame({value:true},Buffer.alloc(MAX_VALUE+1))]) assert.throws(()=>decode(value));
  const head=Buffer.alloc(4);head.writeUInt32BE(MAX_META+1);assert.throws(()=>decode(head));
  assert.throws(()=>encode({op:'commit',value:Buffer.alloc(MAX_VALUE+1)}));
  assert.throws(()=>encode({op:'read',value:Buffer.alloc(0)}));
  assert.throws(()=>encode({op:'commit',value:'not bytes'}));
  assert.throws(()=>encode({op:'commit'}));
});
