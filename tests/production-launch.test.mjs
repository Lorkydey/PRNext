import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {standaloneFixture, repositoryRoot, binary, freePort} from './support.mjs';

let fixture;
before(async () => {
  fixture=await standaloneFixture('prnext production launch espace-');
  await mkdir(path.join(fixture.root,'pages/api'),{recursive:true});
  await writeFile(path.join(fixture.root,'pages/api/ids.js'),'export default function handler(req,res){res.json({worker:process.pid,server:process.ppid})}');
  await writeFile(path.join(fixture.root,'pages/api/slow.js'),"export default async function handler(req,res){res.write('first');await new Promise(r=>setTimeout(r,400));res.end('last')}");
  await writeFile(path.join(fixture.root,'pages/api/block.js'),`import{writeFileSync}from'node:fs';export default function handler(){writeFileSync(${JSON.stringify(path.join(fixture.root,'blocked'))},'ready');while(true){}}`);
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root]);
});
after(async () => {await fixture?.remove()});

async function alive(pid){
  try{
    process.kill(pid,0);
    if(process.platform==='linux' && (await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1].startsWith('Z '))return false;
    return true;
  }catch{return false}
}
async function until(check, message){
  for(let i=0;i<150;i++){if(await check())return;await delay(50)}
  assert.fail(message());
}
async function run(options, action){
  const port=await freePort(), url=`http://127.0.0.1:${port}`;
  let output='',ids;
  const child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'start',fixture.root,
    '--port',String(port),...(options.args||[])],{stdio:[options.stdin?'pipe':'ignore','pipe','pipe'],windowsHide:true,
    env:{...process.env,NODE_ENV:'production',NODE_OPTIONS:'',NODE_V8_COVERAGE:'',PRNEXT_BINARY:binary,...options.env}});
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  try{
    await until(async()=>{if(child.exitCode!==null)assert.fail(output);try{ids=await(await fetch(url+'/api/ids')).json();return true}catch{return false}},()=>output);
    if(process.platform==='linux' && typeof process.execve==='function' && !options.supervised)assert.equal(ids.server,child.pid,'the CLI PID must become the native server');
    else assert.notEqual(ids.server,child.pid,'portable supervision must remain active');
    await action({child,ids,url,closed,output:()=>output});
    await until(async()=>!(await alive(ids.worker))&&!(await alive(ids.server)),()=>`Descendants survived: ${JSON.stringify(ids)}\n${output}`);
    await closed;
    await assert.rejects(fetch(url+'/api/ids',{signal:AbortSignal.timeout(1000)}));
  }finally{
    if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');
    for(const pid of Object.values(ids||{}))if(await alive(pid)){try{process.kill(pid,'SIGKILL')}catch{}}
    await closed.catch(()=>{});
  }
}

for(const signal of ['SIGTERM','SIGINT','SIGHUP'])test(`production ${signal} drains an active stream and releases descendants`,{skip:process.platform==='win32',timeout:30000},async()=>{
  await run({},async({child,url,closed,output})=>{
    const response=await fetch(url+'/api/slow',{headers:{'accept-encoding':'identity'}}),reader=response.body.getReader();
    let body=new TextDecoder().decode((await reader.read()).value);assert.equal(body,'first');
    child.kill(signal);
    for(;;){const chunk=await reader.read();if(chunk.done)break;body+=new TextDecoder().decode(chunk.value)}
    assert.equal(body,'firstlast');await closed;
    if(signal==='SIGHUP'&&child.signalCode==='SIGHUP')assert.equal(child.exitCode,null);
    else assert.equal(child.exitCode,0,output());
  });
});
test('production SIGKILL releases idle descendants',{timeout:30000},async()=>{
  await run({},async({child})=>child.kill('SIGKILL'));
});
test('Linux exec preserves explicitly requested stdin EOF shutdown',{
  skip:process.platform!=='linux'||typeof process.execve!=='function',timeout:30000,
},async()=>{await run({stdin:true,args:['--shutdown-on-stdin-eof']},async({child,closed})=>{child.stdin.end();await closed;assert.equal(child.exitCode,0)})});

test('Linux instrumentation retains the launcher and its JavaScript exit hooks',{
  skip:process.platform!=='linux',timeout:30000,
},async()=>{
  const hook=path.join(fixture.root,'preload.mjs'),prefix=path.join(fixture.root,'exit-');
  await writeFile(hook,`import{writeFileSync}from'node:fs';process.on('exit',()=>writeFileSync(${JSON.stringify(prefix)}+process.pid,'closed'));`);
  await run({supervised:true,env:{NODE_OPTIONS:`--import=${pathToFileURL(hook).href}`}},async({child,closed,output})=>{
    child.kill('SIGTERM');await closed;assert.equal(child.exitCode,0,output());
    assert.equal(await readFile(prefix+child.pid,'utf8'),'closed');
  });
});
test('Linux parent-death containment kills a synchronously blocked Node worker',{
  skip:process.platform!=='linux',timeout:30000,
},async()=>{
  await run({},async({child,ids,url})=>{
    const request=fetch(url+'/api/block',{signal:AbortSignal.timeout(10000)}).catch(()=>{});
    await until(async()=>{try{return(await readFile(path.join(fixture.root,'blocked'),'utf8'))==='ready'}catch{return false}},()=> 'Worker never entered blocking handler');
    // Kill Rust itself, even on Node versions that retain the CLI supervisor.
    process.kill(ids.server,'SIGKILL');await request;
    await until(async()=>!(await alive(ids.worker)),()=> 'Blocked worker outlived Rust');
    if(child.pid!==ids.server&&child.exitCode===null)child.kill('SIGTERM');
  });
});
