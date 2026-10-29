import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeInstrumentation,withInstrumentation,reportRequestError} from './instrumentation.mjs';
import {parseTraceparent,propagatedFetch,withTrace,currentTraceparent} from './trace.mjs';

test('Register runs exactly once across concurrent initializations, before request code',async()=>{
  let calls=0,loaded=0;
  const options={loader:async()=>{loaded++;return {async register(){calls++;await new Promise(r=>setTimeout(r,10));}};}};
  await Promise.all(Array.from({length:20},()=>initializeInstrumentation('/once',{instrumentation:{node:'hook.mjs'}},options)));
  assert.equal(calls,1);assert.equal(loaded,1);
});
test('Initialization errors stay failed and cannot execute application callbacks',async()=>{
  let calls=0;const options={loader:async()=>({register(){calls++;throw Error('startup failed');}})};
  for(let n=0;n<2;n++)await assert.rejects(initializeInstrumentation('/failure',{instrumentation:{node:'hook.mjs'}},options),/startup failed/);
  assert.equal(calls,1);
});
test('Error hooks await completion, deduplicate and preserve router context',async()=>{
  const records=[],error=Error('real failure');
  const module={async onRequestError(...args){await new Promise(r=>setTimeout(r,10));records.push(args);}};
  await assert.rejects(withInstrumentation({url:'http://local/blog?preview=1',headers:{'x-test':'yes'},method:'POST',route:{router:'app',pattern:'/blog',kind:'api'}},()=>{reportRequestError(error);throw error;},{module}),/real failure/);
  assert.equal(records.length,1);assert.equal(records[0][0],error);assert.equal(records[0][1].path,'/blog?preview=1');assert.equal(records[0][2].routeType,'route');assert.equal(records[0][2].routerKind,'App Router');
});
test('Concurrent requests keep separate errors, and navigation controls are excluded',async()=>{
  const records=[],module={onRequestError(error,request){records.push([error.message,request.path]);}};
  await Promise.all(['/a','/b'].map(url=>withInstrumentation({url:'http://local'+url},async()=>{
    await new Promise(r=>setTimeout(r,url==='/a'?15:2));reportRequestError(Error(url));reportRequestError({digest:'NEXT_HTTP_ERROR_FALLBACK;404'});
  },{module})));
  assert.deepEqual(records.sort(),[['/a','/a'],['/b','/b']]);
});
test('Reporting failure preserves the original application error',async()=>{
  const original=Error('application error');
  await assert.rejects(withInstrumentation({url:'http://local/'},()=>{throw original;},{module:{onRequestError(){throw Error('collector unavailable');}}}),error=>error===original);
});
test('Error context preserves the native regeneration reason rather than guessing from render mode',async()=>{
  for(const reason of ['on-demand','stale',undefined]){
    let captured;
    await withInstrumentation({url:'http://local/',renderMode:'isr',revalidateReason:reason},()=>reportRequestError(Error('regeneration')),{module:{onRequestError(_,__,context){captured=context.revalidateReason;}}});
    assert.equal(captured,reason);
  }
});
test('Routing controls, expected static bailouts and visitor cancellation do not report app failures',async()=>{
  let errors=0;const module={onRequestError(){errors++;}};
  for(const error of [{digest:'NEXT_HTTP_ERROR_FALLBACK;404'},{digest:'BAILOUT_TO_CLIENT_SIDE_RENDERING'},{code:'PRNEXT_DYNAMIC_SERVER_USAGE'},{code:'PRNEXT_PPR_DYNAMIC'}])
    await assert.rejects(withInstrumentation({url:'http://local/'},()=>{throw error;},{module}),value=>value===error);
  const controller=new AbortController();controller.abort();const cancelled=Error('visitor left');
  await assert.rejects(withInstrumentation({url:'http://local/',signal:controller.signal},()=>{throw cancelled;},{module}),value=>value===cancelled);
  assert.equal(errors,0);
});
test('Trace context propagates through async work without leaking to another request',async()=>{
  const incoming='00-11111111111111111111111111111111-2222222222222222-01';
  await withTrace({traceparent:incoming},'test',async()=>{
    await Promise.resolve();const current=currentTraceparent();assert.equal(parseTraceparent(current).traceId,'1'.repeat(32));
    assert.equal(new Headers(propagatedFetch('http://local/')[1].headers).get('traceparent'),current);
  });assert.equal(currentTraceparent(),undefined);
  for(const value of ['00-'+'0'.repeat(32)+'-'+'2'.repeat(16)+'-01',incoming+'-bad',incoming.replace(/1/g,'A')])assert.equal(parseTraceparent(value),undefined);
});
