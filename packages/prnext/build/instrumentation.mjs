import {access,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {build} from './compiler.mjs';
import {compileEdge} from './edge.mjs';
import {moduleResolutionPlugin} from './module-resolution.mjs';

export async function compileInstrumentation({root,stage,manifest,config,dev,environment}) {
  const found=[];
  for(const directory of ['', 'src'])for(const extension of ['ts','js','mjs','cjs']){
    const file=path.join(root,directory,'instrumentation.'+extension);
    try{await access(file);found.push(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!found.length)return;
  if(found.length>1)throw Error('Only one instrumentation file is allowed, in the project root or src directory.');
  const file=found[0],entry=path.join(stage,'.entries/instrumentation.mjs');manifest.instrumentation={};
  await mkdir(path.dirname(entry),{recursive:true});
  await writeFile(entry,`import * as hooks from ${JSON.stringify(file)};export const register=hooks.register??hooks.default?.register;export const onRequestError=hooks.onRequestError??hooks.default?.onRequestError;`);
  for(const runtime of ['node','rsc']){
    const module=`server/instrumentation-${runtime}.mjs`;
    await build({absWorkingDir:root,entryPoints:[entry],outfile:path.join(stage,module),bundle:true,packages:'external',platform:'node',format:'esm',target:'node22',banner:{js:"import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);"},conditions:runtime==='rsc'?['react-server']:[],sourcemap:dev,logLevel:'silent',
      define:{...environment,'process.env.NODE_ENV':JSON.stringify(dev?'development':'production'),'process.env.NEXT_RUNTIME':'"nodejs"'},
      plugins:[moduleResolutionPlugin(config.turbopack,root)]});
    manifest.instrumentation[runtime]=module;
  }
  if(manifest.middleware?.runtime==='edge'||manifest.routes.some(route=>route.cacheConfig?.runtime==='edge'||route.handlerConfig?.runtime==='edge')){
    const module='server/instrumentation-edge.mjs';
    await compileEdge({file:entry,outfile:path.join(stage,module),projectRoot:root,dev,defineEnvironment:environment});
    manifest.instrumentation.edge=module;
  }
}
