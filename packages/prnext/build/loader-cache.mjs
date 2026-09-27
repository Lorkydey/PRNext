import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_ENTRY = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
async function fileHash(file) {
  try { if ((await stat(file)).size > MAX_ENTRY) return null; return hash(await readFile(file)); }
  catch(error) { if(error.code === 'ENOENT') return 'missing'; throw error; }
}
async function directoryHash(root) {
  const records = []; let count = 0;
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      if (++count > 10000) throw new Error('Loader context dependency exceeds 10000 files');
      const file=path.join(directory,name), metadata=await stat(file);
      records.push([path.relative(root,file),metadata.isDirectory()?'directory':await fileHash(file)]);
      if(metadata.isDirectory())await walk(file);
    }
  }
  try { await walk(root); return hash(JSON.stringify(records)); }
  catch(error) { if(error.code==='ENOENT')return 'missing'; throw error; }
}
function loaderModules(loaders) {
  const files=new Set();
  function visit(file){if(files.has(file))return;files.add(file);for(const child of require.cache[file]?.children || [])visit(child.filename);}
  for(const loader of loaders)visit(loader.loader);
  return [...files];
}
async function snapshot(files,contexts,missing) {
  return {files:await Promise.all([...new Set([...files,...missing])].sort().map(async file=>[file,await fileHash(file)])),
    contexts:await Promise.all([...new Set(contexts)].sort().map(async file=>[file,await directoryHash(file)]))};
}
async function valid(snapshot) {
  if(snapshot.files.some(([,digest])=>digest===null))return false;
  for(const [file,digest] of snapshot.files)if(await fileHash(file)!==digest)return false;
  for(const [file,digest] of snapshot.contexts)if(await directoryHash(file)!==digest)return false;
  return true;
}
async function prune(directory) {
  const entries = await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.json')).map(async name=>({name,...await stat(path.join(directory,name))})));
  entries.sort((a,b)=>b.mtimeMs-a.mtimeMs);let bytes=0;
  for(let index=0;index<entries.length;index++){bytes+=entries[index].size;if(index>=256||bytes>MAX_TOTAL)await rm(path.join(directory,entries[index].name),{force:true});}
}
/** Cache only loaders which opt into dependency tracking; no render output enters this cache. */
export async function cachedLoader(options,run) {
  let serializable = true;
  try { JSON.stringify(options,(_key,value)=>{if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint'||value instanceof RegExp)serializable=false;return value;}); } catch { serializable=false; }
  if (!serializable) return run();
  const directory=path.join(options.root,'.prnext-cache','loaders-v1');
  const key=hash(JSON.stringify({...options,env:hash(JSON.stringify(Object.entries(process.env).sort()))}));
  const file=path.join(directory,key+'.json');
  try {
    if((await stat(file)).size<=MAX_ENTRY){const cached=JSON.parse(await readFile(file,'utf8'));if(cached.version===1&&await valid(cached.snapshot))return cached.result;}
  } catch(error) { if(!['ENOENT','ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  for (const file of loaderModules(options.loaders)) delete require.cache[file];
  const result=await run();
  if(result.cacheable===false)return result;
  const dependencies=[...new Set([options.file,...result.dependencies,...loaderModules(options.loaders),...['package.json','package-lock.json','pnpm-lock.yaml','yarn.lock'].map(name=>path.join(options.root,name))])];
  const current=await snapshot(dependencies,result.contexts,result.missing);
  const body=JSON.stringify({version:1,snapshot:current,result:{...result,dependencies}});
  if(Buffer.byteLength(body)>MAX_ENTRY || current.files.some(([,value])=>value===null))return result;
  await mkdir(directory,{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {await writeFile(temporary,body);await rename(temporary,file);}finally{await rm(temporary,{force:true});}
  await prune(directory);
  return result;
}
