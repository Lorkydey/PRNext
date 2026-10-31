import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {flightDeltaFixtures} from './flight-delta-profile.mjs';

test('Flight profile fixtures are deterministic and cover useful, compressed, tiny and oversized first chunks',()=>{
  const fixtures=flightDeltaFixtures(),second=flightDeltaFixtures();
  const hash=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(new Set(fixtures.map(value=>value.name)).size,4);
  assert.deepEqual(fixtures.map(value=>[hash(value.base),...value.parts.map(hash)]),second.map(value=>[hash(value.base),...value.parts.map(hash)]));
  const tiny=fixtures.find(value=>value.name==='tiny-first-chunk');
  assert.ok(tiny.parts[0].length<32);assert.equal(tiny.base.length,2*1024*1024);
  assert.ok(fixtures.find(value=>value.name==='gzip-repeated-rows').parts[0].length<=64*1024);
  assert.ok(fixtures.find(value=>value.name==='oversized-probe-chunk').parts[0].length>64*1024);
  for(const fixture of fixtures)assert.ok(fixture.parts.reduce((sum,value)=>sum+value.length,0)<=16*1024*1024);
});
