import net from 'node:net';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const protocol='prnext-loopback-v2',noncePattern=/^[a-f0-9]{64}$/;
const nonce=()=>randomBytes(32).toString('hex');
const authenticationError=()=>Object.assign(Error('Loopback peer authentication failed'),{code:'ERR_PRNEXT_PEER_AUTH'});
const proof=(token,context,role,client,server,...body)=>createHmac('sha256',token).update(JSON.stringify([protocol,context,role,client,server,...body])).digest('hex');
function matches(supplied,expected){return typeof supplied==='string'&&noncePattern.test(supplied)&&timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(expected,'hex'));}
function encode(value,limit){const body=JSON.stringify(value);if(typeof body!=='string'||Buffer.byteLength(body)>limit)throw Error('Loopback control body is too large');return body;}
function send(socket,value){socket.write(JSON.stringify({protocol,...value})+'\n');}

function frames(socket,limit,receive,fail){
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
    try{
      buffer=Buffer.concat([buffer,chunk]);
      for(;;){
        const end=buffer.indexOf(10),maximum=limit();
        if(end<0){if(buffer.length>maximum)throw Error('Loopback control frame is too large');return;}
        if(end>maximum)throw Error('Loopback control frame is too large');
        const message=JSON.parse(buffer.subarray(0,end).toString('utf8'));buffer=buffer.subarray(end+1);
        if(!message||message.protocol!==protocol)throw authenticationError();
        receive(message);if(socket.destroyed)return;
      }
    }catch(error){fail(error);}
  });
}

// One fresh transcript authorizes exactly one payload. Role and context labels
// prevent reflection and cross-service reuse; both nonces prevent replay across
// connections and watchdog restarts. The first client frame contains only a
// nonce; the command follows a verified server proof. The key is never sent.
export function requestLoopback({port,token},request,{context,timeout=120000,signal,maxRequestBytes=65536,maxResponseBytes=1024*1024}={}) {
  if(signal?.aborted)return Promise.reject(signal.reason||Error('Loopback request aborted'));
  let body;try{body=encode(request,maxRequestBytes);}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});
    const client=nonce();let server,state='challenge',finished=false;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(handshake);clearTimeout(total);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(value);};
    const abort=()=>finish(signal.reason||Error('Loopback request aborted'));
    const total=setTimeout(()=>finish(Error('Loopback request timed out')),timeout);
    const handshake=setTimeout(()=>finish(authenticationError()),Math.min(5000,timeout));
    signal?.addEventListener('abort',abort,{once:true});
    socket.once('connect',()=>send(socket,{type:'hello',client}));
    socket.on('error',error=>finish(error));
    socket.on('end',()=>finish(state==='challenge'?authenticationError():Error('Loopback peer disconnected')));
    socket.on('close',()=>{if(!finished)finish(state==='challenge'?authenticationError():Error('Loopback peer disconnected'));});
    frames(socket,()=>state==='challenge'?1024:2*maxResponseBytes+1024,message=>{
      if(state==='challenge'){
        if(message.type!=='challenge'||typeof message.server!=='string'||!noncePattern.test(message.server)||!matches(message.proof,proof(token,context,'server',client,message.server)))throw authenticationError();
        server=message.server;state='response';clearTimeout(handshake);
        send(socket,{type:'request',body,proof:proof(token,context,'request',client,server,body)});
        return;
      }
      if(state!=='response'||message.type!=='response'||typeof message.body!=='string'||Buffer.byteLength(message.body)>maxResponseBytes||!matches(message.proof,proof(token,context,'response',client,server,body,message.body)))throw authenticationError();
      const result=JSON.parse(message.body);state='done';
      if(!result||typeof result.ok!=='boolean')throw Error('Invalid loopback response');
      finish(result.ok?null:Error(typeof result.error==='string'?result.error:'Loopback request failed'),result.value);
    },error=>finish(error));
  });
}

export function serveLoopback(socket,{token,context,handle,timeout=125000,handshakeTimeout=5000,maxRequestBytes=65536,maxResponseBytes=1024*1024}) {
  const controller=new AbortController();let client,server,requestBody,state='hello';
  const deadlineMs=Date.now()+timeout;
  const close=()=>{state='closed';controller.abort();socket.destroy();};
  const total=setTimeout(close,timeout),handshake=setTimeout(close,Math.min(handshakeTimeout,timeout));
  socket.on('error',()=>{});
  socket.once('close',()=>{state='closed';clearTimeout(total);clearTimeout(handshake);controller.abort();});
  socket.on('end',close);
  frames(socket,()=>state==='hello'?1024:2*maxRequestBytes+1024,message=>{
    if(state==='hello'){
      if(message.type!=='hello'||typeof message.client!=='string'||!noncePattern.test(message.client))throw authenticationError();
      client=message.client;server=nonce();state='request';
      send(socket,{type:'challenge',server,proof:proof(token,context,'server',client,server)});return;
    }
    if(state!=='request'||message.type!=='request'||typeof message.body!=='string'||Buffer.byteLength(message.body)>maxRequestBytes||!matches(message.proof,proof(token,context,'request',client,server,message.body)))throw authenticationError();
    requestBody=message.body;const request=JSON.parse(requestBody);
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Invalid loopback request');
    clearTimeout(handshake);state='busy';
    const reply=result=>{
      if(state!=='busy')return;
      let body;
      try{body=encode(result,maxResponseBytes);}catch{body=encode({ok:false,error:'Loopback response is too large'},maxResponseBytes);}
      state='done';socket.end(JSON.stringify({protocol,type:'response',body,proof:proof(token,context,'response',client,server,requestBody,body)})+'\n');
    };
    Promise.resolve().then(()=>{
      if(controller.signal.aborted)throw Error('Loopback client disconnected');
      return handle(request,{signal:controller.signal,deadlineMs});
    }).then(value=>reply({ok:true,value}),error=>reply({ok:false,error:String(error.message).slice(0,2048)})).catch(close);
  },close);
}
