import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkerMemory} from './worker-memory.mjs';
test('production RSS policy is opt-in, bounded and cannot silently ignore a setting',()=>{
  assert.equal(validateWorkerMemory(),undefined);assert.equal(validateWorkerMemory(false),undefined);
  assert.deepEqual(validateWorkerMemory({maxRssMb:512}),{maxRssMb:512});
  for(const value of [true,null,[],{}, {maxRssMb:63},{maxRssMb:65537},{maxRssMb:256.5},{maxRssMb:512,forceKill:true}])assert.throws(()=>validateWorkerMemory(value));
});
