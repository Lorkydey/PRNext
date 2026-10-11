import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectConfig } from './config.mjs';
test('worker retirement accepts bounded explicit overrides and rejects ineffective options', () => {
  const workerRetirement={idleSeconds:0,laneIdleSeconds:5,keepWarm:true};
  assert.deepEqual(validateProjectConfig({workerRetirement}).workerRetirement,workerRetirement);
  for(const value of [null,[],false,{idleSeconds:-1},{idleSeconds:1.5},{idleSeconds:604801},{idleSeconds:'30'},{keepWarm:1},{typo:true}]) {
    assert.throws(()=>validateProjectConfig({workerRetirement:value}),/workerRetirement/);
  }
});
