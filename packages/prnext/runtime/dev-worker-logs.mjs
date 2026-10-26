import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';

const prefix='\x1ePRNEXT_DEV_LOG:';
/** Private stderr framing; the controller strips it before terminal output. */
export function parseDevLogLine(value){
  if(!value.startsWith(prefix))return {text:value};
  const end=value.indexOf('\x1f',prefix.length);if(end<0||end>2000)return {text:value};
  try{
    const fields=JSON.parse(value.slice(prefix.length,end));
    if(!['info','warn','error','debug','trace'].includes(fields.level))return {text:value};
    return {text:value.slice(end+1),level:fields.level,...(typeof fields.requestId==='string'?{requestId:fields.requestId.slice(0,100)}:{}),...(typeof fields.route==='string'?{route:fields.route.slice(0,1024)}:{}),structuredLevel:true};
  }catch{return {text:value};}
}
export function createDevWorkerConsole({output=process.stderr}={}){
  const scope=new AsyncLocalStorage();let level='info';
  const stream=new Writable({write(chunk,encoding,done){output.write(chunk,encoding,done);}});
  stream.on('error',()=>{});stream.isTTY=output.isTTY;stream.columns=output.columns;
  const nativeWrite=stream.write.bind(stream);
  stream.write=(chunk,...args)=>{
    const context=scope.getStore()||{},metadata=JSON.stringify({level,...(context.requestId!==undefined?{requestId:String(context.requestId).slice(0,100)}:{}),...(context.route?{route:String(context.route).split(/[?#]/,1)[0].slice(0,1024)}:{})});
    const framed=String(chunk).split(/(?<=\n)/).map(part=>part?prefix+metadata+'\x1f'+part:'').join('');return nativeWrite(framed,...args);
  };
  const logger=new Console({stdout:stream,stderr:stream});
  for(const method of ['log','info','warn','error','debug','trace','table','dir','assert','group','groupCollapsed','groupEnd','clear','count','countReset','time','timeLog','timeEnd']){
    const original=logger[method];if(typeof original!=='function')continue;
    logger[method]=(...args)=>{const previous=level;level=method==='warn'?'warn':method==='error'||method==='assert'?'error':method==='debug'||method==='trace'?'debug':'info';try{return Reflect.apply(original,logger,args);}finally{level=previous;}};
  }
  return {console:logger,run:(metadata,callback)=>scope.run(metadata,callback)};
}
