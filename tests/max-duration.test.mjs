import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('maxDuration extends API/RSC rendering beyond the default and bounds active streams', {timeout:90000}, async () => {
  const fixture=await appFixture();let server;
  try {
    for(const dir of ['long-api','long-page','short-stream'])await mkdir(path.join(fixture.root,'app',dir),{recursive:true});
    await writeFile(path.join(fixture.root,'app/long-api/route.js'),`export const maxDuration=30;export async function GET(){await new Promise(r=>setTimeout(r,26000));return Response.json({ok:true})}`);
    await writeFile(path.join(fixture.root,'app/long-page/page.jsx'),`export const dynamic='force-dynamic';export const maxDuration=30;export default async function Page(){await new Promise(r=>setTimeout(r,26000));return <h1>long render completed</h1>}`);
    await writeFile(path.join(fixture.root,'app/short-stream/route.js'),`export const maxDuration=1;export function GET(){let timer;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('start'));timer=setInterval(()=>c.enqueue(new TextEncoder().encode('chunk')),100)},cancel(){clearInterval(timer)}}))}`);
    await build(fixture.root);server=await startServer(fixture.root,['--workers','1']);
    await Promise.all(['/long-api','/long-page'].map(async route=>{
      const response=await fetch(server.url+route,{signal:AbortSignal.timeout(35000)});
      assert.equal(response.status,200);const body=await response.text();
      assert.match(body,route==='/long-api'?/"ok":true/:/long render completed/);
    }));
    const started=performance.now();
    const response=await fetch(server.url+'/short-stream',{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);
    await assert.rejects(response.text());
    assert.ok(performance.now()-started<4000,'active chunks must not reset the total deadline');
    const recovered=await fetch(server.url+'/api/hello',{signal:AbortSignal.timeout(5000)});
    assert.ok(recovered.status<500);
  }finally{await server?.close();await fixture.remove();}
});
