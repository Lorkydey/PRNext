import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatencyHistogram,readLatencyHistogram} from './latency-histogram.mjs';

test('retained histograms resolve sub-millisecond regressions and round upward',()=>{
  const baseline=createLatencyHistogram(),candidate=createLatencyHistogram();
  for(let i=0;i<100;i++){baseline.record(.6001);candidate.record(.6951);}
  assert.equal(baseline.quantile(.95),.601);assert.equal(candidate.quantile(.95),.696);
  assert.ok(candidate.quantile(.95)/baseline.quantile(.95)>1.15);
  for(const value of [baseline,candidate]){
    const restored=readLatencyHistogram(JSON.parse(JSON.stringify(value.snapshot())));
    assert.equal(restored.count,100);assert.equal(restored.quantile(.95),value.quantile(.95));
  }
});
test('histograms retain full distributions, range boundaries and overflow',()=>{
  const histogram=createLatencyHistogram();
  for(const ms of [0,.001,100,100.001,12000,12000.001])histogram.record(ms);
  const restored=readLatencyHistogram(histogram.snapshot());
  assert.equal(restored.count,5);assert.equal(restored.overflow,1);
  assert.equal(restored.quantile(.8),100.1);assert.equal(restored.quantile(1),12000);
  for(const value of [NaN,-1,Infinity])assert.throws(()=>histogram.record(value));
});
test('corrupt, inflated, miscounted and incompatible retained histograms fail closed',()=>{
  const histogram=createLatencyHistogram();histogram.record(.5);const snapshot=histogram.snapshot();
  for(const patch of [{count:2},{unit:'milliseconds'},{fineLimit:10},{data:'not base64'},{overflow:-1}])assert.throws(()=>readLatencyHistogram({...snapshot,...patch}));
  assert.equal(readLatencyHistogram(createLatencyHistogram().snapshot()).quantile(.95),null);
});
