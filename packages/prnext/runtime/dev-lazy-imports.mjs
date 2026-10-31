import path from 'node:path';
import {constants} from 'node:fs';
import {readdir,readFile,writeFile,stat,lstat,open,mkdtemp,link,rm} from 'node:fs/promises';

export const MAX_LAZY_ASSET_BYTES=128*1024*1024;
export const MAX_LAZY_ASSET_FILES=16384;
const token=/^\/_prnext\/lazy\/([a-f0-9]{24})$/;
export function lazyImportIdentifier(raw){return token.exec(new URL(raw,'http://local').pathname)?.[1];}

function receiptFiles(receipt,cacheId){
  if(!receipt||receipt.version!==1||typeof cacheId!=='string'||!cacheId||cacheId.length>256||receipt.baseCacheId!==cacheId||!Array.isArray(receipt.files))throw Error('Invalid or obsolete deferred asset receipt');
  if(receipt.files.length>MAX_LAZY_ASSET_FILES)throw Error('Deferred import exceeded the asset count budget');
  const names=new Set(),files=[];let total=0;
  for(const file of receipt.files){
    const name=file?.name;
    if(typeof name!=='string'||!name||name.length>255||!/^[A-Za-z0-9_.-]+$/.test(name)||name==='.'||name==='..'||name.endsWith('.')||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)||names.has(name.toLowerCase()))throw Error('Invalid or duplicate deferred asset receipt name');
    if(!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_LAZY_ASSET_BYTES||(total+=file.bytes)>MAX_LAZY_ASSET_BYTES)throw Error('Deferred asset receipt exceeded the 128 MiB generation budget');
    names.add(name.toLowerCase());files.push({name,bytes:file.bytes});
  }
  return files;
}

function regularAsset(info,bytes){
  if(!info.isFile()||info.isSymbolicLink())throw Error('Invalid deferred asset: expected a regular file without symbolic links');
  if(info.size!==bytes)throw Error('Deferred asset does not match the receipt byte size');
  return info;
}

async function readReceiptAsset(filename,bytes,checked){
  const expected=checked||regularAsset(await lstat(filename),bytes);
  const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const info=regularAsset(await file.stat(),bytes);
    if(info.dev!==expected.dev||info.ino!==expected.ino)throw Error('Deferred asset changed after receipt validation');
    // Metadata can race a writer. Read only the declared size plus one byte,
    // rather than letting readFile allocate for a later, unbounded file size.
    const data=Buffer.allocUnsafe(bytes);let offset=0;
    while(offset<bytes){
      const {bytesRead}=await file.read(data,offset,bytes-offset,offset);
      if(!bytesRead)throw Error('Deferred asset ended before the receipt byte size');
      offset+=bytesRead;
    }
    if((await file.read(Buffer.allocUnsafe(1),0,1,bytes)).bytesRead)throw Error('Deferred asset exceeded the receipt byte size');
    return data;
  }finally{await file.close();}
}

async function readExistingReceiptAsset(filename,bytes){
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink())throw Error('Invalid deferred asset: expected a regular file without symbolic links');
  if(info.size!==bytes)throw Error('Deferred compilation produced a conflicting immutable asset');
  return readReceiptAsset(filename,bytes,info);
}

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
  const received=Object.hasOwn(built,'devLazyAssets');
  const files=received?receiptFiles(built.devLazyAssets,current.manifest.cacheId):await readdir(source,{withFileTypes:true}),pending=[];let bytes=0;
  if(files.length>MAX_LAZY_ASSET_FILES)throw Error('Deferred import exceeded the asset count budget');
  if(received){
    for(const directory of [source,destination]){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid deferred asset directory');}
    // Validate every declared file before reading any payload or publishing.
    for(const file of files)file.info=regularAsset(await lstat(path.join(source,file.name)),file.bytes);
  }
  for(const file of files){
    if(!received&&(!file.isFile()||file.name!==path.basename(file.name)))throw Error('Invalid deferred asset');
    if(!received&&(await stat(path.join(source,file.name))).size>MAX_LAZY_ASSET_BYTES)throw Error('Deferred import asset exceeded the 128 MiB generation budget');
    const data=received?await readReceiptAsset(path.join(source,file.name),file.bytes,file.info):await readFile(path.join(source,file.name));
    const previous=await(received?readExistingReceiptAsset(path.join(destination,file.name),file.bytes):readFile(path.join(destination,file.name))).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(previous){if(!previous.equals(data))throw Error('Deferred compilation produced a conflicting immutable asset');continue;}
    bytes+=data.length;
    if(bytes+(current.lazyAssetBytes||0)>MAX_LAZY_ASSET_BYTES)throw Error('Deferred import assets exceeded the 128 MiB generation budget');
    pending.push([file.name,data]);
  }
  if(pending.length){
    // Partial writes stay outside the served assets directory. A hard link
    // publishes a complete file atomically and exclusively without replacing an
    // immutable asset, even if another writer wins between inspection and I/O.
    const temporary=await mkdtemp(path.join(root,current.directory,'.lazy-publish-'));
    current.lazyAssetBytes=(current.lazyAssetBytes||0)+bytes;
    let retained=0,failure;
    try{
      for(const [name,data]of pending)await writeFile(path.join(temporary,name),data,{flag:'wx'});
      for(const [name,data]of pending){
        // A failed publication can have an uncertain outcome. Keep its charge
        // conservatively; a retry can reuse a complete asset without recharging.
        retained+=data.length;
        try{await link(path.join(temporary,name),path.join(destination,name));}
        catch(error){
          if(error.code!=='EEXIST')throw error;
          const existing=received?await readExistingReceiptAsset(path.join(destination,name),data.length):await readFile(path.join(destination,name));
          if(!existing.equals(data))throw Error('Deferred compilation produced a conflicting immutable asset');
          retained-=data.length;
        }
      }
    }catch(error){failure=error;}
    try{
      await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
      // Reclaim only unpublished bytes after deletion of our private staging
      // files is confirmed. Complete public files are never removed on failure.
      current.lazyAssetBytes-=bytes-retained;
    }catch(error){
      if(failure){failure.cleanupError=error;failure.message+='; deferred asset staging cleanup also failed';}
      else failure=error;
    }
    if(failure)throw failure;
  }
  registry.modules=next.modules;registry.bridges=next.bridges;registry.shared=next.shared;
  Object.assign(registry.outputs,next.outputs);
  return target;
}
