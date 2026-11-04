import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot, startServer } from './support.mjs';

const execute = promisify(execFile);
let fixture, manifestFile, manifest;
before(async () => {
  fixture = await appFixture();
  await writeFile(path.join(fixture.root, 'next.config.mjs'), `export default {server:{publicOrigin:'https://canonical.example:8443'}}`);
  await mkdir(path.join(fixture.root, 'app/api/public-origin'), {recursive:true});
  await writeFile(path.join(fixture.root, 'app/api/public-origin/route.js'), `import{NextResponse}from'next/server';export async function GET(request){if(request.nextUrl.searchParams.has('redirect'))return NextResponse.redirect(new URL('/callback',request.url));return Response.json({url:request.url,nextUrl:request.nextUrl.href,host:request.headers.get('host'),proto:request.headers.get('x-forwarded-proto'),forwarded:request.headers.get('forwarded'),for:request.headers.get('x-forwarded-for')})}`);
  await writeFile(path.join(fixture.root, 'proxy.ts'), `import{NextResponse}from'next/server';export function proxy(request){const response=NextResponse.next();response.headers.set('x-public-middleware-url',request.url);return response}export const config={matcher:['/api/public-origin']};`);
  await execute(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{timeout:120000,maxBuffer:4e6});
  manifestFile=path.join(fixture.root,'.prnext/manifest.json');
  manifest=JSON.parse(await readFile(manifestFile,'utf8'));
  assert.equal(manifest.config.server.publicOrigin,'https://canonical.example:8443');
});
after(async()=>fixture?.remove());

async function using(config, callback, env={}) {
  await writeFile(manifestFile,JSON.stringify({...manifest,config:{...manifest.config,server:config}}));
  const server=await startServer(fixture.root,[],env);
  try {await callback(server);} finally {await server.close();}
}

test('fixed HTTPS origin reaches middleware, NextRequest and callback redirects despite forged forwarding headers',{timeout:45000},async()=>{
  await using({publicOrigin:'https://canonical.example:8443',trustedProxies:[]},async server=>{
    const response=await fetch(server.url+'/api/public-origin?q=1',{headers:{'x-forwarded-host':'attacker.example','x-forwarded-proto':'http','forwarded':'host=attacker.example;proto=http','x-forwarded-for':'192.0.2.1'}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('x-public-middleware-url'),'https://canonical.example:8443/api/public-origin?q=1');
    const value=await response.json();
    assert.deepEqual(value,{url:'https://canonical.example:8443/api/public-origin?q=1',nextUrl:'https://canonical.example:8443/api/public-origin?q=1',host:'canonical.example:8443',proto:'https',forwarded:null,for:null});
    const redirect=await fetch(server.url+'/api/public-origin?redirect=1',{redirect:'manual'});
    assert.equal(redirect.status,307);assert.equal(redirect.headers.get('location'),'https://canonical.example:8443/callback');
  });
});

test('untrusted forwarding headers cannot choose origin; an explicitly trusted transport peer can',{timeout:45000},async()=>{
  const headers={'x-forwarded-host':'public.example:9443','x-forwarded-proto':'https'};
  await using({trustedProxies:[]},async server=>{
    const response=await fetch(server.url+'/api/public-origin',{headers});
    assert.equal(response.status,200);assert.equal((await response.json()).url,server.url+'/api/public-origin');
  });
  await using({trustedProxies:['127.0.0.1/32']},async server=>{
    const response=await fetch(server.url+'/api/public-origin',{headers});
    assert.equal(response.status,200);assert.equal((await response.json()).url,'https://public.example:9443/api/public-origin');
    for(const invalid of [{'x-forwarded-host':'public.example,attacker.example'},{'x-forwarded-proto':'https,http'}]) {
      const rejected=await fetch(server.url+'/api/public-origin',{headers:{...headers,...invalid}});
      assert.equal(rejected.status,400);assert.doesNotMatch(await rejected.text(),/attacker\.example/);
    }
  });
});

test('native health bypasses app redirects; HTTP metrics are protected and observe completed requests',{timeout:45000},async()=>{
  const token='test-only-metrics-token-32-bytes-minimum';
  await using({trustedProxies:[]},async server=>{
    const health=await fetch(server.url+'/_prnext/health');
    assert.equal(health.status,200);assert.equal(health.headers.get('cache-control'),'no-store');
    assert.deepEqual(await health.json(),{schemaVersion:1,status:'ready'});
    const metrics=server.url+'/_prnext/metrics';
    assert.equal((await fetch(metrics)).status,401);
    assert.equal((await fetch(metrics,{headers:{authorization:'Bearer wrong'}})).status,401);
    await (await fetch(server.url+'/api/public-origin')).json();
    const scrape=await fetch(metrics,{headers:{authorization:'Bearer '+token}});
    assert.equal(scrape.status,200);const content=await scrape.text();
    assert.match(content,/http_server_request_duration_seconds_count\{http_request_method="GET",http_response_status_code="200"\} [1-9]/);
    assert.match(content,/prnext_telemetry_dropped_spans_total/);assert.doesNotMatch(content,new RegExp(token));
    const snapshot=await(await fetch(metrics,{headers:{authorization:'Bearer '+token,accept:'application/json'}})).json();
    assert.equal(snapshot.http.enabled,true);assert.ok(snapshot.http.requests.some(request=>request.status===200&&request.count>=1));
    assert.equal((await fetch(metrics,{headers:{authorization:'Bearer '+token},method:'HEAD'})).status,200);
  },{PRNEXT_METRICS_TOKEN:token});
  await using({trustedProxies:[]},async server=>assert.equal((await fetch(server.url+'/_prnext/metrics')).status,404));
});
