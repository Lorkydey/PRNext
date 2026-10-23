import {fork} from 'node:child_process';
import {access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {privateCacheDirectory} from './persistent-cache.mjs';
export async function startTypeChecker(root,config,notify){
  const noop={inactive:true,async close(){}};
  if(config.typescript?.devChecks===false)return noop;
  const filename=path.resolve(root,config.typescript?.tsconfigPath||'tsconfig.json');try{await access(filename);}catch{return noop;}
  let compiler;try{compiler=createRequire(path.join(root,'package.json')).resolve('typescript');}catch{console.warn('TypeScript diagnostics require typescript installed in the application.');return noop;}
  const directory=await privateCacheDirectory(root,'typescript-dev');
  let child,closed=false,failures=0,timer;
  function launch(){
    if(closed)return;
    child=fork(new URL('./typescript-dev-worker.mjs',import.meta.url),[compiler,filename,directory?path.join(directory,'project.tsbuildinfo'):''],{cwd:root,execArgv:['--max-old-space-size=512'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
    let details='',healthyAt=0;child.stderr.on('data',chunk=>{details=(details+chunk).slice(-2048);});
    child.on('message',message=>{if(message?.type==='diagnostics'&&Array.isArray(message.errors)){healthyAt ||= Date.now();notify(message.errors.filter(value=>typeof value==='string').slice(0,40));}});
    child.on('error',error=>{notify(['TypeScript checker: '+error.message]);});
    child.once('exit',()=>{if(closed)return;if(healthyAt&&Date.now()-healthyAt>=60000)failures=0;if(++failures>=3){notify(['TypeScript checker stopped after repeated failures. '+details]);return;}timer=setTimeout(launch,1000*failures);});
  }
  launch();return {async close(){closed=true;clearTimeout(timer);const old=child;if(!old||old.exitCode!==null||old.signalCode)return;await new Promise(resolve=>{const timer=setTimeout(()=>old.kill('SIGKILL'),3000);old.once('exit',()=>{clearTimeout(timer);resolve();});if(old.connected)old.disconnect();else old.kill();});}};
}
