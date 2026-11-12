import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const adapters=new WeakMap();
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;

// Lifecycle names follow Next's adapter API; executable output has an explicit
// PRNext discriminator. A Next server entry cannot be invoked as a PRNext worker.
export async function prepareDeploymentAdapter(root,input,{phase,load}={}) {
  const configured=input.adapterPath??input.experimental?.adapterPath??process.env.NEXT_ADAPTER_PATH;
  if(configured===undefined)return {input};
  if(typeof configured!=='string'||!configured||configured.includes('\0'))throw new TypeError('adapterPath must be a nonempty module path');
  if(input.adapterPath&&input.experimental?.adapterPath&&input.adapterPath!==input.experimental.adapterPath)throw new Error('Conflicting adapterPath settings');
  const resolve=createRequire(path.join(root,'package.json')).resolve;
  const file=resolve(configured.startsWith('.')?path.resolve(root,configured):configured);
  const namespace=load?{default:await load(file)}:await import(pathToFileURL(file).href);
  const adapter=namespace.default??namespace;
  if(!adapter||typeof adapter!=='object'||typeof adapter.name!=='string'||!adapter.name||adapter.prnextAdapterVersion!==1)throw new TypeError('Deployment adapter must declare name and prnextAdapterVersion: 1. Next.js executable outputs require a PRNext adapter implementation.');
  for(const name of ['modifyConfig','onBuildComplete'])if(adapter[name]!==undefined&&typeof adapter[name]!=='function')throw new TypeError(`Adapter ${name} must be a function`);
  const context={framework:'prnext',prnextVersion:version,phase,projectDir:root};
  const modified=adapter.modifyConfig?await adapter.modifyConfig(input,context):input;
  if(!modified||typeof modified!=='object'||Array.isArray(modified))throw new TypeError('Adapter modifyConfig must return a configuration object');
  return {input:modified,adapter};
}
export function rememberDeploymentAdapter(config,adapter){if(adapter)adapters.set(config,adapter);return config;}
export async function completeDeploymentAdapter(config,{projectDir,distDir,manifest}) {
  const adapter=adapters.get(config);
  if(!adapter?.onBuildComplete)return;
  const output=JSON.parse(await readFile(path.join(distDir,'build-output.json'),'utf8'));
  const contract=output.server?JSON.parse(await readFile(path.join(distDir,output.server.runtimeContract),'utf8')):null;
  await adapter.onBuildComplete({framework:'prnext',prnextVersion:version,projectDir,distDir,config,buildId:manifest.buildId,output,manifest:structuredClone(manifest),runtimeContract:contract});
}
