import {fork} from 'node:child_process';
import {access} from 'node:fs/promises';
import {resolveTypeScript} from './typescript-toolchain.mjs';
import path from 'node:path';
import {privateCacheDirectory} from './persistent-cache.mjs';
export async function startTypeChecker(root,config,notify){
  const noop={inactive:true,async close(){}};
  if(config.typescript?.devChecks===false)return noop;
  const filename=path.resolve(root,config.typescript?.tsconfigPath||'tsconfig.json');try{await access(filename);}catch{return noop;}
  let toolchain;try{toolchain=await resolveTypeScript(root);}catch(error){console.warn('TypeScript diagnostics could not start: '+error.message);return noop;}
  const directory=await privateCacheDirectory(root,'typescript-dev');
  let child,closed=false,failures=0,timer,restartTimer,planned;
  function launch(){
    if(closed)return;
    const worker=toolchain.native?'./typescript-native-worker.mjs':'./typescript-dev-worker.mjs';
    child=fork(new URL(worker,import.meta.url),[toolchain.compiler,filename,toolchain.native?'watch':directory?path.join(directory,'project.tsbuildinfo'):''],{cwd:root,execArgv:['--max-old-space-size=512'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
    let details='',healthyAt=0;child.stderr.on('data',chunk=>{details=(details+chunk).slice(-2048);});
    child.on('message',message=>{if(message?.type==='diagnostics'&&Array.isArray(message.errors)){healthyAt ||= Date.now();notify(message.errors.filter(value=>typeof value==='string').slice(0,40));}});
    child.on('error',error=>{notify(['TypeScript checker: '+error.message]);});
    const current=child;
    child.once('exit',()=>{if(closed)return;if(planned===current){planned=undefined;launch();return;}if(healthyAt&&Date.now()-healthyAt>=60000)failures=0;if(++failures>=3){notify(['TypeScript checker stopped after repeated failures. '+details]);return;}timer=setTimeout(launch,1000*failures);});
  }
  launch();return {
    invalidate(file,event){
      if(!toolchain.native||closed||(event!=='rename'&&!/\.json$/i.test(file)))return;
      const extension=path.extname(file);if(extension&&!/^\.(?:[cm]?[jt]sx?|json)$/i.test(extension))return;
      clearTimeout(restartTimer);restartTimer=setTimeout(()=>{if(closed||!child?.connected)return;planned=child;child.disconnect();},150);
    },
    async close(){closed=true;clearTimeout(timer);clearTimeout(restartTimer);const old=child;if(!old||old.exitCode!==null||old.signalCode)return;await new Promise(resolve=>{const timer=setTimeout(()=>old.kill('SIGKILL'),5000);old.once('exit',()=>{clearTimeout(timer);resolve();});if(old.connected)old.disconnect();else old.kill();});},
  };
}
