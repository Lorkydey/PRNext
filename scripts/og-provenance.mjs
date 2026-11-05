import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sorted=entries=>Object.fromEntries([...entries].sort(([a],[b])=>a.localeCompare(b,'en')));
export function ogComponents(source,fflateVersion){
  const components=new Map();
  for(const match of source.matchAll(/^\/\/ node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)){
    const [,directory,name]=match,prefix=name.replace('/','+')+'@';
    if(!directory.startsWith(prefix))throw Error('Review the OG source component inventory.');
    const version=directory.slice(prefix.length).split('_')[0];
    if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw Error('Review the OG source component version.');
    if(name==='fflate')continue; // Replaced before bundling, including the embedded copy.
    const key=name+'@'+version;components.set(key,{name,version});
  }
  if(components.size<10||![...components.values()].some(item=>item.name==='satori')||![...components.values()].some(item=>item.name==='@resvg/resvg-wasm'))throw Error('Incomplete OG source component inventory.');
  components.set('fflate@'+fflateVersion,{name:'fflate',version:fflateVersion});
  return [...components.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version,'en'));
}
export async function ogInputs(root,source){
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  const packages={};
  for(const name of ['@vercel/og','fflate']){
    const item=lock.packages?.['node_modules/'+name];
    if(!item?.version||!/^sha512-/.test(item.integrity||''))throw Error('Missing locked OG source integrity.');
    packages[name]={version:item.version,integrity:item.integrity};
  }
  return {sourceSha256:digest(source),packages,components:[{name:'@vercel/og',version:packages['@vercel/og'].version},...ogComponents(source,packages.fflate.version)]};
}
export async function reviewOgInputs(directory,inputs,{reviewUpstream=false}={}){
  let previous;
  try{previous=JSON.parse(await readFile(path.join(directory,'upstream.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!reviewUpstream&&(!previous||JSON.stringify(previous.inputs)!==JSON.stringify(inputs)))throw Error('OG upstream inputs changed. Review advisories, versions and licenses, then use --review-upstream explicitly.');
}
export async function writeOgProvenance(directory,inputs){
  const files=[];
  for(const name of await readdir(directory)){
    if(name==='upstream.json')continue;
    const filename=path.join(directory,name);
    if(!(await lstat(filename)).isFile())throw Error('OG assets must be regular files.');
    files.push([name,digest(await readFile(filename))]);
  }
  const manifest={schemaVersion:1,name:'@vercel/og',inputs,files:sorted(files)};
  await writeFile(path.join(directory,'upstream.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
export async function verifyOgProvenance(directory){
  const manifest=JSON.parse(await readFile(path.join(directory,'upstream.json'),'utf8'));
  if(manifest.schemaVersion!==1||manifest.name!=='@vercel/og'||!Array.isArray(manifest.inputs?.components)||!manifest.files?.['index.node.mjs']||!manifest.files?.['resvg.wasm']||!manifest.files?.['NOTICE.txt'])throw Error('Incomplete OG provenance.');
  const names=(await readdir(directory)).filter(name=>name!=='upstream.json').sort();
  if(JSON.stringify(names)!==JSON.stringify(Object.keys(manifest.files).sort()))throw Error('OG asset inventory changed.');
  for(const name of names){
    const filename=path.join(directory,name);
    if(!(await lstat(filename)).isFile()||digest(await readFile(filename))!==manifest.files[name])throw Error('OG assets differ from the reviewed renderer.');
  }
  return manifest.inputs.components;
}
