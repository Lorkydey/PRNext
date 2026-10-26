import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {EventEmitter} from 'node:events';

export function createDevRuntimePool({binary,root,home,environment={},onChild=()=>{}}){
  let spare,disposed=false;const children=new Set();
  function create(){
    if(disposed)throw Error('Development runtime is closed');
    const token=randomBytes(32).toString('base64url');
    const child=spawn(binary,['dev-spare',root,'--node',process.execPath,'--script',fileURLToPath(new URL('./dev-runtime-spare.mjs',import.meta.url))],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...environment,NODE_ENV:'development',PRNEXT_DEV_SPARE_TOKEN:token}});
    children.add(child);onChild(child);
    const messages=new EventEmitter();let buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536){child.kill();return;}for(let end;(end=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.type)messages.emit(message.type,message);}catch{}}});
    child.once('exit',()=>{children.delete(child);if(spare?.child===child)spare=undefined;});
    child.stdin.on('error',()=>{});
    const wait=type=>new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>fail(Error('Development runtime warmup timed out')),15000);
      const clean=()=>{clearTimeout(timeout);messages.off(type,message);child.off('exit',exit);child.off('error',fail);};
      const fail=error=>{clean();reject(error);};const exit=()=>fail(Error('Development runtime exited'));
      const message=value=>{clean();resolve(value);};
      messages.on(type,message);child.once('exit',exit);child.once('error',fail);
    });
    const ready=wait('warm');ready.catch(()=>{if(spare?.child===child)spare=undefined;void stop(child);});
    return {child,token,ready,wait};
  }
  async function stop(child){
    if(!child?.pid||child.exitCode!==null||child.signalCode)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),30000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();if(child.connected)child.disconnect();});
  }
  return {
    warm(){if(!spare)spare=create();return spare.ready;},
    async take(directory){
      const selected=spare||create();spare=undefined;
      try{
        const {port,guardPort}=await selected.ready,dist=path.join(root,directory),armed=selected.wait('armed');selected.child.stdin.write(JSON.stringify({type:'arm',dist})+'\n');await armed;
        const descriptor=path.join(home,'transport-'+path.basename(directory)+'.json');
        await writeFile(descriptor,JSON.stringify({project:root,dist,port,guardPort,token:selected.token}),{mode:0o600,flag:'wx'});
        spare=create();return {child:selected.child,descriptor,pid:selected.child.pid,close:async()=>{await stop(selected.child);await rm(descriptor,{force:true});}};
      }catch(error){await stop(selected.child);throw error;}
    },
    async close(){disposed=true;await Promise.all([...children].map(stop));},
  };
}
