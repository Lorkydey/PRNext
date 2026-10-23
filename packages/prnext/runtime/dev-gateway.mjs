import {spawn} from 'node:child_process';

export class DevGateway {
  constructor(binary,root,{hostname,port,onEnsure,onOpen,onClose,onFatal}) {
    this.next=0;this.pending=new Map();this.stopping=false;
    this.child=spawn(binary,['dev-gateway',root,'--hostname',hostname,'--port',String(port)],{stdio:['pipe','pipe','inherit'],windowsHide:true});
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
          if(message.type==='ensure'){
            Promise.resolve().then(()=>onEnsure(message.path,message.client)).then(value=>this.request('result',{request:message.id,value}),error=>this.request('result',{request:message.id,value:{error:String(error.message).slice(0,8000)}})).catch(error=>{if(!this.stopping)onFatal(error);});continue;
          }
          const pending=this.pending.get(message.id);if(!pending)continue;
          this.pending.delete(message.id);clearTimeout(pending.timer);message.ok?pending.resolve(message.value):pending.reject(Error(message.error));
        }
      });
      const failed=error=>{clearTimeout(timer);reject(error);for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();if(!this.stopping)onFatal(error);};
      this.child.once('error',failed);this.child.once('exit',(code,signal)=>failed(Error(`Development listener exited ${signal||code}`)));
    });
    this.child.stdin.on('error',()=>{});
  }
  async request(command,values={}) {
    await this.ready;
    if(this.stopping||this.child.exitCode!==null)throw Error('Development listener is closed');
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Development ${command} control timed out`));this.child.kill();},35000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,command,...values})+'\n');
    });
  }
  async close(){this.stopping=true;this.child.stdin.end();const timer=setTimeout(()=>this.child.kill('SIGKILL'),6000);try{await this.closed;}finally{clearTimeout(timer);}}
}
