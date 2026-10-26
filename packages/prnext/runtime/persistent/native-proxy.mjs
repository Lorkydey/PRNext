// Lifecycle RPC only: no public HTTP bytes, headers or response bodies enter JS.
import {spawn} from 'node:child_process';
import {environment,delay} from './common.mjs';
let manager;
class NativeProxy {
  constructor(binary,{home,notify,onFatal}){
    this.pending=new Map();this.next=0;this.stopping=false;
    this.child=spawn(binary,['persistent-proxy'],{cwd:home,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','inherit'],env:{...environment(),TOKIO_WORKER_THREADS:'1'}});
    this.pid=this.child.pid;if(this.pid)notify({type:'child',pid:this.pid,running:true});
    this.closed=new Promise(resolve=>this.child.once('close',()=>{if(this.pid)notify({type:'child',pid:this.pid,running:false});resolve();}));
    this.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error('Native persistent proxy did not initialize'));this.child.kill();},10000);timer.unref();
      let buffer='';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data',chunk=>{
        buffer+=chunk;
        if(buffer.length>1024*1024){this.child.kill();return;}
        for(let end;(end=buffer.indexOf('\n'))>=0;){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;
          try{message=JSON.parse(line);}catch{this.child.kill();return;}
          if(message.type==='ready'&&message.protocol===1){clearTimeout(timer);resolve();continue;}
          const request=this.pending.get(message.id);if(!request)continue;
          this.pending.delete(message.id);clearTimeout(request.timer);message.ok?request.resolve(message.value):request.reject(new Error(message.error||'Native proxy request failed'));
        }
      });
      const failed=error=>{
        clearTimeout(timer);reject(error);
        for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();
        if(!this.stopping)onFatal(error);
      };
      this.child.once('error',failed);this.child.once('exit',(code,signal)=>failed(new Error(`Native persistent proxy exited (${signal||code})`)));
    });
    this.child.stdin.on('error',()=>{});
  }
  async request(command,values={},timeout=10000){
    await this.ready;
    if(this.stopping||this.child.exitCode!==null||this.pending.size>=32)throw new Error('Native persistent proxy unavailable');
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);reject(new Error('Native proxy control request timed out'));
        // A timed-out switch/listen might still mutate native state later.
        // End that uncertain control plane; the watchdog restores saved apps.
        this.child.kill('SIGKILL');
      },timeout);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,command,...values})+'\n',error=>{if(error){const request=this.pending.get(id);if(request){clearTimeout(request.timer);this.pending.delete(id);request.reject(error);}}});
    });
  }
  async stop(){this.stopping=true;this.child.stdin.end();await Promise.race([this.closed,delay(3000)]);if(this.child.exitCode===null)this.child.kill('SIGKILL');await this.closed;}
}
export async function nativeGateway(config,options){
  manager??=new NativeProxy(config.binary,options);await manager.ready;
  const app=config.name;await manager.request('listen',{app,hostname:config.hostname,port:config.port});
  return {pid:manager.pid,
    activate:g=>manager.request('activate',{app,generation:g.relative,port:g.port}),
    pause:g=>manager.request('pause',{app,...(g?{generation:g.relative}:{})}),
    retire:(g,timeout)=>manager.request('retire',{app,generation:g.relative,timeout},timeout+5000),
    counts:async()=> (await manager.request('status',{app})).generations,
    close:()=>manager.request('close',{app}),
  };
}
export async function stopNativeProxy(){if(manager){const active=manager;manager=undefined;await active.stop();}}
