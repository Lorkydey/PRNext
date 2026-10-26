import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkerPreload} from './worker-preload.mjs';
test('worker preloading is explicit, bounded and rejects ambiguous configuration',()=>{
  assert.equal(validateWorkerPreload(undefined),undefined);assert.equal(validateWorkerPreload(false),undefined);
  assert.deepEqual(validateWorkerPreload({routes:['/','/api/test']}),{routes:['/','/api/test'],maxRssMb:256,timeoutMs:5000});
  for(const options of [{routes:[]},{routes:['/','/']},{routes:['/x?token=y']},{routes:['/'],maxRssMb:0},{routes:['/'],timeoutMs:Infinity},{routes:['/'],render:true}])assert.throws(()=>validateWorkerPreload(options));
});
