import { rename } from '../runtime/fs.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, open, unlink, readdir, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {privateCacheDirectory,readCacheRecord} from './persistent-cache.mjs';
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_ENTRY = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
const MAX_DEPENDENCIES=10000;
async function fileHash(file) {
  try { if ((await stat(file)).size > MAX_ENTRY) return null; return hash(await readFile(file)); }
  catch(error) { if(error.code === 'ENOENT') return 'missing'; throw error; }
}
async function directoryHash(root) {
  try{if(!(await stat(root)).isDirectory())return null;}catch(error){if(error.code==='ENOENT')return 'missing';throw error;}
  const records = [],seen=new Set(); let count = 0;
  async function walk(directory) {
    const canonical=await realpath(directory);if(seen.has(canonical))throw new Error('Cyclic loader context dependency');seen.add(canonical);
    for (const name of (await readdir(directory)).sort()) {
      if (++count > MAX_DEPENDENCIES) throw new Error('Loader context dependency exceeds 10000 files');
      const file=path.join(directory,name), metadata=await stat(file);
      const digest=metadata.isDirectory()?'directory':await fileHash(file);
      if(digest===null||digest==='missing')throw new Error('Unstable or excessive loader context dependency');
      records.push([path.relative(root,file),digest]);
      if(metadata.isDirectory())await walk(file);
    }
    seen.delete(canonical);
  }
  await walk(root);return hash(JSON.stringify(records));
}
function loaderModules(loaders) {
  const files=new Set();
  function visit(file){if(files.has(file))return;files.add(file);for(const child of require.cache[file]?.children || [])visit(child.filename);}
  for(const loader of loaders)visit(loader.loader);
  return [...files];
}
async function snapshot(files,contexts,missing) {
  if(files.length+contexts.length+missing.length>MAX_DEPENDENCIES)throw new Error('Excessive loader dependencies');
  return {files:await Promise.all([...new Set([...files,...missing])].sort().map(async file=>[file,await fileHash(file)])),
    contexts:await Promise.all([...new Set(contexts)].sort().map(async file=>[file,await directoryHash(file)]))};
}
async function valid(snapshot) {
  if(!validSnapshot(snapshot))return false;
  for(const [file,digest] of snapshot.files)if(await fileHash(file)!==digest)return false;
  for(const [file,digest] of snapshot.contexts)if(await directoryHash(file)!==digest)return false;
  return true;
}
async function prune(directory) {
  const entries=[];
  for(const name of await readdir(directory))if(/^[a-f0-9]{64}\.json$/.test(name)){
    const info=await lstat(path.join(directory,name)).catch(()=>null);
    if(info?.isFile()&&!info.isSymbolicLink())entries.push({name,size:info.size,mtimeMs:info.mtimeMs});
  }
  entries.sort((a,b)=>b.mtimeMs-a.mtimeMs);let bytes=0;
  for(let index=0;index<entries.length;index++){bytes+=entries[index].size;if(index>=256||bytes>MAX_TOTAL)await unlink(path.join(directory,entries[index].name)).catch(()=>{});}
}
const validFile=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0')&&value.length<=32768;
const validFiles=value=>Array.isArray(value)&&value.length<=MAX_DEPENDENCIES&&value.every(validFile);
const digest=value=>value==='missing'||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function validSnapshot(value){return !!value&&typeof value==='object'&&['files','contexts'].every(key=>Array.isArray(value[key])&&value[key].length<=MAX_DEPENDENCIES&&value[key].every(item=>Array.isArray(item)&&item.length===2&&validFile(item[0])&&digest(item[1])));}
function validResult(value){
  return !!value&&typeof value==='object'&&typeof value.source==='string'&&value.source.length<=MAX_ENTRY&&
    ['dependencies','contexts','missing'].every(key=>validFiles(value[key]))&&
    Array.isArray(value.warnings)&&value.warnings.length<=MAX_DEPENDENCIES&&value.warnings.every(item=>typeof item==='string')&&
    Array.isArray(value.assets)&&value.assets.length<=4096&&value.assets.every(item=>item&&typeof item.name==='string'&&!path.isAbsolute(item.name)&&!/[\\\0?#]/.test(item.name)&&item.name.split('/').every(part=>part&&part!=='.'&&part!=='..')&&typeof item.data==='string'&&item.data.length<=MAX_ENTRY&&item.data.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))&&
    (value.map===undefined||value.map&&typeof value.map==='object'&&!Array.isArray(value.map)&&value.map.version===3)&&
    (value.cacheable===undefined||typeof value.cacheable==='boolean');
}
async function publish(directory,key,value){
  const payload=JSON.stringify(value),body=JSON.stringify({version:1,key,checksum:hash(payload),payload});
  if(Buffer.byteLength(body)>MAX_ENTRY)return;
  const destination=path.join(directory,key+'.json'),temporary=destination+'.'+randomUUID()+'.tmp';
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(body);}finally{await file.close();}await rename(temporary,destination);await prune(directory);}
  finally{await unlink(temporary).catch(()=>{});}
}
/** Cache only loaders which opt into dependency tracking; no render output enters this cache. */
export async function cachedLoader(options,run) {
  const execute=()=>{for(const file of loaderModules(options.loaders))delete require.cache[file];return run();};
  if(process.env.PRNEXT_BUILD_CACHE==='0')return execute();
  let serializable = true;
  try { JSON.stringify(options,(_key,value)=>{if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint'||value instanceof RegExp)serializable=false;return value;}); } catch { serializable=false; }
  if (!serializable) return execute();
  let directory,key;
  try {
    directory=await privateCacheDirectory(options.root,'loaders-v2');
    if(directory){key=hash(JSON.stringify({...options,node:process.version,env:hash(JSON.stringify(Object.entries(process.env).sort()))}));const cached=await readCacheRecord(directory,key,MAX_ENTRY);if(cached?.format===2&&validResult(cached.result)&&await valid(cached.snapshot))return cached.result;}
  } catch{/* Cache availability and malformed records never prevent a loader run. */}
  const result=await execute();
  if(!directory||!key||result?.cacheable===false||!validResult(result))return result;
  try{
    const dependencies=[...new Set([options.file,...result.dependencies,...loaderModules(options.loaders),...['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'].map(name=>path.join(options.root,name))])];
    const current=await snapshot(dependencies,result.contexts,result.missing);
    if(validSnapshot(current))await publish(directory,key,{format:2,snapshot:current,result:{...result,dependencies}});
  }catch{/* Successful loader output remains usable when snapshot/publication fails. */}
  return result;
}
