import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {appFixture,repositoryRoot,binary} from './support.mjs';
const execute=promisify(execFile);let fixture,audit;
before(async()=>{
  fixture=await appFixture();audit=path.join(fixture.root,'application-executed');
  for(const folder of ['app','pages'])await rm(path.join(fixture.root,folder),{recursive:true,force:true});
  await mkdir(path.join(fixture.root,'app/wake'),{recursive:true});
  await writeFile(path.join(fixture.root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(fixture.root,'app/wake/page.jsx'),`import {appendFileSync} from 'node:fs';import {cookies} from 'next/headers';appendFileSync(${JSON.stringify(audit)},'module\\n');export const dynamic='force-dynamic';export default async function Page(){appendFileSync(${JSON.stringify(audit)},'handler\\n');return <h1>{'fresh:'+(await cookies()).get('user')?.value}</h1>}`);
  await execute(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root]);
  await rm(audit,{force:true});
});
after(async()=>{await fixture?.remove();});
async function start(prewarm){
  const marker=path.join(fixture.root,'ready.json');let logs='';
  const child=spawn(binary,['start',fixture.root,'--hostname','127.0.0.1','--port','0','--node',process.execPath,'--shutdown-on-stdin-eof','--readiness-file',marker,...(prewarm?['--prewarm']:[])],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_ENV:'production'}});
  child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  const closed=new Promise(resolve=>child.once('close',resolve));
  async function close(){if(child.exitCode===null){const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdin.end();await closed;clearTimeout(timer);}}
  for(let i=0;i<300;i++){
    if(child.exitCode!==null)throw Error(logs);
    const url=/^PRNext [^\r\n]*? (http:\/\/127\.0\.0\.1:\d+)(?:\s|$)/m.exec(logs)?.[1];
    if(url)return {url,marker,child,close};await delay(25);
  }
  await close();throw Error('Readiness timeout: '+logs);
}
for(const prewarm of [false,true])test(`render readiness is explicit and framework prewarm=${prewarm} never executes application handlers`,async()=>{
  await rm(audit,{force:true});const server=await start(prewarm);
  try{
    const marker=JSON.parse(await readFile(server.marker,'utf8'));assert.equal(marker.ready,true);assert.equal(marker.pid,server.child.pid);assert.equal(marker.render,prewarm?'prewarmed':'lazy');
    await assert.rejects(readFile(audit),{code:'ENOENT'});
    const html=await fetch(server.url+'/wake',{headers:{cookie:'user=alice'}}).then(r=>r.text());assert.match(html,/fresh:alice/);
    assert.match(await readFile(audit,'utf8'),/handler/);
    const next=await fetch(server.url+'/wake',{headers:{cookie:'user=bob'}}).then(r=>r.text());assert.match(next,/fresh:bob/);assert.doesNotMatch(next,/fresh:alice/);
  }finally{await server.close();}
  await assert.rejects(readFile(server.marker),{code:'ENOENT'});
});
