import path from 'node:path';
import {readdir,readFile,writeFile,stat} from 'node:fs/promises';

export const MAX_LAZY_ASSET_BYTES=128*1024*1024;
const token=/^\/_prnext\/lazy\/([a-f0-9]{24})$/;
export function lazyImportIdentifier(raw){return token.exec(new URL(raw,'http://local').pathname)?.[1];}

/** Only registered tokens can reach the compiler. The caller serializes builds. */
export async function materializeDevImport({root,current,id,compile}){
  const registry=current.manifest.devLazy;
  if(!registry||!registry.modules.some(item=>item.id===id))throw Error('Unknown deferred import identifier');
  if(registry.outputs[id])return registry.outputs[id];
  const built=await compile({id,modules:registry.modules,bridges:registry.bridges,shared:registry.shared});
  const next=built.devLazy,target=next?.outputs?.[id];
  if(!target)throw Error('The compiler did not produce the requested deferred import');
  // New server implementations cannot be added to a running immutable runtime.
  // Existing Server Action proxies are reused through the static ESM bridges.
  if(Object.keys(built.app?.actions||{}).some(key=>!Object.hasOwn(current.manifest.app?.actions||{},key)))throw Error('A deferred module introduced a new Server Action. Import that action statically or disable experimental.lazyDynamicImports.');
  const source=path.join(built.outputDirectory,'assets'),destination=path.join(root,current.directory,'assets');
  const files=await readdir(source,{withFileTypes:true}),pending=[];let bytes=0;
  if(files.length>16384)throw Error('Deferred import exceeded the asset count budget');
  for(const file of files){
    if(!file.isFile()||file.name!==path.basename(file.name))throw Error('Invalid deferred asset');
    const info=await stat(path.join(source,file.name));
    if(info.size>MAX_LAZY_ASSET_BYTES)throw Error('Deferred import asset exceeded the 128 MiB generation budget');
    const data=await readFile(path.join(source,file.name));
    const previous=await readFile(path.join(destination,file.name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(previous){if(!previous.equals(data))throw Error('Deferred compilation produced a conflicting immutable asset');continue;}
    bytes+=data.length;
    if(bytes+(current.lazyAssetBytes||0)>MAX_LAZY_ASSET_BYTES)throw Error('Deferred import assets exceeded the 128 MiB generation budget');
    pending.push([file.name,data]);
  }
  // Write complete files exclusively. The descriptor is published only when all
  // its dependencies exist; no in-flight request sees an overwritten asset.
  for(const [name,data]of pending){
    // Reserve before I/O: writeFile can leave a partial file before rejecting.
    // A retry may skip that file, so failed writes must remain conservatively
    // charged until the owning generation is retired.
    current.lazyAssetBytes=(current.lazyAssetBytes||0)+data.length;
    await writeFile(path.join(destination,name),data,{flag:'wx'});
  }
  registry.modules=next.modules;registry.bridges=next.bridges;registry.shared=next.shared;
  Object.assign(registry.outputs,next.outputs);
  return target;
}
