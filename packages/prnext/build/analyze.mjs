import {readFile,writeFile,stat,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzip,brotliCompress,constants} from 'node:zlib';
import {promisify} from 'node:util';
import {mapConcurrent} from './concurrent.mjs';
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
const gzipAsync=promisify(gzip),brotliAsync=promisify(brotliCompress);
export async function writeBuildAnalysis({root,stage,destination,manifest,records,routeInputs,precompressed=false}){
  const files=new Map(records||[]);
  await mapConcurrent(files.values(),async info=>{
    const file=path.join(stage,'assets',info.file),data=await readFile(file);
    info.bytes=data.length;
    // Sidecars in this unpublished stage have just passed decode/hash validation.
    // Never trust arbitrary sidecars when analysis is called independently.
    const size=async(extension,compress)=>{
      if(precompressed)try{return(await stat(file+extension)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
      return(await compress()).length;
    };
    info.gzipBytes=await size('.gz',()=>gzipAsync(data));
    info.brotliBytes=await size('.br',()=>brotliAsync(data,{params:{[constants.BROTLI_PARAM_QUALITY]:5}}));
  });
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
  try{const previous=await readReport(path.join(destination,'build-analysis.json'));report.previous={buildId:previous.buildId,totalJsBytes:previous.totalJsBytes,routes:previous.routes.map(({route,jsBytes,gzipBytes,brotliBytes})=>({route,jsBytes,gzipBytes,brotliBytes}))};}catch(error){if(error.code!=='ENOENT')console.warn('Previous bundle analysis could not be read; comparison unavailable.');}
  await writeFile(path.join(stage,'build-analysis.json'),JSON.stringify(report));
  return report;
}
const metrics={raw:'jsBytes',gzip:'gzipBytes',brotli:'brotliBytes'};
const size=value=>Number.isSafeInteger(value)&&value>=0;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\0\r\n]/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function boundedJson(file,label){
  const handle=await open(file,'r'),limit=16*1024*1024;
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>limit)throw new Error(`${label} must be a regular JSON file of at most 16 MiB.`);
    // Fixed allocation also bounds reads when a concurrent writer grows it.
    const data=Buffer.alloc(limit+1);let length=0;
    while(length<data.length){const {bytesRead}=await handle.read(data,length,data.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>limit)throw new Error(`${label} exceeds 16 MiB.`);
    try{return JSON.parse(data.subarray(0,length).toString('utf8'));}catch{throw new Error(`${label} contains invalid JSON.`);}
  }finally{await handle.close();}
}
function validateRoutes(routes,{complete=true}={}){
  if(!Array.isArray(routes)||routes.length>10000)throw new Error('Invalid analysis routes (maximum 10,000).');
  const seen=new Set();
  for(const route of routes){
    if(!object(route)||!text(route.route)||!route.route.startsWith('/')||seen.has(route.route)||!size(route.jsBytes))throw new Error('Invalid or duplicate route in bundle analysis.');
    seen.add(route.route);
    for(const key of ['gzipBytes','brotliBytes'])if((complete||route[key]!==undefined)&&!size(route[key]))throw new Error(`Invalid ${key} in bundle analysis.`);
  }
}
async function readReport(file){
  const value=await boundedJson(file,'Bundle analysis');
  if(!object(value)||value.version!==1||!text(value.buildId)||!size(value.totalJsBytes)||!Array.isArray(value.files)||value.files.length>100000)throw new Error('Invalid bundle analysis; rebuild with this PRNext version.');
  validateRoutes(value.routes);
  for(const route of value.routes)if(!Array.isArray(route.files)||route.files.length>100000||route.files.some(file=>!text(file)))throw new Error('Invalid route asset list in bundle analysis.');
  for(const file of value.files){
    if(!object(file)||!text(file.file)||!size(file.bytes)||!size(file.gzipBytes)||!size(file.brotliBytes)||!Array.isArray(file.modules)||file.modules.length>100||file.modules.some(module=>!object(module)||!text(module.file)||!size(module.bytes))||!Array.isArray(file.imports)||file.imports.length>100000||file.imports.some(item=>!object(item)||!text(item.file)||!text(item.kind)))throw new Error('Invalid file, module or import in bundle analysis.');
  }
  if(value.previous!==undefined){
    if(!object(value.previous)||!text(value.previous.buildId)||value.previous.totalJsBytes!==undefined&&!size(value.previous.totalJsBytes))throw new Error('Invalid previous bundle analysis.');
    validateRoutes(value.previous.routes,{complete:false});
  }
  // Retain only the versioned schema, rather than echoing arbitrary nested
  // properties from a supplied baseline into a machine-readable report.
  const cleanRoute=({route,files,jsBytes,gzipBytes,brotliBytes})=>({route,files,jsBytes,gzipBytes,brotliBytes});
  return {version:1,buildId:value.buildId,totalJsBytes:value.totalJsBytes,routes:value.routes.map(cleanRoute),
    files:value.files.map(({file,bytes,gzipBytes,brotliBytes,imports,modules})=>({file,bytes,gzipBytes,brotliBytes,imports:imports.map(({file,kind})=>({file,kind})),modules:modules.map(({file,bytes})=>({file,bytes}))})),
    ...(value.previous?{previous:{buildId:value.previous.buildId,totalJsBytes:value.previous.totalJsBytes,routes:value.previous.routes.map(({route,jsBytes,gzipBytes,brotliBytes})=>({route,jsBytes,gzipBytes,brotliBytes}))}}:{})};
}
function nonnegative(value,name,{integer=false}={}){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER||(integer&&!Number.isSafeInteger(value)))throw new Error(`${name} requires a finite nonnegative ${integer?'integer':'number'}.`);
  return value;
}
export function parseAnalysisArgs(args){
  const options={};
  const numeric={'--max-js':'maxJs','--max-increase-bytes':'maxIncreaseBytes','--max-increase-percent':'maxIncreasePercent'};
  const values={'--baseline':'baseline','--metric':'metric','--budgets':'budgets'};
  for(let index=0;index<args.length;index++){
    const flag=args[index],key=Object.hasOwn(numeric,flag)?numeric[flag]:Object.hasOwn(values,flag)?values[flag]:undefined;
    if(flag==='--json'&&!options.json){options.json=true;continue;}
    if(!key||options[key]!==undefined)throw new Error(`Unknown or duplicate analyze option: ${flag}`);
    const value=args[++index];if(!value||value.startsWith('--'))throw new Error(`${flag} requires a value.`);
    if(Object.hasOwn(numeric,flag)){
      if(!/^\d+(?:\.\d+)?$/.test(value))throw new Error(`${flag} requires a nonnegative number.`);
      options[key]=nonnegative(Number(value),flag,{integer:key==='maxIncreaseBytes'});
    }else options[key]=value;
  }
  if(options.metric!==undefined&&!Object.hasOwn(metrics,options.metric))throw new Error('--metric must be raw, gzip or brotli.');
  return options;
}
async function routeBudgets(filename){
  if(!filename)return {};
  const value=await boundedJson(filename,'Route budgets');
  if(!object(value)||Object.keys(value).length>10000)throw new Error('Route budgets must be an object with at most 10,000 route keys.');
  for(const [route,budget]of Object.entries(value)){
    if(!text(route)||!route.startsWith('/')||!object(budget)||!Object.keys(budget).length)throw new Error('Each route budget must be a nonempty object keyed by an exact route pattern.');
    for(const [key,limit]of Object.entries(budget)){
      if(!['maxJs','maxIncreaseBytes','maxIncreasePercent'].includes(key))throw new Error(`Unknown route budget field: ${key}`);
      nonnegative(limit,`Budget ${route}.${key}`,{integer:key==='maxIncreaseBytes'});
    }
  }
  return value;
}
export async function analyzeBuild(root,{maxJs,baseline,metric='raw',maxIncreaseBytes,maxIncreasePercent,budgets}={}){
  if(!Object.hasOwn(metrics,metric))throw new Error('Analysis metric must be raw, gzip or brotli.');
  for(const [key,value]of Object.entries({maxJs,maxIncreaseBytes,maxIncreasePercent}))if(value!==undefined)nonnegative(value,key,{integer:key==='maxIncreaseBytes'});
  const report=await readReport(path.join(root,await readBuildDirectory(root),'build-analysis.json'));
  const limits=await routeBudgets(budgets?path.resolve(root,budgets):null);
  const routeNames=new Set(report.routes.map(route=>route.route));
  for(const route of Object.keys(limits))if(!routeNames.has(route))throw new Error(`Route budget does not match a current route: ${route}`);
  const reference=baseline?await readReport(path.resolve(root,baseline)):report.previous;
  const needsBaseline=maxIncreaseBytes!==undefined||maxIncreasePercent!==undefined||Object.values(limits).some(value=>value.maxIncreaseBytes!==undefined||value.maxIncreasePercent!==undefined);
  if(needsBaseline&&!reference)throw new Error('Regression budgets require --baseline or a previous build analysis.');
  const field=metrics[metric],previous=new Map((reference?.routes||[]).map(route=>[route.route,route[field]]));
  report.metric=metric;
  report.baseline=reference?{buildId:reference.buildId,source:baseline?'file':'previous-build'}:null;
  report.routes=report.routes.map(route=>{
    const budget={maxJs,maxIncreaseBytes,maxIncreasePercent,...(limits[route.route]||{})};
    const before=previous.get(route.route),current=route[field],hasBaseline=size(before),delta=hasBaseline?current-before:null;
    const regressionBudget=budget.maxIncreaseBytes!==undefined||budget.maxIncreasePercent!==undefined;
    const exceeded=[];
    if(budget.maxJs!==undefined&&current>budget.maxJs*1000)exceeded.push('maxJs');
    if(regressionBudget&&!hasBaseline)exceeded.push('baseline-missing');
    if(hasBaseline&&budget.maxIncreaseBytes!==undefined&&delta>budget.maxIncreaseBytes)exceeded.push('maxIncreaseBytes');
    if(hasBaseline&&budget.maxIncreasePercent!==undefined&&(before===0?delta>0:delta/before*100>budget.maxIncreasePercent))exceeded.push('maxIncreasePercent');
    return {...route,selectedBytes:current,baselineBytes:hasBaseline?before:null,deltaBytes:delta,deltaPercent:hasBaseline&&before>0?delta/before*100:hasBaseline&&current===0?0:null,
      comparison:hasBaseline?'compared':reference?'new-or-unavailable':'no-baseline',budget:{...budget,exceeded}};
  }).sort((a,b)=>b.selectedBytes-a.selectedBytes||a.route.localeCompare(b.route));
  report.budget={metric,maxJsBytes:maxJs===undefined?null:maxJs*1000,maxIncreaseBytes:maxIncreaseBytes??null,maxIncreasePercent:maxIncreasePercent??null,exceeded:report.routes.filter(route=>route.budget.exceeded.length).map(route=>route.route)};
  report.ok=report.budget.exceeded.length===0;
  return report;
}
export function printAnalysis(report){
  const kb=n=>(n/1000).toFixed(1)+' kB';
  console.log(`PRNext bundle analysis (${report.buildId})\nInitial browser JavaScript per route; shared files counted once per route. Dynamic imports are excluded. Budget metric: ${report.metric||'raw'}.`);
  for(const route of report.routes)console.log(`${route.route}: ${kb(route.jsBytes)} JS / ${kb(route.gzipBytes)} gzip / ${kb(route.brotliBytes)} br${route.deltaBytes===null?'':` (${route.deltaBytes>=0?'+':''}${kb(route.deltaBytes)} ${report.metric||'raw'} vs baseline${route.deltaPercent===null?'':`, ${route.deltaPercent.toFixed(1)}%`})`}${route.budget?.exceeded.length?` [${route.budget.exceeded.join(', ')}]`:''}`);
  console.log('\nLargest browser modules (per output chunk):');
  for(const item of report.files.flatMap(chunk=>chunk.modules.map(module=>({...module,chunk:chunk.file}))).sort((a,b)=>b.bytes-a.bytes).slice(0,10))console.log(`  ${kb(item.bytes)} ${item.file} [${item.chunk}]`);
  if(report.budget.exceeded.length)console.error(`JavaScript budget exceeded: ${report.budget.exceeded.join(', ')}`);
}
