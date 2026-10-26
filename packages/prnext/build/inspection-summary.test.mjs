import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDiagnostics,inspectionMetrics} from './inspection-summary.mjs';

test('diagnostics distinguish real zeros, missing data, stale processes and worker contention',()=>{
  const now=Date.now(), events=[{type:'http',route:'/users/[id]',method:'GET',time:now,durationMs:0,status:200},{type:'http',route:'/users/[id]',method:'GET',time:now+1,durationMs:2000,status:500},
    {type:'process',pid:1,time:now,rssBytes:100},{type:'process',pid:1,time:now,rssBytes:200},{type:'process',pid:2,time:now-60000,rssBytes:999}, {type:'wake',phase:'node-ready',durationMs:1500}];
  const report=summarizeDiagnostics(events,[{unixMs:now,workers:{queuedJobs:3,activeJobs:1}}]);
  assert.equal(report.summary.p50Ms,0);assert.equal(report.summary.p95Ms,2000);assert.equal(report.summary.workerRssBytes,200);assert.equal(report.summary.errors,1);
  assert.ok(report.findings.some(f=>f.code==='WORKER_QUEUE'));assert.ok(report.findings.some(f=>f.code==='SLOW_WAKE'));
  const stale=summarizeDiagnostics([],[{unixMs:now-60000,workers:{queuedJobs:100}}]);assert.equal(stale.summary.queuedJobs,null);assert.equal(stale.summary.p50Ms,null);assert.equal(stale.findings[0].code,'NO_SAMPLE');
});
test('OTLP uses seconds, valid histogram counts and a headers-only custom metric',()=>{
  const now=Date.now(), report={buildId:'build',...summarizeDiagnostics([0,10,1000,20000].map(durationMs=>({type:'http',route:'/api/[id]',method:'GET',time:now,durationMs,status:200})))};
  const metric=inspectionMetrics(report).resourceMetrics[0].scopeMetrics[0].metrics[0], point=metric.histogram.dataPoints[0];
  assert.equal(metric.name,'prnext.http.response.headers.duration');assert.equal(metric.unit,'s');assert.equal(point.count,'4');assert.equal(point.sum,21.01);assert.equal(point.bucketCounts.reduce((sum,v)=>sum+Number(v),0),4);assert.equal(point.max,20);
  assert.equal(inspectionMetrics({buildId:'empty'}).resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints.length,0);
});

test('request stages distinguish completion, cancellation and deadlines without unbounded labels',()=>{
  const time=Date.now(),events=[
    {type:'requestStage',stage:'admission',outcome:'completed',durationMs:20,time,headers:'secret'},
    {type:'requestStage',stage:'requestTotal',outcome:'completed',durationMs:100,time},
    {type:'requestStage',stage:'requestTotal',outcome:'cancelled',durationMs:5000,time},
    {type:'requestStage',stage:'requestTotal',outcome:'timedOut',durationMs:1000,time},
    {type:'requestStage',stage:'/private/user/123',outcome:'completed',durationMs:1,time},
    {type:'requestStage',stage:'admission',outcome:'private value',durationMs:1,time},
    {type:'requestStage',stage:'admission',outcome:'completed',durationMs:Infinity,time},
  ];
  const report=summarizeDiagnostics(events);
  assert.equal(report.summary.completedResponseP95Ms,100);
  assert.equal(report.summary.cancelledResponses,1);assert.equal(report.summary.timedOutResponses,1);
  assert.equal(report.stageSample.length,4);assert.equal(report.requestStages.length,2);
  assert.ok(!JSON.stringify(report).includes('secret'));assert.ok(!JSON.stringify(report).includes('/private'));
  const metric=inspectionMetrics(report).resourceMetrics[0].scopeMetrics[0].metrics[1];
  assert.equal(metric.name,'prnext.request.stage.duration');assert.equal(metric.unit,'s');
  assert.equal(metric.histogram.dataPoints.length,4);
  for(const point of metric.histogram.dataPoints)assert.equal(point.bucketCounts.reduce((n,v)=>n+Number(v),0),Number(point.count));
  assert.ok(report.findings.some(f=>f.code==='RESPONSE_DEADLINES'));
});

test('budget occupancy is current, allowlisted and unavailable in older or stale snapshots',()=>{
  const now=Date.now(),snapshot={unixMs:now,workers:{queuedJobs:0,budgets:[{budget:'inputBytes',limit:33554432,used:65536,waiting:2,peakUsed:65536,peakWaiting:2,acquired:1,rejected:0,timedOut:1,cancelledWaits:1,secret:'private'},{budget:'untrusted',limit:1}]}};
  const report=summarizeDiagnostics([],[snapshot]);
  assert.deepEqual(report.budgets,[{budget:'inputBytes',unit:'bytes',limit:33554432,used:65536,waiting:2,peakUsed:65536,peakWaiting:2,acquired:1,rejected:0,timedOut:1,cancelledWaits:1}]);
  assert.equal(summarizeDiagnostics([],[{...snapshot,unixMs:now-60000}]).budgets,null);
  assert.equal(summarizeDiagnostics([],[{unixMs:now,workers:{}}]).budgets,null);
});
