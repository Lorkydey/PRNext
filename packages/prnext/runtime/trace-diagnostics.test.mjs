import test from 'node:test';
import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';

let imports=0;
async function isolated(t,fetcher){
  const originalFetch=globalThis.fetch,originalEndpoint=process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const originalProtocol=process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL,originalDisabled=process.env.OTEL_SDK_DISABLED;
  globalThis.fetch=fetcher;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT='http://collector.invalid/private-secret';
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL='http/json';delete process.env.OTEL_SDK_DISABLED;
  const trace=await import(`./trace.mjs?diagnostic-test=${++imports}`);
  globalThis.fetch=originalFetch;
  const restore=(key,value)=>{if(value===undefined)delete process.env[key];else process.env[key]=value;};
  restore('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',originalEndpoint);restore('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',originalProtocol);restore('OTEL_SDK_DISABLED',originalDisabled);
  t.after(()=>trace.drainTraces());
  return trace;
}

test('trace queue overload remains bounded, counts every dropped span and publishes credential-free diagnostics',async t=>{
  const requests=[],events=[],warnings=[];
  const trace=await isolated(t,async(_,init)=>{requests.push(JSON.parse(init.body));return new Response('{}');});
  const diagnostics=channel('prnext.telemetry'),listener=value=>events.push(value);diagnostics.subscribe(listener);t.after(()=>diagnostics.unsubscribe(listener));
  t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
  await Promise.all(Array.from({length:1100},()=>trace.withTrace({headers:{cookie:'private-user-secret'}},'request',async()=>({status:200}))));
  assert.equal(trace.telemetryDiagnostics().queuedSpans,1024);assert.equal(trace.telemetryDiagnostics().droppedSpans,76);
  await trace.drainTraces();
  assert.deepEqual(trace.telemetryDiagnostics(),{enabled:true,queuedSpans:0,droppedSpans:76,rejectedSpans:0,exportAttempts:8,exportFailures:0,failedBatches:0,exportedSpans:1024});
  assert.equal(requests.length,8);assert.ok(requests.every(body=>body.resourceSpans[0].scopeSpans[0].spans.length<=128));
  assert.equal(warnings.length,1,'Warnings must be rate limited independently of the exporter');
  assert.equal(events.filter(value=>value.reason==='queue_full').length,76);
  assert.ok(!JSON.stringify({events,warnings,requests}).includes('private-user-secret'));
  assert.ok(!JSON.stringify({events,warnings}).includes('private-secret'));
});

test('permanent collector rejection counts loss once and never retries HTTP400 or changes the request response',async t=>{
  let requests=0;t.mock.method(console,'error',()=>{});
  const trace=await isolated(t,async()=>{requests++;return new Response('{}',{status:400});});
  const result=await trace.withTrace({},'request',async()=>({status:201}));assert.equal(result.status,201);
  await trace.flushTraces();
  assert.equal(requests,1);
  assert.deepEqual(trace.telemetryDiagnostics(),{enabled:true,queuedSpans:0,droppedSpans:1,rejectedSpans:0,exportAttempts:1,exportFailures:1,failedBatches:1,exportedSpans:0});
});

test('temporary collector failures have bounded retries and recovery counts delivered spans',async t=>{
  let requests=0;
  const trace=await isolated(t,async()=>new Response('{}',{status:++requests<3?503:200}));
  await trace.withTrace({},'request',async()=>({status:200}));
  const keepAlive=setInterval(()=>{},1000);try{await trace.flushTraces();}finally{clearInterval(keepAlive);}
  assert.equal(requests,3);
  assert.deepEqual(trace.telemetryDiagnostics(),{enabled:true,queuedSpans:0,droppedSpans:0,rejectedSpans:0,exportAttempts:3,exportFailures:2,failedBatches:0,exportedSpans:1});
});

test('network failures exhaust only three attempts, and unsampled spans are not counted as drops',async t=>{
  let requests=0;t.mock.method(console,'error',()=>{});
  const trace=await isolated(t,async()=>{requests++;throw Error('private transport credentials');});
  await trace.withTrace({traceparent:'00-'+'1'.repeat(32)+'-'+'2'.repeat(16)+'-00'},'unsampled',async()=>{});
  assert.equal(trace.telemetryDiagnostics().queuedSpans,0);assert.equal(trace.telemetryDiagnostics().droppedSpans,0);
  await trace.withTrace({},'sampled',async()=>{});
  const keepAlive=setInterval(()=>{},1000);try{await trace.flushTraces();}finally{clearInterval(keepAlive);}
  assert.equal(requests,3);assert.equal(trace.telemetryDiagnostics().failedBatches,1);assert.equal(trace.telemetryDiagnostics().droppedSpans,1);
});

test('OTLP partial success counts accepted and rejected spans without replaying or logging collector messages',async t=>{
  let requests=0;const warnings=[];t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
  const trace=await isolated(t,async()=>{requests++;return new Response(JSON.stringify({partialSuccess:{rejectedSpans:'2',errorMessage:'private collector credentials'}}));});
  await Promise.all(Array.from({length:3},()=>trace.withTrace({},'request',async()=>{})));await trace.flushTraces();
  assert.equal(requests,1);
  assert.deepEqual(trace.telemetryDiagnostics(),{enabled:true,queuedSpans:0,droppedSpans:2,rejectedSpans:2,exportAttempts:1,exportFailures:1,failedBatches:1,exportedSpans:1});
  assert.ok(warnings.some(value=>value.includes('collector_rejected')));assert.ok(!warnings.join('').includes('private collector credentials'));
});

test('malformed, oversized and impossible successful collector acknowledgements are bounded and never replayed',async t=>{
  t.mock.method(console,'error',()=>{});
  for(const body of ['not JSON',' '.repeat(16385),'{"partialSuccess":{"rejectedSpans":"2"}}','{"partialSuccess":{"rejectedSpans":-1}}']){
    let requests=0;const trace=await isolated(t,async()=>{requests++;return new Response(body);});
    await trace.withTrace({},'request',async()=>{});await trace.flushTraces();
    assert.equal(requests,1);assert.equal(trace.telemetryDiagnostics().droppedSpans,1);assert.equal(trace.telemetryDiagnostics().exportedSpans,0);assert.equal(trace.telemetryDiagnostics().failedBatches,1);
  }
});
