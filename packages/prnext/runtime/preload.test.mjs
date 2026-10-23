import test from 'node:test';
import assert from 'node:assert/strict';
import {preloadModules} from './preload.mjs';
test('preloading observes elapsed time and RSS budgets between imports',async()=>{
  const loaded=[];
  assert.equal(await preloadModules(['one','two'],{maxRssMb:0,timeoutMs:1000},file=>loaded.push(file)),0);
  assert.deepEqual(loaded,[]);
  assert.equal(await preloadModules(['one','two'],{maxRssMb:2048,timeoutMs:5},async file=>{loaded.push(file);await new Promise(resolve=>setTimeout(resolve,15));}),1);
  assert.equal(loaded.length,1);
});
