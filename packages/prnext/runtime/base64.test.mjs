import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {decodeBase64} from '../compat/base64.cjs';
test('initial Flight base64 decodes exact binary bytes with native and fallback implementations',()=>{
  const original=Uint8Array.fromBase64;
  try{
    for(const size of [0,1,2,3,1024,150561]){
      const bytes=randomBytes(size),value=bytes.toString('base64');
      Uint8Array.fromBase64=undefined;assert.deepEqual(Buffer.from(decodeBase64(value)),bytes);
      Uint8Array.fromBase64=text=>{const decoded=Buffer.from(text,'base64');return new Uint8Array(decoded.buffer,decoded.byteOffset,decoded.byteLength);};
      assert.deepEqual(Buffer.from(decodeBase64(value)),bytes);
    }
  }finally{Uint8Array.fromBase64=original;}
});
