import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createClient} from './toolchain/node_modules/redis/dist/index.js';

export async function redisServer(){
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-redis-test-'));
  let child,log='',port;
  const executable=process.env.PRNEXT_REDIS_SERVER||(process.platform==='win32'?undefined:'redis-server');
  if(!executable)throw new Error('Set PRNEXT_REDIS_SERVER to a local Redis executable for the isolated Redis integration tests.');
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  child=spawn(executable,['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--protected-mode','yes','--dir',directory],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});void exited.catch(()=>{});
  child.stdout.on('data',bytes=>{log=(log+bytes).slice(-12000);});child.stderr.on('data',bytes=>{log=(log+bytes).slice(-12000);});
  const url='redis://127.0.0.1:'+port;
  try{
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw new Error('Redis exited: '+log);
      const client=createClient({url,socket:{connectTimeout:100,reconnectStrategy:false}});client.on('error',()=>{});
      try{await client.connect();await client.ping();client.destroy();return {url,async close(){const end=createClient({url,socket:{connectTimeout:200,reconnectStrategy:false}});end.on('error',()=>{});try{await end.connect();await end.sendCommand(['SHUTDOWN','NOSAVE']).catch(()=>{});}catch{child.kill();}finally{if(end.isOpen)end.destroy();}await exited;await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};}catch{if(client.isOpen)client.destroy();await delay(50);}
    }
    throw new Error('Redis did not start: '+log);
  }catch(error){child.kill();await exited.catch(()=>{});await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});throw error;}
}
