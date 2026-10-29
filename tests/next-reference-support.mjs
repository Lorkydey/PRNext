import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function linkNextReference(root){
  assert.ok(process.env.PRNEXT_NEXT_REFERENCE,'Set PRNEXT_NEXT_REFERENCE to the installed Next.js reference package');
  const directory=path.resolve(process.env.PRNEXT_NEXT_REFERENCE),version=process.env.PRNEXT_NEXT_REFERENCE_VERSION || '16.4.3';
  assert.ok(['16.4.1','16.4.3'].includes(version),'Use an explicitly tested reference version');
  assert.equal(JSON.parse(await readFile(path.join(directory,'package.json'),'utf8')).version,version);
  await symlink(directory,path.join(root,'node_modules/next'),'dir');
  for(const name of ['react','react-dom']){
    const source=path.join(path.dirname(directory),name);
    assert.equal(JSON.parse(await readFile(path.join(source,'package.json'),'utf8')).version,'19.3.1');
    await rm(path.join(root,'node_modules',name),{recursive:true,force:true});
    await symlink(source,path.join(root,'node_modules',name),'dir');
  }
  return{directory,version,cli:path.join(directory,'dist/bin/next')};
}

export async function buildNextReference(cli,root){
  return promisify(execFile)(process.execPath,[cli,'build',root,'--webpack'],{cwd:root,maxBuffer:4*1024*1024,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},windowsHide:true});
}

export async function nextServer(cli,root){
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,[cli,'start',root,'--port',String(port),'--hostname','127.0.0.1'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},windowsHide:true});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-16000)});
  const close=async()=>{if(child.exitCode!==null||child.signalCode)return;await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});};
  const url='http://127.0.0.1:'+port;
  try{
    for(let attempt=0;attempt<200;attempt++){
      if(child.exitCode!==null)throw new Error(output);
      try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});await response.body?.cancel();return{url,close};}catch{await delay(50)}
    }
    throw new Error('Next reference did not start: '+output);
  }catch(error){await close();throw error;}
}
