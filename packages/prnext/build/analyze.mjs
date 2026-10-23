import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync,constants} from 'node:zlib';
import {readBuildDirectory} from '../runtime/build-directory.mjs';

export function recordBuildAnalysis(state,options,result){
  if(!state?.stage||!result.metafile)return;
  state.analysis ||= new Map();
  state.analysisRoutes ||= new Map();
  const outputs=new Map(Object.entries(result.metafile.outputs).map(([file,info])=>[path.resolve(options.absWorkingDir||state.root,file),info]));
  for(const [absolute,info] of outputs){
    const relative=path.relative(state.stage,absolute).replaceAll(path.sep,'/');
    if(!info.entryPoint||!relative.startsWith('server/'))continue;
    const visited=new Set(),inputs=new Set(),pending=[absolute];
    while(pending.length){
      const next=pending.pop();if(visited.has(next))continue;visited.add(next);
      const output=outputs.get(next);if(!output)continue;
      for(const name of Object.keys(output.inputs||{}))inputs.add(path.relative(state.root,path.resolve(options.absWorkingDir||state.root,name)).replaceAll(path.sep,'/'));
      for(const item of output.imports||[])if(!item.external)pending.push(path.resolve(options.absWorkingDir||state.root,item.path));
    }
    state.analysisRoutes.set(relative,inputs);
  }
  for(const [file,info] of Object.entries(result.metafile.outputs)){
    const absolute=path.resolve(options.absWorkingDir||state.root,file);
    const relative=path.relative(path.join(state.stage,'assets'),absolute).replaceAll(path.sep,'/');
    if(relative.startsWith('../')||path.isAbsolute(relative)||!relative.endsWith('.js'))continue;
    state.analysis.set(relative,{file:relative,bytes:info.bytes,imports:(info.imports||[]).filter(item=>!item.external).map(item=>({file:path.relative(path.join(state.stage,'assets'),path.resolve(options.absWorkingDir||state.root,item.path)).replaceAll(path.sep,'/'),kind:item.kind})),
      modules:Object.entries(info.inputs||{}).map(([name,record])=>({file:path.relative(state.root,path.resolve(options.absWorkingDir||state.root,name)).replaceAll(path.sep,'/').replace(/\.prnext-build-[^/]+\//g,'<generated>/'),bytes:record.bytesInOutput})).sort((a,b)=>b.bytes-a.bytes).slice(0,100)});
  }
}
function initialFiles(entry,files){
  const seen=new Set(),pending=[entry];
  while(pending.length){const name=pending.pop();if(seen.has(name)||!files.has(name))continue;seen.add(name);for(const item of files.get(name).imports)if(item.kind!=='dynamic-import')pending.push(item.file);}
  return [...seen].sort();
}
export async function writeBuildAnalysis({root,stage,destination,manifest,records,routeInputs}){
  const files=new Map(records||[]);
  for(const info of files.values()){
    const data=await readFile(path.join(stage,'assets',info.file));
    info.bytes=data.length;info.gzipBytes=gzipSync(data).length;
    info.brotliBytes=brotliCompressSync(data,{params:{[constants.BROTLI_PARAM_QUALITY]:5}}).length;
  }
  const routes=manifest.routes.filter(route=>!route.internal&&route.kind==='page').map(route=>{
    const client=route.client?decodeURIComponent(new URL(route.client,'http://local').pathname).split('/').pop():null;
    const entries=client?[client]:[];
    if(route.router==='app')for(const file of routeInputs?.get(route.module)||[]){
      const id='client-'+createHash('sha256').update(file).digest('hex').slice(0,16);
      const entry=manifest.app?.clientModules?.[id]?.browserModule;
      if(entry)entries.push(new URL(entry,'http://local').pathname.split('/').pop());
    }
    const assets=[...new Set(entries.flatMap(entry=>initialFiles(entry,files)))].sort();
    return {route:route.pattern,files:assets,jsBytes:assets.reduce((total,file)=>total+files.get(file).bytes,0),gzipBytes:assets.reduce((total,file)=>total+files.get(file).gzipBytes,0),brotliBytes:assets.reduce((total,file)=>total+files.get(file).brotliBytes,0)};
  });
  const report={version:1,buildId:manifest.buildId,routes,files:[...files.values()],totalJsBytes:[...files.values()].reduce((n,item)=>n+item.bytes,0)};
  try{const previous=await readReport(path.join(destination,'build-analysis.json'));report.previous={buildId:previous.buildId,totalJsBytes:previous.totalJsBytes,routes:previous.routes.map(({route,jsBytes})=>({route,jsBytes}))};}catch(error){if(error.code!=='ENOENT')console.warn('Previous bundle analysis could not be read; comparison unavailable.');}
  await writeFile(path.join(stage,'build-analysis.json'),JSON.stringify(report));
  return report;
}
async function readReport(file){
  if((await stat(file)).size>16*1024*1024)throw new Error('Bundle analysis exceeds 16 MiB');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(value.version!==1||!Array.isArray(value.routes)||!Array.isArray(value.files))throw new Error('Invalid bundle analysis; rebuild with this PRNext version.');
  return value;
}
export async function analyzeBuild(root,{maxJs}={}){
  const report=await readReport(path.join(root,await readBuildDirectory(root),'build-analysis.json'));
  const previous=new Map((report.previous?.routes||[]).map(route=>[route.route,route.jsBytes]));
  report.routes=report.routes.map(route=>({...route,deltaBytes:previous.has(route.route)?route.jsBytes-previous.get(route.route):null})).sort((a,b)=>b.jsBytes-a.jsBytes);
  report.budget={maxJsBytes:maxJs===undefined?null:maxJs*1000,exceeded:report.routes.filter(route=>maxJs!==undefined&&route.jsBytes>maxJs*1000).map(route=>route.route)};
  return report;
}
export function printAnalysis(report){
  const kb=n=>(n/1000).toFixed(1)+' kB';
  console.log(`PRNext bundle analysis (${report.buildId})\nInitial browser JavaScript per route; shared files counted once per route. Dynamic imports are excluded.`);
  for(const route of report.routes)console.log(`${route.route}: ${kb(route.jsBytes)} JS / ${kb(route.gzipBytes)} gzip / ${kb(route.brotliBytes)} br${route.deltaBytes===null?'':` (${route.deltaBytes>=0?'+':''}${kb(route.deltaBytes)} vs previous build)`}`);
  console.log('\nLargest browser modules (per output chunk):');
  for(const item of report.files.flatMap(chunk=>chunk.modules.map(module=>({...module,chunk:chunk.file}))).sort((a,b)=>b.bytes-a.bytes).slice(0,10))console.log(`  ${kb(item.bytes)} ${item.file} [${item.chunk}]`);
  if(report.budget.exceeded.length)console.error(`JavaScript budget exceeded: ${report.budget.exceeded.join(', ')}`);
}
