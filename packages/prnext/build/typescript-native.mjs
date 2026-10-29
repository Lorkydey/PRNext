import {fork} from 'node:child_process';

export function checkNativeTypeScript(compiler,filename,root){
  return new Promise((resolve,reject)=>{
    const child=fork(new URL('./typescript-native-worker.mjs',import.meta.url),[compiler,filename,'check'],{cwd:root,windowsHide:true,execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
    let result,details='',timedOut=false,force;
    const deadline=setTimeout(()=>{timedOut=true;if(child.connected)child.disconnect();force=setTimeout(()=>child.kill('SIGKILL'),5000);},120000);
    child.stderr.on('data',chunk=>{details=(details+chunk).slice(-8192);});
    child.on('message',message=>{if(message?.type==='complete')result=message;else if(message?.type==='failure')details=String(message.message).slice(0,8192);});
    child.once('error',error=>{clearTimeout(deadline);clearTimeout(force);reject(error);});
    child.once('exit',()=>{
      clearTimeout(deadline);clearTimeout(force);
      if(timedOut)reject(new Error('TypeScript check exceeded 120 seconds. Run tsc directly to inspect the project.'));
      else if(result?.code===0)resolve();
      else reject(new Error(result?.output||details||'TypeScript native checker exited before returning diagnostics.'));
    });
  });
}
