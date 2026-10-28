import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const [compiler,filename,mode]=process.argv.slice(2);
const watching=mode==='watch';
let closing=false,buffer='',output='',overflow=false;
const cache=await mkdtemp(path.join(tmpdir(),'prnext-typescript-native-'));
const child=spawn(process.execPath,[compiler,'--project',filename,'--noEmit','--incremental','true','--tsBuildInfoFile',path.join(cache,'project.tsbuildinfo'),'--pretty','false','--locale','en',...(watching?['--watch','--preserveWatchOutput']:[])],{
  cwd:process.cwd(),windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
  // Native TS respects explicit project watch options. The polling defaults
  // also cover editors/filesystems that silently lose native watch events.
  env:{...process.env,TSC_WATCHFILE:process.env.TSC_WATCHFILE||'DynamicPriorityPolling',TSC_WATCHDIRECTORY:process.env.TSC_WATCHDIRECTORY||'DynamicPriorityPolling'},
});
function send(value){if(process.connected)process.send(value);}
function consume(chunk){
  const text=chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  if(!watching){output+=text;if(output.length>4*1024*1024){overflow=true;void close();}return;}
  buffer+=text;
  // Consume complete lines, not arbitrary OS chunks. Start/completion markers
  // delimit each diagnostic generation; a successful edit clears old errors.
  let end;
  while((end=buffer.indexOf('\n'))!==-1){
    const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
    if(/Starting (?:incremental )?compilation in watch mode|File change detected/.test(line))output='';
    else if(/Found \d+ errors?\. Watching for file changes\./.test(line)){
      send({type:'diagnostics',errors:/Found 0 errors/.test(line)?[]:output.trim()?[output.trim()]:['TypeScript reported errors. Run prnext typecheck for details.']});output='';
    }else if(line.trim()&&output.length<20000)output+=(line+'\n').slice(0,20000-output.length);
  }
  if(buffer.length>20000)buffer=buffer.slice(-20000);
}
for(const stream of [child.stdout,child.stderr]){
  const decoder=new StringDecoder('utf8');stream.on('data',chunk=>consume(decoder.write(chunk)));stream.on('end',()=>consume(decoder.end()));
}
child.once('error',error=>{send({type:'failure',message:error.message});process.exitCode=1;});
child.once('close',async(code,signal)=>{
  // Only the directory returned by mkdtemp above is removed.
  if(path.dirname(cache)===path.resolve(tmpdir())&&path.basename(cache).startsWith('prnext-typescript-native-'))await rm(cache,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  send({type:'complete',code:overflow?1:code??1,output:overflow?'TypeScript output exceeded 4 MiB. Run tsc directly for the complete output.':output,signal});
  if(process.connected)process.disconnect();
});
async function close(){
  if(closing)return;closing=true;
  if(child.exitCode!==null||child.signalCode)return;
  if(process.platform==='win32'){
    // Own exactly this compiler subtree; TypeScript's official Node launcher
    // starts its native executable as a child on Windows.
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill('SIGKILL'));
  }else{try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
}
process.once('disconnect',()=>{void close();});
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
