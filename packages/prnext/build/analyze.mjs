import {readFile,writeFile,stat,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzip,brotliCompress,constants} from 'node:zlib';
import {promisify} from 'node:util';
import {mapConcurrent} from './concurrent.mjs';
import {readBuildDirectory} from '../runtime/build-directory.mjs';
import {fileURLToPath} from 'node:url';

// These imports are awaited before App hydration. esbuild correctly describes
// them as dynamic imports, but they are not deferred by user interaction.
const appClient=fileURLToPath(new URL('../runtime/app-client.mjs',import.meta.url));
const hydrationImports=new Map([
  ['react-server-dom-webpack/client.browser','always'],
  ['./app-partial-client.mjs','cache-components'],
]);

export function recordBuildAnalysis(state,options,result){
  if(!state?.stage||!result.metafile)return;
  state.analysis ||= new Map();
  state.analysisRoutes ||= new Map();
  const outputs=new Map(Object.entries(result.metafile.outputs).map(([file,info])=>[path.resolve(options.absWorkingDir||state.root,file),info]));
  const working=options.absWorkingDir||state.root;
  const entries=new Map([...outputs].filter(([,info])=>info.entryPoint).map(([file,info])=>[path.resolve(working,info.entryPoint),file]));
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
    const imports=(info.imports||[]).filter(item=>!item.external).map(item=>({file:path.relative(path.join(state.stage,'assets'),path.resolve(working,item.path)).replaceAll(path.sep,'/'),kind:item.kind}));
    for(const name of Object.keys(info.inputs||{})){
      const source=path.resolve(working,name);
      for(const input of result.metafile.inputs[name]?.imports||[]){
        if(input.kind!=='dynamic-import'||input.external)continue;
        const target=entries.get(path.resolve(working,input.path));if(!target)continue;
        const asset=relativeAsset(state.stage,target);
        const edge=imports.find(item=>item.file===asset&&item.kind==='dynamic-import');
        if(!edge)continue;
        const id='dynamic-'+createHash('sha256').update(relativePath(state.root,source)+'\0'+input.original).digest('hex').slice(0,20);
        (edge.dynamicIds||=[]).push(id);
        if(source===appClient&&hydrationImports.has(input.original))edge.initial=hydrationImports.get(input.original);
        else if(source===path.join(state.stage,'.entries','app-runtime.mjs'))edge.initial='flight-reference';
      }
    }
    for(const edge of imports)if(edge.dynamicIds)edge.dynamicIds=[...new Set(edge.dynamicIds)].sort();
    state.analysis.set(relative,{file:relative,bytes:info.bytes,imports,...(result.metafile.initialGraphComplete===false?{initialIncomplete:true}:{}),
      modules:Object.entries(info.inputs||{}).map(([name,record])=>({file:path.relative(state.root,path.resolve(options.absWorkingDir||state.root,name)).replaceAll(path.sep,'/').replace(/\.prnext-build-[^/]+\//g,'<generated>/'),bytes:record.bytesInOutput})).sort((a,b)=>b.bytes-a.bytes).slice(0,100)});
  }
}
function relativePath(root,file){return path.relative(root,file).replaceAll(path.sep,'/');}
function relativeAsset(stage,file){return relativePath(path.join(stage,'assets'),file);}
function initialFiles(entry,files,cacheComponents=false){
  const seen=new Set(),pending=[entry];
  while(pending.length){const name=pending.pop();if(seen.has(name)||!files.has(name))continue;seen.add(name);for(const item of files.get(name).imports)if(item.kind!=='dynamic-import'||item.initial==='always'||item.initial==='cache-components'&&cacheComponents)pending.push(item.file);}
  return [...seen].sort();
}

async function initialSample(stage,seed,route,manifest){
  // These documents were validated before publication and intentionally have
  // no Flight sidecar. Its absence is exact zero JS, not missing coverage.
  if(route.htmlOnly)return {entries:[],ids:[]};
  if(route.router==='app'){
    if(!seed.dataFile)return null;
    const data=await readBoundedText(path.join(stage,seed.dataFile));
    if(data===null)return null;
    const entries=[],rows=new Map(),imports=[];
    // Read only official import rows; do not execute, decode or rewrite Flight.
    for(const line of data.split('\n')){
      // Flight also carries length-framed raw/binary rows. Their bytes may
      // contain newlines that resemble import rows; do not parse such a stream
      // as newline-delimited JSON or claim complete hydration coverage for it.
      if(/^[\da-f]+:[TAOobUSsLlGgMmV]/.test(line))return null;
      const row=/^([\da-f]+):(I?)(.*)$/.exec(line);if(!row)continue;
      let value;try{value=JSON.parse(row[3]);}catch{if(row[2])return null;continue;}
      if(row[2])imports.push(value);else if(typeof value==='string')rows.set(row[1],value);
    }
    for(const value of imports){
      const reference=value?.[0];
      const id=typeof reference==='string'&&/^\$[\da-f]+$/.test(reference)?rows.get(reference.slice(1)):reference;
      const module=manifest.app?.clientModules?.[id]?.browserModule;
      if(!module)return null;
      entries.push(assetName(module));
    }
    return {entries,ids:[]};
  }
  const html=await readBoundedText(path.join(stage,seed.file));
  if(html===null)return null;
  const match=/window\.__PRNEXT_DATA__=JSON\.parse\(("(?:\\.|[^"\\])*")\);/.exec(html);
  if(!match)return null;
  try{const value=JSON.parse(JSON.parse(match[1]));return Array.isArray(value.dynamicIds)?{entries:[],ids:value.dynamicIds}:null;}catch{return null;}
}
async function readBoundedText(file){
  const handle=await open(file,'r');try{
    const info=await handle.stat(),size=info.size;if(!info.isFile()||size>16*1024*1024)return null;
    const data=Buffer.alloc(size+1);let length=0;
    while(length<data.length){const result=await handle.read(data,length,data.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
    if(length>size)return null;
    return data.subarray(0,length).toString('utf8');
  }finally{await handle.close();}
}
function assetName(url){return decodeURIComponent(new URL(url,'http://local').pathname).split('/').pop();}
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
  const dynamicEntries=new Map();
  for(const info of files.values())for(const edge of info.imports)for(const id of edge.dynamicIds||[]){
    if(!dynamicEntries.has(id))dynamicEntries.set(id,new Set());dynamicEntries.get(id).add(edge.file);
  }
  const seedsByRoute=new Map();
  for(const seed of manifest.prerendered||[])if(!seed.status||seed.status<300){
    if(!seedsByRoute.has(seed.routeId))seedsByRoute.set(seed.routeId,[]);seedsByRoute.get(seed.routeId).push(seed);
  }
  const routes=await mapConcurrent(manifest.routes.filter(route=>!route.internal&&route.kind==='page'),async route=>{
    const client=route.client?assetName(route.client):null;
    const baseEntries=client?[client]:[];
    const initialAssets=entries=>[...new Set(entries.flatMap(entry=>initialFiles(entry,files,manifest.config?.cacheComponents)))].sort();
    const costs=assets=>({jsBytes:assets.reduce((total,file)=>total+files.get(file).bytes,0),gzipBytes:assets.reduce((total,file)=>total+files.get(file).gzipBytes,0),brotliBytes:assets.reduce((total,file)=>total+files.get(file).brotliBytes,0)});
    const potential=[];
    if(route.router==='app')for(const file of routeInputs?.get(route.module)||[]){
      const id='client-'+createHash('sha256').update(file).digest('hex').slice(0,16);
      const entry=manifest.app?.clientModules?.[id]?.browserModule;
      if(entry)potential.push(assetName(entry));
    }
    const seeds=seedsByRoute.get(route.id)||[];
    const samples=[];let failedSample=false;
    for(const seed of seeds){
      const sample=await initialSample(stage,seed,route,manifest);
      if(!sample){failedSample=true;continue;}
      const entries=[...baseEntries,...sample.entries];
      for(const id of sample.ids)entries.push(...dynamicEntries.get(id)||[]);
      const assets=initialAssets(entries);
      samples.push({path:seed.path,files:assets,...costs(assets)});
    }
    // A route graph cannot reveal which conditional components request data
    // selects. Never turn its lower bound into a successful initial-JS budget.
    const runtime=route.ssp||route.gip||route.appGip||route.ppr||route.pprGeneric||
      route.pattern.includes('[')&&route.fallback!==false||seeds.some(seed=>typeof seed.revalidate==='number');
    const baseFiles=[...new Set([...initialAssets(baseEntries),...samples.flatMap(sample=>sample.files)])].sort();
    const hasDynamic=(samples.length?samples:[{files:baseFiles}]).some(sample=>{
      const known=new Set(sample.files);
      return sample.files.some(file=>files.get(file).imports.some(edge=>edge.kind==='dynamic-import'&&!edge.initial&&!known.has(edge.file)));
    });
    const unknown=!!runtime||failedSample||(!samples.length&&potential.length>0)||hasDynamic||baseFiles.some(file=>files.get(file).initialIncomplete);
    const values=samples.length?samples:[costs(baseFiles)];
    // Route files are a union for inspection. Each budget metric is the actual
    // largest sampled path, never the sum of mutually exclusive path chunks.
    return {route:route.pattern,files:baseFiles,initial:{status:unknown?'request-dependent':samples.length?'prerendered':'static-graph',samplePaths:samples.map(sample=>sample.path),samples},
      ...Object.fromEntries(['jsBytes','gzipBytes','brotliBytes'].map(key=>[key,Math.max(...values.map(value=>value[key]))]))};
  });
  const report={version:2,buildId:manifest.buildId,routes,files:[...files.values()],totalJsBytes:[...files.values()].reduce((n,item)=>n+item.bytes,0)};
  try{const previous=await readReport(path.join(destination,'build-analysis.json'));if(previous.version===2)report.previous={version:2,buildId:previous.buildId,totalJsBytes:previous.totalJsBytes,routes:previous.routes.map(({route,initial,jsBytes,gzipBytes,brotliBytes})=>({route,initial,jsBytes,gzipBytes,brotliBytes}))};else report.comparisonUnavailable='Initial asset accounting changed; rebuild the baseline with this PRNext version.';}catch(error){if(error.code!=='ENOENT')console.warn('Previous bundle analysis could not be read; comparison unavailable.');}
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
    if(route.initial!==undefined){
      const initial=route.initial;
      if(!object(initial)||!['prerendered','static-graph','request-dependent'].includes(initial.status)||!Array.isArray(initial.samplePaths)||initial.samplePaths.length>10000||initial.samplePaths.some(value=>!text(value))||!Array.isArray(initial.samples)||initial.samples.length>10000)throw new Error('Invalid initial asset coverage in bundle analysis.');
      for(const sample of initial.samples)if(!object(sample)||!text(sample.path)||!Array.isArray(sample.files)||sample.files.length>100000||sample.files.some(file=>!text(file))||['jsBytes','gzipBytes','brotliBytes'].some(key=>!size(sample[key])))throw new Error('Invalid initial asset sample in bundle analysis.');
    }
  }
}
function validateInitialTotals(value){
  const files=new Map();
  for(const file of value.files){if(files.has(file.file))throw new Error('Duplicate asset in bundle analysis.');files.set(file.file,file);}
  const fields={jsBytes:'bytes',gzipBytes:'gzipBytes',brotliBytes:'brotliBytes'};
  const sum=(names,key)=>names.reduce((total,name)=>{
    const file=files.get(name);if(!file)throw new Error('Unknown asset in initial bundle analysis.');
    const result=total+file[fields[key]];if(!size(result))throw new Error('Initial asset totals exceed the supported range.');return result;
  },0);
  const unique=names=>new Set(names).size===names.length;
  for(const route of value.routes){
    if(!unique(route.files))throw new Error('Duplicate route asset in bundle analysis.');
    const routeFiles=new Set(route.files);
    const {initial}=route,samples=initial.samples;
    if(!unique(initial.samplePaths)||initial.samplePaths.length!==samples.length||samples.some((sample,index)=>sample.path!==initial.samplePaths[index]))throw new Error('Initial sample paths do not match their measurements.');
    if(initial.status==='prerendered'&&!samples.length||initial.status==='static-graph'&&samples.length)throw new Error('Invalid initial sample coverage status.');
    for(const name of route.files)if(!files.has(name))throw new Error('Unknown route asset in bundle analysis.');
    for(const sample of samples){
      if(!unique(sample.files)||sample.files.some(file=>!routeFiles.has(file)))throw new Error('Invalid or duplicate sampled asset in bundle analysis.');
      for(const key of Object.keys(fields))if(sum(sample.files,key)!==sample[key])throw new Error('Initial sample totals do not match their assets.');
    }
    const union=new Set(samples.flatMap(sample=>sample.files));
    if(samples.length&&(union.size!==route.files.length||route.files.some(file=>!union.has(file))))throw new Error('Route asset union does not match its initial samples.');
    for(const key of Object.keys(fields)){
      const expected=samples.length?Math.max(...samples.map(sample=>sample[key])):sum(route.files,key);
      if(expected!==route[key])throw new Error('Initial route totals do not match their samples.');
    }
    if(initial.status!=='request-dependent'&&route.files.some(file=>files.get(file).initialIncomplete))throw new Error('Incomplete metadata cannot have exact initial asset coverage.');
  }
}
async function readReport(file){
  const value=await boundedJson(file,'Bundle analysis');
  if(!object(value)||![1,2].includes(value.version)||!text(value.buildId)||!size(value.totalJsBytes)||!Array.isArray(value.files)||value.files.length>100000)throw new Error('Invalid bundle analysis; rebuild with this PRNext version.');
  validateRoutes(value.routes);
  for(const route of value.routes)if(!Array.isArray(route.files)||route.files.length>100000||route.files.some(file=>!text(file)))throw new Error('Invalid route asset list in bundle analysis.');
  for(const file of value.files){
    if(!object(file)||!text(file.file)||!size(file.bytes)||!size(file.gzipBytes)||!size(file.brotliBytes)||file.initialIncomplete!==undefined&&typeof file.initialIncomplete!=='boolean'||!Array.isArray(file.modules)||file.modules.length>100||file.modules.some(module=>!object(module)||!text(module.file)||!size(module.bytes))||!Array.isArray(file.imports)||file.imports.length>100000||file.imports.some(item=>!object(item)||!text(item.file)||!text(item.kind)||item.initial!==undefined&&!['always','cache-components','flight-reference'].includes(item.initial)||item.dynamicIds!==undefined&&(!Array.isArray(item.dynamicIds)||item.dynamicIds.length>100000||item.dynamicIds.some(id=>!/^dynamic-[a-f\d]{20}$/.test(id)))))throw new Error('Invalid file, module or import in bundle analysis.');
  }
  if(value.previous!==undefined){
    if(!object(value.previous)||!text(value.previous.buildId)||value.previous.totalJsBytes!==undefined&&!size(value.previous.totalJsBytes)||value.version===2&&value.previous.version!==2)throw new Error('Invalid previous bundle analysis.');
    validateRoutes(value.previous.routes,{complete:false});
  }
  if(value.version===2){
    if(value.routes.some(route=>!route.initial)||value.previous?.routes.some(route=>!route.initial))throw new Error('Missing initial asset coverage in bundle analysis.');
    validateInitialTotals(value);
  }
  // Retain only the versioned schema, rather than echoing arbitrary nested
  // properties from a supplied baseline into a machine-readable report.
  const cleanInitial=initial=>initial?{status:initial.status,samplePaths:[...initial.samplePaths],samples:initial.samples.map(({path,files,jsBytes,gzipBytes,brotliBytes})=>({path,files:[...files],jsBytes,gzipBytes,brotliBytes}))}:undefined;
  const cleanRoute=({route,files,initial,jsBytes,gzipBytes,brotliBytes})=>({route,files,...(initial?{initial:cleanInitial(initial)}:{}),jsBytes,gzipBytes,brotliBytes});
  if(value.version===2&&value.routes.some(route=>!route.initial)||value.previous&&value.version===2&&value.previous.routes.some(route=>!route.initial))throw new Error('Missing initial asset coverage in bundle analysis.');
  return {version:value.version,buildId:value.buildId,totalJsBytes:value.totalJsBytes,routes:value.routes.map(cleanRoute),
    files:value.files.map(({file,bytes,gzipBytes,brotliBytes,imports,modules,initialIncomplete})=>({file,bytes,gzipBytes,brotliBytes,...(initialIncomplete?{initialIncomplete:true}:{}),imports:imports.map(({file,kind,initial,dynamicIds})=>({file,kind,...(initial?{initial}:{}),...(dynamicIds?{dynamicIds:[...dynamicIds]}:{})})),modules:modules.map(({file,bytes})=>({file,bytes}))})),
    ...(text(value.comparisonUnavailable)?{comparisonUnavailable:value.comparisonUnavailable}:{}),
    ...(value.previous?{previous:{version:value.previous.version||1,buildId:value.previous.buildId,totalJsBytes:value.previous.totalJsBytes,routes:value.previous.routes.map(cleanRoute)}}:{})};
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
  if(reference&&report.version!==(reference.version||1))throw new Error('Initial asset accounting changed; rebuild the baseline with this PRNext version before comparing.');
  const needsBaseline=maxIncreaseBytes!==undefined||maxIncreasePercent!==undefined||Object.values(limits).some(value=>value.maxIncreaseBytes!==undefined||value.maxIncreasePercent!==undefined);
  if(needsBaseline&&!reference)throw new Error('Regression budgets require --baseline or a previous build analysis.');
  const field=metrics[metric],previous=new Map((reference?.routes||[]).filter(route=>route.initial?.status!=='request-dependent').map(route=>[route.route,route[field]]));
  report.metric=metric;
  report.baseline=reference?{buildId:reference.buildId,source:baseline?'file':'previous-build'}:null;
  report.routes=report.routes.map(route=>{
    const budget={maxJs,maxIncreaseBytes,maxIncreasePercent,...(limits[route.route]||{})};
    const uncertain=route.initial?.status==='request-dependent';
    const before=previous.get(route.route),current=route[field],hasBaseline=!uncertain&&size(before),delta=hasBaseline?current-before:null;
    const regressionBudget=budget.maxIncreaseBytes!==undefined||budget.maxIncreasePercent!==undefined;
    const exceeded=[];
    if(uncertain&&Object.values(budget).some(value=>value!==undefined))exceeded.push('initial-unknown');
    if(budget.maxJs!==undefined&&current>budget.maxJs*1000)exceeded.push('maxJs');
    if(regressionBudget&&!hasBaseline)exceeded.push('baseline-missing');
    if(hasBaseline&&budget.maxIncreaseBytes!==undefined&&delta>budget.maxIncreaseBytes)exceeded.push('maxIncreaseBytes');
    if(hasBaseline&&budget.maxIncreasePercent!==undefined&&(before===0?delta>0:delta/before*100>budget.maxIncreasePercent))exceeded.push('maxIncreasePercent');
    return {...route,selectedBytes:current,baselineBytes:hasBaseline?before:null,deltaBytes:delta,deltaPercent:hasBaseline&&before>0?delta/before*100:hasBaseline&&current===0?0:null,
      comparison:uncertain?'initial-unknown':hasBaseline?'compared':reference?'new-or-unavailable':'no-baseline',budget:{...budget,exceeded}};
  }).sort((a,b)=>b.selectedBytes-a.selectedBytes||a.route.localeCompare(b.route));
  report.budget={metric,maxJsBytes:maxJs===undefined?null:maxJs*1000,maxIncreaseBytes:maxIncreaseBytes??null,maxIncreasePercent:maxIncreasePercent??null,exceeded:report.routes.filter(route=>route.budget.exceeded.length).map(route=>route.route)};
  report.ok=report.budget.exceeded.length===0;
  return report;
}
export function printAnalysis(report){
  const kb=n=>(n/1000).toFixed(1)+' kB';
  console.log(`PRNext bundle analysis (${report.buildId})\n${report.version===2?'Hydration JavaScript per route, including required runtime imports and prerendered dynamic modules. Each metric is the largest sampled path; route file lists are unions. Shared files counted once; deferred imports excluded. Request-dependent route maxima are lower bounds.':'Legacy static-import-only accounting; rebuild to include hydration dependencies.'} Budget metric: ${report.metric||'raw'}.`);
  for(const route of report.routes)console.log(`${route.route}: ${route.initial?.status==='request-dependent'?'>= ':''}${kb(route.jsBytes)} JS / ${kb(route.gzipBytes)} gzip / ${kb(route.brotliBytes)} br${route.initial?` [${route.initial.status}]`:''}${route.deltaBytes===null?'':` (${route.deltaBytes>=0?'+':''}${kb(route.deltaBytes)} ${report.metric||'raw'} vs baseline${route.deltaPercent===null?'':`, ${route.deltaPercent.toFixed(1)}%`})`}${route.budget?.exceeded.length?` [${route.budget.exceeded.join(', ')}]`:''}`);
  if(report.comparisonUnavailable)console.log(report.comparisonUnavailable);
  console.log('\nLargest browser modules (per output chunk):');
  for(const item of report.files.flatMap(chunk=>chunk.modules.map(module=>({...module,chunk:chunk.file}))).sort((a,b)=>b.bytes-a.bytes).slice(0,10))console.log(`  ${kb(item.bytes)} ${item.file} [${item.chunk}]`);
  const unverified=report.routes.filter(route=>route.budget?.exceeded.some(reason=>reason==='initial-unknown'||reason==='baseline-missing')).map(route=>route.route);
  const exceeded=report.routes.filter(route=>route.budget?.exceeded.some(reason=>!['initial-unknown','baseline-missing'].includes(reason))).map(route=>route.route);
  if(exceeded.length)console.error(`JavaScript budget exceeded: ${exceeded.join(', ')}`);
  if(unverified.length)console.error(`JavaScript budget not verified (initial coverage or baseline unavailable): ${unverified.join(', ')}`);
}
