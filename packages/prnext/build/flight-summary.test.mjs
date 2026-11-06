import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeFlight,flightSamples,flightMetrics} from './flight-summary.mjs';
import {summarizeDiagnostics,inspectionMetrics} from './inspection-summary.mjs';

const event=(fields={})=>({type:'flight',route:'/table/[id]',method:'GET',phase:'ssr',time:100,
  outcome:'completed',durationMs:10,flightBytes:1024,flightChunks:2,responseBytes:2048,peakQueuedBytes:512,...fields});

test('Flight summaries separate RSC/SSR and partial outcomes; only completed bytes enter quantiles',()=>{
  const source=[event(),event({flightBytes:3000}),event({outcome:'cancelled',flightBytes:20}),event({phase:'rsc',ppr:'normalized',flightBytes:5000})];
  const report=summarizeFlight(source),ssr=report.flight.find(value=>value.phase==='ssr');
  assert.equal(ssr.completed,2);assert.equal(ssr.cancelled,1);assert.equal(ssr.flightP95Bytes,3000);
  assert.equal(ssr.flightP50Bytes,1024);assert.equal(ssr.modelReadyP95Ms,null);
  assert.equal(report.flight[0].normalizedPprSamples,1);
  const partial=summarizeFlight([event({outcome:'timedOut'})]).flight[0];
  assert.equal(partial.flightP95Bytes,null);assert.equal(partial.timedOut,1);
});

test('Flight diagnostic schema discards invalid samples and extra private properties; cardinality is bounded',()=>{
  const valid=event({body:'secret',url:'secret',headers:{cookie:'secret'},ppr:'unknown'});
  const bad=[{phase:'unknown'},{flightBytes:Infinity},{responseBytes:-1},{durationMs:NaN},{time:-1},{route:'/bad\nroute'},{flightChunks:1.5}].map(fields=>event(fields));
  const sample=flightSamples([valid,...bad]);assert.equal(sample.length,1);assert.equal(JSON.stringify(sample).includes('secret'),false);
  assert.equal('ppr' in sample[0],false);
  assert.equal(summarizeFlight(Array.from({length:300},(_,i)=>event({route:'/r'+i}))).flight.length,256);
});

test('Flight byte histograms retain units, phase, counts and completion-only semantics',()=>{
  const source=[event(),event({flightBytes:2048,time:101}),event({outcome:'cancelled',flightBytes:8000000}),event({phase:'rsc'})];
  const metric=flightMetrics(source),points=metric.histogram.dataPoints;
  assert.equal(metric.unit,'By');assert.equal(points.length,2);
  assert.equal(points[0].count,'2');assert.equal(points[0].sum,3072);
  assert.equal(points[0].bucketCounts.reduce((a,b)=>a+Number(b),0),2);
  const report=summarizeDiagnostics(source);
  const exported=inspectionMetrics(report).resourceMetrics[0].scopeMetrics[0].metrics.find(value=>value.name==='prnext.flight.response.size');
  assert.deepEqual(exported,metric);
});

test('large Flight advice requires multiple completed samples and remains a diagnostic hint',()=>{
  const source=[event({flightBytes:150000}),event({flightBytes:150000}),event({flightBytes:150000})];
  assert.equal(summarizeDiagnostics(source).findings.filter(value=>value.code==='LARGE_FLIGHT').length,1);
  assert.equal(summarizeDiagnostics(source.slice(0,2)).findings.some(value=>value.code==='LARGE_FLIGHT'),false);
});
