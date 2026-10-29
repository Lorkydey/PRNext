import {withTrace,markTraceError} from './trace.mjs';
import {readFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {isControlError} from './navigation.mjs';

const modules=new Map(),scope=new AsyncLocalStorage(),reported=new WeakSet();
function bounded(promise,milliseconds,label){
  let timer;
  return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),milliseconds);})]).finally(()=>clearTimeout(timer));
}
export function initializeInstrumentation(distDir,manifest,{realm='node',reactMode,loader}={}) {
  const file=manifest.instrumentation?.[realm];if(!file)return Promise.resolve({});
  const filename=path.resolve(distDir,file),key=filename+':'+(reactMode||realm);let pending=modules.get(key);
  loader??=realm==='edge'?async file=>{const {loadEdgeModule}=await import('./edge.mjs');const asset=file.replace(/\.mjs$/,'.edge.js');return loadEdgeModule(await readFile(asset,'utf8'),asset,reactMode);}:file=>import(pathToFileURL(file).href);
  if(!pending){
    pending=(async()=>{const module=await loader(filename);if(module.register!==undefined&&typeof module.register!=='function')throw Error('instrumentation.register must be a function');if(module.onRequestError!==undefined&&typeof module.onRequestError!=='function')throw Error('instrumentation.onRequestError must be a function');await bounded(Promise.resolve().then(()=>module.register?.()),30000,'instrumentation.register');return module;})();
    // Retain failures too: a failed initialization must never run application code.
    modules.set(key,pending);
  }
  return pending;
}
export function wasRequestErrorReported(error){return !!error&&typeof error==='object'&&(error.instrumentationReported===true||reported.has(error));}
export function acknowledgeRequestError(error){if(error&&typeof error==='object'){scope.getStore()?.seen.add(error);reported.add(error);}markTraceError();}
export function reportRequestError(error,extra={}) {
  if(isControlError(error))return;markTraceError();
  const state=scope.getStore();if(error?.instrumentationReported===true||!state?.module.onRequestError||state.reporting)return;
  const value=error&&typeof error==='object'?error:new Error(String(error));
  if(state.seen.has(value)||state.seen.size>=32)return;state.seen.add(value);reported.add(value);
  const pending=scope.run({...state,reporting:true},()=>bounded(Promise.resolve().then(()=>state.module.onRequestError(value,state.request,{...state.context,...extra})),5000,'instrumentation.onRequestError')).catch(()=>{console.error('[prnext] instrumentation.onRequestError failed');});
  state.pending.add(pending);void pending.finally(()=>state.pending.delete(pending));return pending;
}
export async function withInstrumentation(options,callback,{realm='node',module}={}) {
  const edge=options.route?.cacheConfig?.runtime==='edge'||options.route?.handlerConfig?.runtime==='edge'||options.route?.runtime==='edge';
  const renderRealm=realm;
  if(edge)realm='edge';
  module??=await initializeInstrumentation(options.distDir,options.manifest||{},{realm,reactMode:edge&&options.route?.router==='app'&&options.route?.kind==='page'?(renderRealm==='rsc'?'rsc':'ssr'):undefined});
  const traced=()=>withTrace(options,renderRealm==='rsc'?'prnext.rsc':'prnext.node',callback);
  if(!module.onRequestError)return traced();
  const url=new URL(options.originalUrl||options.url||'http://localhost/'),route=options.route||{};
  const request=Object.freeze({path:url.pathname+url.search,method:options.method||'GET',headers:Object.freeze(Object.fromEntries(new Headers(options.headers)))});
  const context={routerKind:route.router==='app'?'App Router':'Pages Router',routePath:route.pattern||options.routePattern||url.pathname,
    routeType:options.action||new Headers(options.headers).has('next-action')?'action':route.kind==='middleware'?'proxy':route.kind==='api'?'route':'render',
    renderSource:renderRealm==='rsc'?'react-server-components':new Headers(options.headers).get('rsc')==='1'?'react-server-components-payload':'server-rendering',
    revalidateReason:['stale','on-demand'].includes(options.revalidateReason)?options.revalidateReason:undefined,renderType:options.partialFlight?'dynamic-resume':'dynamic'};
  const state={module,request,context,seen:new Set(),pending:new Set()};
  return scope.run(state,async()=>{try{return await traced();}catch(error){if(!options.signal?.aborted||error?.statusCode===504)reportRequestError(error);throw error;}finally{await Promise.all([...state.pending]);}});
}
