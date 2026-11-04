import test from 'node:test';
import assert from 'node:assert/strict';
import { soakSettings, qualifySaasSoak } from './soak.mjs';

test('release endurance always defaults to two hours and requires explicit execution',async()=>{
  const settings=soakSettings([]);assert.equal(settings.seconds,7200);assert.equal(settings.diagnostic,false);assert.equal(settings.run,false);
  await assert.rejects(qualifySaasSoak(settings),/opt-in/);
  assert.equal(soakSettings(['--run']).run,true);
});

test('a shortened endurance run is always explicitly diagnostic and cannot impersonate the release duration',()=>{
  for(const seconds of ['1','30','7199']){
    const settings=soakSettings(['--run','--diagnostic-seconds',seconds]);assert.equal(settings.diagnostic,true);assert.equal(settings.seconds,Number(seconds));
  }
  for(const seconds of ['0','-1','1.5','7200','7201','NaN','Infinity'])assert.throws(()=>soakSettings(['--diagnostic-seconds='+seconds]),/diagnostic duration/);
  assert.throws(()=>soakSettings(['--seconds','30']),/Unknown option/);
  for(const affinity of ['0','0,0','0-1','0,1,2','0,65536','-1,0'])assert.throws(()=>soakSettings(['--affinity='+affinity]),/two distinct CPU/);
  assert.equal(soakSettings(['--affinity=0,1']).affinity,'0,1');
});
