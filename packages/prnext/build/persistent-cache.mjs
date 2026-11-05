// Private, bounded, best-effort caches. A missing/corrupt cache never changes
// build correctness; only framework-owned pure outputs may be stored here.
import {createHash,randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {open,lstat,mkdir,realpath,readFile,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {deflateRaw,inflateRaw} from 'node:zlib';
import {promisify} from 'node:util';
export {pruneCompilerCache} from '../runtime/compile-cache-retention.mjs';

export const cacheHash=value=>createHash('sha256').update(value).digest('hex');
const packageRoot=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const MAX_DISK=64*1024*1024;
const compress=promisify(deflateRaw),decompress=promisify(inflateRaw);
const MAGIC=Buffer.from('PRNC2\0'),HEADER=MAGIC.length+4+32+32;
let frameworkIdentity;
async function frameworkHash(){
  frameworkIdentity??=(async()=>{
    const files=(await readdir(path.join(packageRoot,'build'))).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).sort();
    const hash=createHash('sha256');
    for(const f of files)hash.update(f).update(await readFile(path.join(packageRoot,'build',f)));
    hash.update(await readFile(path.join(packageRoot,'package.json')));
    for(const name of ['@babel/core','@babel/parser','@babel/traverse','@babel/generator','@babel/types','babel-plugin-react-compiler','esbuild'])hash.update(name+':'+require(name+'/package.json').version);
    // CSS graph outputs also depend on the installed style engine and browser
    // database, including nested/non-hoisted installations with different pins.
    for(const name of ['lightningcss','browserslist','caniuse-lite','electron-to-chromium','postcss','postcss-value-parser','postcss-flexbugs-fixes','postcss-preset-env']){
      let filename;
      try{filename=require.resolve(name+'/package.json');}
      catch{
        let directory=path.dirname(require.resolve(name));
        while(true){
          try{const candidate=path.join(directory,'package.json'),value=JSON.parse(await readFile(candidate,'utf8'));if(value.name===name){filename=candidate;break;}}catch{}
          const parent=path.dirname(directory);if(parent===directory)throw new Error(`Cannot fingerprint ${name}`);directory=parent;
        }
      }
      hash.update(name).update(await readFile(filename));
    }
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
export async function readCacheRecord(directory,key,limit=16*1024*1024){
  if(!directory||!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(limit)||limit<1||limit>64*1024*1024)return null;
  let file;
  try{
    const name=path.join(directory,key+'.json'),info=await lstat(name);
    if(!info.isFile()||info.isSymbolicLink()||info.size>limit)return null;
    file=await open(name,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
    const stat=await file.stat();if(!stat.isFile()||stat.size>limit)return null;
    const body=await file.readFile();
    if(body.subarray(0,MAGIC.length).equals(MAGIC)){
      if(body.length<HEADER)return null;
      const size=body.readUInt32BE(MAGIC.length);
      if(size>limit||body.subarray(MAGIC.length+4,MAGIC.length+36).toString('hex')!==key)return null;
      const payload=await decompress(body.subarray(HEADER),{maxOutputLength:Math.max(1,size)});
      if(payload.length!==size||cacheHash(payload)!==body.subarray(MAGIC.length+36,HEADER).toString('hex'))return null;
      return JSON.parse(payload.toString('utf8'));
    }
    const record=JSON.parse(body.toString('utf8'));
    if(record.version!==1||record.key!==key||typeof record.payload!=='string'||cacheHash(record.payload)!==record.checksum)return null;
    return JSON.parse(record.payload);
  }catch{return null;}finally{await file?.close().catch(()=>{});}
}
export async function writeCacheRecord(directory,key,value,limit=16*1024*1024,{maxFiles=64}={}){
  if(!directory||!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(limit)||limit<1||limit>64*1024*1024)return false;
  if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>4096)return false;
  const filename=path.join(directory,key+'.json'),temporary=filename+'.'+randomUUID()+'.tmp';
  try{
    const payload=JSON.stringify(value);if(payload===undefined||Buffer.byteLength(payload)>limit)return false;
    let body=JSON.stringify({version:1,key,checksum:cacheHash(payload),payload});
    // Large, repetitive JSON benefits from one encoding instead of embedding a
    // second escaped JSON string. Keep small records compatible with v1.
    if(Buffer.byteLength(payload)>=16384){
      const bytes=Buffer.from(payload),packed=await compress(bytes,{level:1});
      if(packed.length+HEADER<bytes.length*0.9){
        const header=Buffer.alloc(HEADER);MAGIC.copy(header);header.writeUInt32BE(bytes.length,MAGIC.length);
        Buffer.from(key,'hex').copy(header,MAGIC.length+4);Buffer.from(cacheHash(bytes),'hex').copy(header,MAGIC.length+36);
        body=Buffer.concat([header,packed]);
      }
    }
    if(Buffer.byteLength(body)>limit)return false;
    const file=await open(temporary,'wx',0o600);try{await file.writeFile(body);}finally{await file.close();}
    await rename(temporary,filename);
    const records=[];
    for(const name of await readdir(directory))if(/^[a-f0-9]{64}\.json$/.test(name)){
      const stat=await lstat(path.join(directory,name)).catch(()=>null);if(stat?.isFile()&&!stat.isSymbolicLink())records.push({name,size:stat.size,time:stat.mtimeMs});
    }
    records.sort((a,b)=>b.time-a.time);let total=0;
    for(let i=0;i<records.length;i++){total+=records[i].size;if(i>=maxFiles||total>MAX_DISK)await unlink(path.join(directory,records[i].name)).catch(()=>{});}
    return true;
  }catch{return false;}finally{await unlink(temporary).catch(()=>{});}
}
