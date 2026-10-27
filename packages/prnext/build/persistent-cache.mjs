// Private, bounded, best-effort caches. A missing/corrupt cache never changes
// build correctness; only framework-owned pure outputs may be stored here.
import {createHash,randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {open,lstat,mkdir,realpath,readFile,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

export const cacheHash=value=>createHash('sha256').update(value).digest('hex');
const packageRoot=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const MAX_DISK=64*1024*1024;
let frameworkIdentity;
async function frameworkHash(){
  frameworkIdentity??=(async()=>{
    const files=(await readdir(path.join(packageRoot,'build'))).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).sort();
    const hash=createHash('sha256');
    for(const f of files)hash.update(f).update(await readFile(path.join(packageRoot,'build',f)));
    hash.update(await readFile(path.join(packageRoot,'package.json')));
    for(const name of ['@babel/core','@babel/parser','@babel/traverse','@babel/generator','@babel/types','babel-plugin-react-compiler','esbuild'])hash.update(name+':'+require(name+'/package.json').version);
    return hash.digest('hex');
  })();
  return frameworkIdentity;
}
export async function buildCacheIdentity(root){
  const hash=createHash('sha256').update(await frameworkHash()).update(process.version).update(await realpath(root));
  for(const name of ['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','.env','.env.local','.env.production','.env.production.local','.env.development','.env.development.local','.env.test','.env.test.local']){
    hash.update(name);
    try{const f=await open(path.join(root,name));try{if((await f.stat()).size>16*1024*1024)return null;hash.update(await f.readFile());}finally{await f.close();}}catch(e){if(e.code!=='ENOENT')return null;hash.update('missing');}
  }
  // Never write environment values, credentials or encryption keys into the
  // cache identity. Environment-sensitive pure transforms still invalidate.
  hash.update(cacheHash(JSON.stringify(Object.entries(process.env).sort())));
  return hash.digest('hex');
}
export async function privateCacheDirectory(root,kind){
  if(process.env.PRNEXT_BUILD_CACHE==='0'||!/^[a-z0-9-]+$/.test(kind))return null;
  try{
    let directory=await realpath(root);
    for(const part of ['.prnext-cache',kind]){
      directory=path.join(directory,part);
      try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
      const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return null;
    }
    return directory;
  }catch{return null;}
}
/** Best-effort V8 cache retention; never follow links or traverse app sources. */
export async function pruneCompilerCache(directory,{maxBytes=64*1024*1024,maxFiles=2048}={}){
  if(!directory)return;
  try{
    const files=[];let scanned=0;
    async function collect(folder,depth){
      if(depth>3||scanned>=8192)return;
      for(const entry of await readdir(folder,{withFileTypes:true})){
        if(++scanned>8192)break;
        const name=path.join(folder,entry.name),info=await lstat(name).catch(()=>null);
        if(!info||info.isSymbolicLink())continue;
        if(info.isDirectory())await collect(name,depth+1);
        else if(info.isFile())files.push({name,size:info.size,time:info.mtimeMs});
      }
    }
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return;
    await collect(directory,0);files.sort((a,b)=>b.time-a.time);let bytes=0;
    for(let i=0;i<files.length;i++){bytes+=files[i].size;if(i>=maxFiles||bytes>maxBytes)await unlink(files[i].name).catch(()=>{});}
  }catch{/* Optional caches must never prevent compilation. */}
}
export async function readCacheRecord(directory,key,limit=16*1024*1024){
  if(!directory||!/^[a-f0-9]{64}$/.test(key))return null;
  let file;
  try{
    const name=path.join(directory,key+'.json'),info=await lstat(name);
    if(!info.isFile()||info.isSymbolicLink()||info.size>limit)return null;
    file=await open(name,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
    const stat=await file.stat();if(!stat.isFile()||stat.size>limit)return null;
    const record=JSON.parse(await file.readFile('utf8'));
    if(record.version!==1||record.key!==key||typeof record.payload!=='string'||cacheHash(record.payload)!==record.checksum)return null;
    return JSON.parse(record.payload);
  }catch{return null;}finally{await file?.close().catch(()=>{});}
}
export async function writeCacheRecord(directory,key,value,limit=16*1024*1024){
  if(!directory||!/^[a-f0-9]{64}$/.test(key))return false;
  const filename=path.join(directory,key+'.json'),temporary=filename+'.'+randomUUID()+'.tmp';
  try{
    const payload=JSON.stringify(value),body=JSON.stringify({version:1,key,checksum:cacheHash(payload),payload});
    if(Buffer.byteLength(body)>limit)return false;
    const file=await open(temporary,'wx',0o600);try{await file.writeFile(body);}finally{await file.close();}
    await rename(temporary,filename);
    const records=[];
    for(const name of await readdir(directory))if(/^[a-f0-9]{64}\.json$/.test(name)){
      const stat=await lstat(path.join(directory,name)).catch(()=>null);if(stat?.isFile()&&!stat.isSymbolicLink())records.push({name,size:stat.size,time:stat.mtimeMs});
    }
    records.sort((a,b)=>b.time-a.time);let total=0;
    for(let i=0;i<records.length;i++){total+=records[i].size;if(i>=64||total>MAX_DISK)await unlink(path.join(directory,records[i].name)).catch(()=>{});}
    return true;
  }catch{return false;}finally{await unlink(temporary).catch(()=>{});}
}
