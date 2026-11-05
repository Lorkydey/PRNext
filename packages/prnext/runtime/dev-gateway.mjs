import {spawn} from 'node:child_process';

export class DevGateway {
  constructor(binary,root,{hostname,port,onEnsure,onOpen,onClose,onFatal,onBeforeChild=()=>{},onChild=()=>{}},{spawnChild=spawn}={}) {
    this.next=0;this.pending=new Map();this.ensures=new Map();this.stopping=false;
    const ticket=onBeforeChild();
    this.child=spawnChild(binary,['dev-gateway',root,'--hostname',hostname,'--port',String(port)],{stdio:['pipe','pipe','inherit'],windowsHide:true});onChild(this.child,ticket);
    this.closed=new Promise(resolve=>this.child.once('close',resolve));
    this.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(Error('Development listener did not start'));this.child.kill();},15000);
      let buffer='';this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>1024*1024){this.child.kill();return;}
        for(let end;(end=buffer.indexOf('\n'))>=0;){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;
          try{message=JSON.parse(line);}catch{this.child.kill();return;}
          if(message.type==='ready'){clearTimeout(timer);resolve(message);continue;}
          if(message.type==='open'){onOpen(message);continue;}
          if(message.type==='close'){onClose(message);continue;}
          if(message.type==='ensure-cancel'){this.cancelEnsure(message.id);continue;}
          if(message.type==='ensure'){
            const now=Date.now();
            if(!Number.isSafeInteger(message.id)||!Number.isSafeInteger(message.deadlineMs)||this.ensures.has(message.id)||this.ensures.size>=64){this.child.kill();continue;}
            if(message.deadlineMs<=now)continue;
            const deadlineMs=Math.min(message.deadlineMs,now+120000);
            const controller=new AbortController(),entry={controller,timer:setTimeout(()=>this.cancelEnsure(message.id),deadlineMs-now)};
            this.ensures.set(message.id,entry);
            const reply=value=>{
              if(this.ensures.get(message.id)!==entry)return;
              clearTimeout(entry.timer);this.ensures.delete(message.id);
              return this.request('result',{request:message.id,value});
            };
            Promise.resolve().then(()=>{
              if(controller.signal.aborted)return;
              return onEnsure(message.path,message.client,{signal:controller.signal,deadlineMs});
            }).then(reply,error=>reply({error:String(error.message).slice(0,8000)})).catch(error=>{if(!this.stopping)onFatal(error);});continue;
          }
          const pending=this.pending.get(message.id);if(!pending)continue;
          this.pending.delete(message.id);clearTimeout(pending.timer);message.ok?pending.resolve(message.value):pending.reject(Error(message.error));
        }
      });
      const failed=error=>{clearTimeout(timer);reject(error);for(const id of this.ensures.keys())this.cancelEnsure(id);for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();if(!this.stopping)onFatal(error);};
      this.child.once('error',failed);this.child.once('exit',(code,signal)=>failed(Error(`Development listener exited ${signal||code}`)));
    });
    this.child.stdin.on('error',()=>{});
  }
  cancelEnsure(id){const entry=this.ensures.get(id);if(!entry)return;this.ensures.delete(id);clearTimeout(entry.timer);entry.controller.abort();}
  async request(command,values={}) {
    await this.ready;
    if(this.stopping||this.child.exitCode!==null)throw Error('Development listener is closed');
    const id=++this.next;
    const line=JSON.stringify({id,command,...values})+'\n';
    if(Buffer.byteLength(line)>65536)throw Error(`Development ${command} control exceeds the 64 KiB frame budget`);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Development ${command} control timed out`));this.child.kill();},35000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(line);
    });
  }
  async close(){this.stopping=true;for(const id of this.ensures.keys())this.cancelEnsure(id);this.child.stdin.end();const timer=setTimeout(()=>this.child.kill('SIGKILL'),6000);try{await this.closed;}finally{clearTimeout(timer);}}
}
