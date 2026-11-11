import {access,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const registry=fileURLToPath(new URL('../compat/client-instrumentation.cjs',import.meta.url));
export async function prepareClientInstrumentation(root,stage,config={}) {
  const found=[];
  for(const directory of['','src'])for(const extension of['ts','js','mjs','cjs']){
    const file=path.join(root,directory,'instrumentation-client.'+extension);
    try{await access(file);found.push(file)}catch(error){if(error.code!=='ENOENT')throw error}
  }
  if(found.length>1)throw Error('Only one instrumentation-client file is allowed, in the project root or src directory.');
  const resolve=createRequire(path.join(root,'package.json'));
  const injected=(config.instrumentationClientInject||[]).map(name=>resolve.resolve(name.startsWith('.')?path.resolve(root,name):name));
  const modules=[...new Set([...injected,...found])];
  if(!modules.length)return;
  const file=path.join(stage,'.entries/client-instrumentation.mjs');
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,modules.map((name,i)=>`import * as hook${i} from ${JSON.stringify(name)};`).join('\n')+`\nimport {registerClientInstrumentation} from ${JSON.stringify(registry)};\nregisterClientInstrumentation([${modules.map((_,i)=>`hook${i}.onRouterTransitionStart?hook${i}:hook${i}.default`).join(',')}]);\n`);
  return file;
}
