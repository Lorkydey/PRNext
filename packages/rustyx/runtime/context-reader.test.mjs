import test from 'node:test';
import assert from 'node:assert/strict';
import {optionalRequestContext} from '../compat/data-cache.cjs';
import {dynamicUsage,staticParams} from '../compat/static-generation.cjs';
import {runRequestContext,currentRequest} from '../compat/headers.cjs';

test('memoized context readers remain live across overlapping requests and calls outside a scope',async()=>{
 assert.equal(optionalRequestContext(),undefined);assert.equal(dynamicUsage('outside'),true);
 await Promise.all(['Ada','Lin'].map(name=>runRequestContext({url:'http://localhost/'+name,phase:'render',cacheConfig:{dynamic:name==='Ada'?'force-static':'auto'}},async()=>{
  const context=currentRequest();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(optionalRequestContext(),context);assert.equal(optionalRequestContext().url,'http://localhost/'+name);
  assert.equal(dynamicUsage('test'),name!=='Ada');assert.deepEqual(await staticParams({name}),{name});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(optionalRequestContext(),context);
 })));
 assert.equal(optionalRequestContext(),undefined);assert.equal(dynamicUsage('outside again'),true);
});
