import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from '../packages/prnext/build/index.mjs';
import {decodeStream} from '../packages/prnext/compat/flight-delta.cjs';
import {repositoryRoot,startServer} from './support.mjs';

test('Real Node, RSC and Edge hooks, correlated native spans, and authorized differential navigation', {timeout:120000},async t=>{
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-observability-'));let server;
  t.after(async()=>{await server?.close();collector.closeAllConnections();await new Promise(resolve=>collector.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const hooks=[],spans=[],upstream=[];
  const collector=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.url==='/hooks')hooks.push(JSON.parse(body));
    if(req.url==='/v1/traces')for(const resource of JSON.parse(body).resourceSpans)for(const scope of resource.scopeSpans)spans.push(...scope.spans);
    if(req.url==='/upstream')upstream.push(req.headers.traceparent);
    res.writeHead(200,{'content-type':'application/json'}).end('{}');
  });
  await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${collector.address().port}`;
  const files={
    'package.json':'{"type":"module"}',
    'instrumentation.ts':`export async function register(){globalThis.__registered=(globalThis.__registered||0)+1;if(process.env.NEXT_RUNTIME==='nodejs'){const[{AsyncLocalStorage},api]=await Promise.all([import('node:async_hooks'),import('@opentelemetry/api')]);const store=new AsyncLocalStorage();api.context.setGlobalContextManager({active:()=>store.getStore()||api.ROOT_CONTEXT,with:(ctx,fn,target,...args)=>store.run(ctx,()=>fn.apply(target,args)),bind:(_,value)=>value,enable(){return this},disable(){store.disable();return this}});}}export async function onRequestError(error,request,context){await fetch(process.env.HOOK_URL,{method:'POST',body:JSON.stringify({message:error.message,request,context,runtime:process.env.NEXT_RUNTIME,registered:globalThis.__registered})});}`,
    'app/layout.jsx':`export default function Layout({children}){return <html><body><header>${'Repeated layout data '.repeat(600)}</header>{children}</body></html>}`,
    'app/one/page.jsx':`import{context,trace}from'@opentelemetry/api';export const dynamic='force-dynamic';export default async function Page(){await fetch(process.env.UPSTREAM_URL,{cache:'no-store'});return <main data-trace={trace.getSpanContext(context.active())?.traceId}>one-{globalThis.__registered}</main>}`,
    'app/actions.js':`'use server';export async function fail(){throw Error('action-real-error')}`,
    'app/action/page.jsx':`import{fail}from'../actions';export const dynamic='force-dynamic';export default function Page(){return <form action={fail}><button>Fail</button></form>}`,
    'app/two/page.jsx':`export const dynamic='force-dynamic';export default function Page(){return <main>two-{globalThis.__registered}</main>}`,
    'app/rsc-error/page.jsx':`export const dynamic='force-dynamic';export default function Page(){throw Error('rsc-real-error');}`,
    'app/cancel/loading.jsx':`export default function Loading(){return <p>Pending</p>}`,
    'app/cancel/page.jsx':`export const dynamic='force-dynamic';export default async function Page(){await new Promise(resolve=>setTimeout(resolve,300));return <main>Done</main>}`,
    'app/isr/page.jsx':`export const revalidate=1;export default function Page(){if(process.env.FAIL_ISR==='1'){if(globalThis.__registered!==1)throw Error('ISR register missing');throw Error('isr-real-error')}return <main>Cached page</main>}`,
    'app/api/after/route.js':`import {after}from'next/server';export function GET(){after(()=>{throw Error('after-real-error')});return Response.json({ok:true})}`,
    'app/api/error/route.js':`export function GET(){throw Error('route-real-error');}`,
    'app/edge/route.js':`export const runtime='edge';export function GET(){return Response.json({registered:globalThis.__registered,runtime:process.env.NEXT_RUNTIME});}`,
    'app/edge-error/route.js':`export const runtime='edge';export function GET(){throw Error('edge-real-error');}`,
    'pages/static.jsx':`export default function Page(){return <h1>Static</h1>}`,
  };
  for(const [file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}
  const manifest=await build(root);assert.ok(manifest.instrumentation.edge);
  server=await startServer(root,['--workers','1'],{FAIL_ISR:'1',OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:endpoint+'/v1/traces',OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:'http/json',HOOK_URL:endpoint+'/hooks',UPSTREAM_URL:endpoint+'/upstream'});
  const seed='00-11111111111111111111111111111111-2222222222222222-01';
  const get=(route,headers={})=>fetch(server.url+route,{headers:{'accept-encoding':'identity',...headers}});
  const first=await get('/one',{rsc:'1','x-prnext-flight-accept':'v1',traceparent:seed,cookie:'session=alice'});
  assert.equal(first.headers.get('content-encoding'),null);
  const token=first.headers.get('x-prnext-flight-token'),base=new Uint8Array(await first.arrayBuffer());assert.ok(token);assert.match(Buffer.from(base).toString(),/one-/);assert.ok(Buffer.from(base).toString().includes('1'.repeat(32)),'application OpenTelemetry API receives the framework parent');
  const next=await get('/two',{rsc:'1','x-prnext-flight-accept':'v1','x-prnext-flight-base':token,cookie:'session=alice'});
  assert.equal(next.headers.get('content-type'),'application/x-prnext-flight-delta',server.output());
  const wire=new Uint8Array(await next.arrayBuffer());assert.ok(wire.length<base.length/2,`delta ${wire.length} versus ${base.length}`);
  t.diagnostic(`Flight transport: ${base.length} full bytes, ${wire.length} differential bytes`);
  const restored=await new Response(decodeStream(new Response(wire).body,base)).text();assert.match(restored,/two-/);
  const other=await get('/two',{rsc:'1','x-prnext-flight-accept':'v1','x-prnext-flight-base':token,cookie:'session=bob'});assert.match(other.headers.get('content-type'),/^text\/x-component/);await other.arrayBuffer();
  const edge=await get('/edge');assert.deepEqual(await edge.json(),{registered:1,runtime:'edge'});
  for(const route of ['/api/error','/edge-error','/rsc-error']){const response=await get(route);await response.text();assert.equal(response.status,500);}
  const actionId=Object.keys(manifest.app.actions)[0];
  const action=await fetch(server.url+'/action',{method:'POST',headers:{'next-action':actionId,'content-type':'text/plain',origin:server.url},body:'[]'});await action.text();
  const after=await get('/api/after');await after.text();assert.equal(after.status,200);
  const cancelled=await get('/cancel',{rsc:'1'}),reader=cancelled.body.getReader();await reader.read();await reader.cancel();
  await delay(1100);const regenerated=await get('/isr');await regenerated.text();
  const stat=await get('/static',{traceparent:seed});await stat.text();
  for(let i=0;i<100&&(hooks.length<6||spans.filter(s=>s.name==='prnext.http'&&s.traceId==='1'.repeat(32)).length<2);i++)await delay(50);
  for(const [message,type]of [['route-real-error','route'],['edge-real-error','route'],['rsc-real-error','render'],['action-real-error','action'],['after-real-error','route'],['isr-real-error','render']]){
    const records=hooks.filter(record=>record.message===message);assert.equal(records.length,1,message);assert.equal(records[0].registered,1);assert.equal(records[0].context.routeType,type);
  }
  assert.equal(hooks.find(record=>record.message==='isr-real-error').context.revalidateReason,'stale');
  assert.equal(hooks.length,6,'an RSC error is reported once across its thread boundary');
  const traced=spans.filter(s=>s.traceId==='1'.repeat(32));
  for(const name of ['prnext.http','prnext.node','prnext.rsc','prnext.fetch'])assert.ok(traced.some(s=>s.name===name),name);
  const rsc=traced.find(s=>s.name==='prnext.rsc'),node=traced.find(s=>s.spanId===rsc.parentSpanId);assert.equal(node.name,'prnext.node');assert.equal(traced.find(s=>s.spanId===node.parentSpanId).name,'prnext.http');
  assert.ok(upstream.some(header=>header?.includes(rsc.traceId)));assert.ok(traced.filter(s=>s.name==='prnext.http').length>=2,'static responses are also traced');
  assert.ok(traced.every(s=>!JSON.stringify(s).includes('session=')&&!JSON.stringify(s).includes('UPSTREAM_URL')));
});
