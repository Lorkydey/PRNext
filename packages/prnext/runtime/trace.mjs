import {isControlError} from './navigation.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const scope=new AsyncLocalStorage(),rawFetch=globalThis.fetch;
let api;
try{api=createRequire(import.meta.url)('@opentelemetry/api');}catch{}
const endpoint=process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT||(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/,'')+'/v1/traces':undefined);
const protocol=process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL||process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
const enabled=process.env.OTEL_SDK_DISABLED!=='true'&&endpoint&&(!protocol||protocol==='http/json');
const queue=[];let timer,flushing;
const epoch=BigInt(Date.now())*1000000n-process.hrtime.bigint();
const nanos=()=>String(epoch+process.hrtime.bigint());
export function parseTraceparent(value){
  const match=/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value||'');
  return match&&!/^0+$/.test(match[1])&&!/^0+$/.test(match[2])?{traceId:match[1],spanId:match[2],traceFlags:parseInt(match[3],16)&1}:undefined;
}
export function currentTraceparent(){const value=scope.getStore();return value?`00-${value.traceId}-${value.spanId}-${value.traceFlags?'01':'00'}`:undefined;}
export function propagatedFetch(input,init){
  const parent=currentTraceparent();if(!parent)return [input,init];
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  if(!headers.has('traceparent'))headers.set('traceparent',parent);
  return [input,{...init,headers}];
}
function enqueue(span){
  if(!enabled||!span.flags||queue.length>=1024)return;
  queue.push(span);if(!timer)timer=setTimeout(()=>{timer=undefined;void flushTraces();},200).unref();
}
export async function flushTraces(){
  if(flushing)return flushing;
  if(!queue.length)return;
  const headers={'content-type':'application/json'};
  for(const part of (process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS||process.env.OTEL_EXPORTER_OTLP_HEADERS||'').split(',')){
    const split=part.indexOf('=');if(split>0)try{headers[part.slice(0,split).trim()]=decodeURIComponent(part.slice(split+1).trim());}catch{}
  }
  const spans=queue.splice(0,128);
  flushing=(async()=>{
    const body=JSON.stringify({resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:process.env.OTEL_SERVICE_NAME||'prnext'}}]},scopeSpans:[{scope:{name:'prnext.runtime'},spans}]}]});
    for(let attempt=0;attempt<3;attempt++){
      let retry=false;
      try{
        const response=await rawFetch(endpoint,{method:'POST',redirect:'error',headers,body,signal:AbortSignal.timeout(1000)});
        retry=[429,502,503,504].includes(response.status);await response.body?.cancel();
      }catch{retry=true;} // Telemetry failure never changes an application response.
      if(!retry)break;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100*2**attempt).unref());
    }
  })().finally(()=>{flushing=undefined;if(queue.length&&!timer)timer=setTimeout(()=>{timer=undefined;void flushTraces();},200).unref();});
  return flushing;
}
export async function drainTraces(){
  const deadline=Date.now()+2500;let timeout;
  try{
    await Promise.race([(async()=>{while((flushing||queue.length)&&Date.now()<deadline)await(flushing||flushTraces());})(),new Promise(resolve=>{timeout=setTimeout(resolve,2500);})]);
  }finally{clearTimeout(timeout);clearTimeout(timer);timer=undefined;}
}
export function markTraceError(){const state=scope.getStore();if(state?.span)state.span.status={code:2};state?.sdkSpan?.setStatus({code:2});}
export async function withTrace(options,name,callback){
  const parent=scope.getStore()||parseTraceparent(options.traceparent||new Headers(options.headers).get('traceparent'));
  if(!enabled&&!api&&!parent)return callback();
  let sdkSpan;
  if(!enabled&&api){
    const remote=parent?api.trace.setSpanContext(api.context.active(),{traceId:parent.traceId,spanId:parent.spanId,traceFlags:parent.traceFlags,isRemote:true}):api.context.active();
    sdkSpan=api.trace.getTracer('prnext.runtime').startSpan(name,{kind:options.kind||1},remote);
    const context=sdkSpan.spanContext();
    if(!api.trace.isSpanContextValid(context)){sdkSpan.end();return callback();}
    const run=()=>scope.run({...context,sdkSpan},callback);
    try{return await api.context.with(api.trace.setSpan(remote,sdkSpan),run);}catch(error){if(!isControlError(error))sdkSpan.setStatus({code:2});throw error;}finally{sdkSpan.end();}
  }
  const span={traceId:parent?.traceId||randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),parentSpanId:parent?.spanId,
    flags:parent?.traceFlags??1,name,kind:options.kind||1,startTimeUnixNano:nanos(),attributes:[]};
  if(options.route?.pattern)span.attributes.push({key:'http.route',value:{stringValue:options.route.pattern}});
  const state={traceId:span.traceId,spanId:span.spanId,traceFlags:span.flags,span};
  const run=()=>scope.run(state,async()=>{
    try{const result=await callback();if(result?.status>=500)span.status={code:2};return result;}catch(error){if(!isControlError(error))span.status={code:2};throw error;}finally{span.endTimeUnixNano=nanos();enqueue(span);}
  });
  return api?api.context.with(api.trace.setSpanContext(api.context.active(),{traceId:state.traceId,spanId:state.spanId,traceFlags:state.traceFlags}),run):run();
}
