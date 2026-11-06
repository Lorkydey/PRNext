import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlightMeasurement} from './flight-diagnostics.mjs';

test('disabled Flight diagnostics never inspect requests, allocate a clock or export events', () => {
  const request = new Proxy({}, {get() { throw Error('request accessed'); }});
  assert.equal(createFlightMeasurement(request, 'ssr', {enabled:false, now(){throw Error('clock');}, record(){throw Error('export');}}), undefined);
});

test('Flight samples record byte counts, waiting milestones and exactly one terminal outcome without private request data', () => {
  const events = []; let time = 10;
  const sample = createFlightMeasurement({routePattern:'/accounts/[id]', method:'GET',
    url:'https://private.test/accounts/secret?token=secret', headers:{cookie:'secret'}, nonce:'secret'}, 'ssr',
  {enabled:true, now:()=>time, record:(type, value)=>events.push({type, ...value})});
  time=15; sample.chunk(1024); sample.peakQueuedBytes=1024;
  time=20; sample.mark('modelReady'); time=25; sample.mark('shellReady');
  sample.chunk(256); sample.responseBytes=2300;
  time=40; sample.finish('completed',200); sample.finish('cancelled'); sample.chunk(99);
  assert.deepEqual(events,[{type:'flight',route:'/accounts/[id]',method:'GET',phase:'ssr',outcome:'completed',durationMs:30,
    flightBytes:1280,flightChunks:2,responseBytes:2300,peakQueuedBytes:1024,status:200,firstChunkMs:5,modelReadyMs:10,shellReadyMs:15}]);
  assert.equal(JSON.stringify(events).includes('secret'),false);
});

test('Flight diagnostics distinguish partial cancellation and do not let a failed recorder affect rendering', () => {
  let result;
  const sample=createFlightMeasurement({method:'CONNECT'},'rsc',{enabled:true,now:()=>0,record:(_,value)=>{result=value;throw Error('export');}});
  sample.partial('normalized'); sample.partial('untrusted'); sample.chunk(42);
  assert.doesNotThrow(()=>sample.finish('timedOut',504));
  assert.deepEqual(result,{route:'<unattributed>',method:'_OTHER',phase:'rsc',outcome:'timedOut',durationMs:0,
    flightBytes:42,flightChunks:1,responseBytes:0,peakQueuedBytes:0,status:504,firstChunkMs:0,ppr:'normalized'});
});
