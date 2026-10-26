import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {appFixture,startServer,binary} from './support.mjs';
import {build} from '../packages/prnext/build/index.mjs';
import {inspectProject} from '../packages/prnext/build/inspect.mjs';

test('HTTP deadlines cover headers, unfinished uploads and active streams while completed after work survives', {timeout:60000}, async()=>{
  const fixture=await appFixture();let server;
  try {
    await rm(path.join(fixture.root,'app'),{recursive:true});
    await rm(path.join(fixture.root,'proxy.ts'),{force:true});
    await mkdir(path.join(fixture.root,'app','budget'),{recursive:true});
    await writeFile(path.join(fixture.root,'app','layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
    await writeFile(path.join(fixture.root,'app','page.jsx'),'export default function Page(){return <p>budget fixture</p>}');
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),`export default {workerPreload:{routes:['/budget'],timeoutMs:5000}}`);
    await writeFile(path.join(fixture.root,'app','budget','route.js'),`
      import {after} from 'next/server';
      const records=new Set();
      export const dynamic='force-dynamic';
      export const maxDuration=10;
      export async function GET(request){
        const mode=request.nextUrl.searchParams.get('mode');
        if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,1500));
        if(mode==='stream'){
          let timer;
          return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('prefix'));timer=setInterval(()=>controller.enqueue(new TextEncoder().encode('.')),60)},cancel(){clearInterval(timer)}}),{headers:{'content-type':'text/plain'}});
        }
        if(mode==='after')after(async()=>{await new Promise(resolve=>setTimeout(resolve,1000));records.add('finished')});
        return Response.json({pid:process.pid,finished:records.has('finished')});
      }
      export async function POST(request){return new Response(await request.text())}
    `);
    await build(fixture.root);
    const inspectDir=path.join(fixture.root,'.prnext-cache','inspect');await mkdir(inspectDir,{recursive:true});
    server=await startServer(fixture.root,['--workers','1'],{PRNEXT_QUEUE_WAIT_MS:'120',PRNEXT_REQUEST_TIMEOUT_MS:'500',PRNEXT_INSPECT_DIR:inspectDir,PRNEXT_METRICS_FILE:path.join(inspectDir,'metrics-1.jsonl')});
    const normal=await (await fetch(server.url+'/budget')).json();
    const slow=await fetch(server.url+'/budget?mode=slow',{signal:AbortSignal.timeout(5000)});
    assert.equal(slow.status,504);assert.match(await slow.text(),/deadline/i);

    const stream=await fetch(server.url+'/budget?mode=stream',{signal:AbortSignal.timeout(5000)}),reader=stream.body.getReader();
    assert.equal(stream.status,200);assert.match(Buffer.from((await reader.read()).value).toString(),/prefix/);
    await assert.rejects(async()=>{for(;;){const part=await reader.read();if(part.done)throw new Error('deadline incorrectly completed the stream');}},/terminated|fetch|body|socket|abort/i);

    const upload=await new Promise((resolve,reject)=>{
      const request=http.request(server.url+'/budget',{method:'POST',headers:{'content-type':'text/plain','transfer-encoding':'chunked'}},response=>{
        let text='';response.on('data',data=>text+=data);response.on('end',()=>{resolve({status:response.statusCode,text});request.destroy()});response.on('error',reject);
      });
      request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('upload did not reach its HTTP deadline')));
      request.write('unfinished upload');
    });
    assert.equal(upload.status,504);assert.match(upload.text,/deadline/i);

    const deferred=await (await fetch(server.url+'/budget?mode=after')).json();assert.equal(deferred.pid,normal.pid);
    await delay(1100);
    const finished=await (await fetch(server.url+'/budget')).json();assert.equal(finished.pid,normal.pid);assert.equal(finished.finished,true);
    const abort=new AbortController();
    const cancelled=await fetch(server.url+'/budget?mode=stream',{signal:abort.signal});await cancelled.body.getReader().read();abort.abort();
    let report;
    for(let i=0;i<50;i++){
      report=await inspectProject(fixture.root);
      if(report.summary.timedOutResponses>=3&&report.summary.cancelledResponses>=1)break;
      await delay(50);
    }
    assert.ok(report.summary.timedOutResponses>=3,JSON.stringify(report.requestStages));
    assert.ok(report.summary.cancelledResponses>=1,JSON.stringify(report.requestStages));
    for(const stage of ['admission','bodyRead','workerFirstByte','workerHeaders','responseBody','requestTotal'])assert.ok(report.requestStages.some(row=>row.stage===stage&&row.samples>0),stage);
    assert.doesNotMatch(JSON.stringify(report.stageSample),/unfinished upload|mode=|cookie/);

    for(const [name,value] of [['PRNEXT_QUEUE_WAIT_MS','0'],['PRNEXT_REQUEST_TIMEOUT_MS','-1']]){
      await assert.rejects(promisify(execFile)(binary,['start',fixture.root,'--hostname','127.0.0.1','--port','0'],{env:{...process.env,[name]:value},windowsHide:true}),error=>error.code!==0&&error.stderr.includes(name));
    }
  } finally {await server?.close();await fixture.remove();}
});
