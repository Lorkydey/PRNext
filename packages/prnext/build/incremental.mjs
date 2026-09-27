import { context } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {clearDirectoryCache} from './directory-cache.mjs';
const contexts = new Map();
const LIMIT = 8;
let created = 0, reused = 0;
export const incrementalCompilerStats = () => ({contexts:contexts.size, created, reused});
export async function closeIncrementalCompiler() {
  clearDirectoryCache();
  const active=[...contexts.values()];contexts.clear();await Promise.all(active.map(slot=>slot.context.dispose()));
}
/** Retain esbuild's parsed module graphs while rebinding per-build framework plugins. */
export async function incrementalBuild(options, {root,stage,group='project',run=callback=>callback()}) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    const canonical = value => typeof value === 'string' ? value.replaceAll(root, canonicalRoot) : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof RegExp) && !ArrayBuffer.isView(value) ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,canonical(item)])) : value;
    return incrementalBuild(canonical(options),{root:canonicalRoot,stage:stage.replace(root,canonicalRoot),group,run});
  }
  const virtual=path.join(root,'.prnext-incremental-stage');
  const toVirtual=value=>typeof value==='string'?value.replaceAll(stage,virtual):value;
  const fromVirtual=value=>typeof value==='string'?value.replaceAll(virtual,stage):value;
  const deep=(value,map)=>typeof value==='string'?map(value):Array.isArray(value)?value.map(item=>deep(item,map)):value&&typeof value==='object'&&!(value instanceof RegExp)&&!ArrayBuffer.isView(value)?Object.fromEntries(Object.entries(value).map(([key,item])=>[map(key),deep(item,map)])):value;
  const realResult=result=>result && {...result,...(result.path?{path:fromVirtual(result.path)}:{}),...(result.resolveDir?{resolveDir:fromVirtual(result.resolveDir)}:{})};
  const virtualResult=result=>result && {...result,...(result.path?{path:toVirtual(result.path)}:{}),...(result.resolveDir?{resolveDir:toVirtual(result.resolveDir)}:{}),...(result.watchFiles?{watchFiles:result.watchFiles.map(toVirtual)}:{}),...(result.watchDirs?{watchDirs:result.watchDirs.map(toVirtual)}:{})};
  const hooks=[];
  const initialOptions={...options,plugins:undefined,write:false};
  let slot;
  const resolve=async(specifier,settings)=>realResult(await slot.builder.resolve(specifier,settings));
  for(const plugin of options.plugins || []) await plugin.setup({initialOptions,resolve,
    onResolve(settings,callback){hooks.push({kind:'onResolve',settings,callback});},onLoad(settings,callback){hooks.push({kind:'onLoad',settings,callback});},
    onStart(callback){hooks.push({kind:'onStart',callback});},onEnd(callback){hooks.push({kind:'onEnd',callback});},onDispose(callback){hooks.push({kind:'onDispose',callback});},
    esbuild:await import('esbuild'),
  });
  const normalized=deep(initialOptions,toVirtual);
  const signature=JSON.stringify([normalized,hooks.map(({kind,settings})=>[kind,settings?.namespace,settings?.filter?.source,settings?.filter?.flags]),(options.plugins||[]).map(plugin=>plugin.name)]);
  const key=group+':'+createHash('sha256').update(signature).digest('hex');
  slot=contexts.get(key);
  if(slot){contexts.delete(key);reused++;}
  else {
    while([...contexts.values()].filter(slot=>slot.group===group).length>=(group==='auxiliary'?2:LIMIT)){const [oldest,previous]=[...contexts].find(([,slot])=>slot.group===group);contexts.delete(oldest);await previous.context.dispose();}
    created++;slot={group};
    slot.current={hooks,run,toVirtual,fromVirtual,virtualResult,stage};
    slot.context=await context({...normalized,plugins:[{name:'prnext-incremental-delegates',setup(builder){
      slot.builder=builder;
      builder.onResolve({filter:/.*/},async args=>{
        const active=slot.current;
        if(args.pluginData?.prnextVirtualResolution || !(args.path.startsWith(virtual+path.sep)||args.path.startsWith(active.stage+path.sep)||(args.resolveDir===virtual || args.resolveDir.startsWith(virtual+path.sep))))return;
        const result=await builder.resolve(active.fromVirtual(args.path),{resolveDir:active.fromVirtual(args.resolveDir),importer:active.fromVirtual(args.importer),kind:args.kind,with:args.with,pluginData:{...args.pluginData,prnextVirtualResolution:true}});
        const pluginData={...(result.pluginData || args.pluginData)}; delete pluginData.prnextVirtualResolution;
        return {...active.virtualResult(result),pluginData};
      });
      hooks.forEach(({kind,settings},index)=>{
        const callback=args=>{
          const active=slot.current;
          return active.run(async()=>active.virtualResult(await active.hooks[index].callback(args&&{...args,path:active.fromVirtual(args.path),importer:active.fromVirtual(args.importer),resolveDir:active.fromVirtual(args.resolveDir)})));
        };
        if(settings)builder[kind](settings,callback);else builder[kind](callback);
      });
      builder.onLoad({filter:/.*/,namespace:'file'},async args=>{
        if(!args.path.startsWith(virtual+path.sep))return;
        const actual=slot.current.fromVirtual(args.path),extension=path.extname(actual);
        return {contents:await readFile(actual),loader:options.loader?.[extension] || ({'.json':'json','.ts':'ts','.tsx':'tsx','.jsx':'jsx','.css':'css'}[extension] || 'js'),resolveDir:path.dirname(args.path)};
      });
    }}]});
  }
  slot.current={hooks,run,toVirtual,fromVirtual,virtualResult,stage};
  contexts.set(key,slot);
  const result=await slot.context.rebuild();
  const relativeVirtual=path.basename(virtual),relativeStage=path.basename(stage);
  const metadata=value=>fromVirtual(value).replaceAll(relativeVirtual,relativeStage);
  const files=result.outputFiles.map(file=>({path:fromVirtual(file.path),contents:file.contents,get text(){return Buffer.from(this.contents).toString();},hash:file.hash}));
  if(options.write!==false)for(const file of files){await mkdir(path.dirname(file.path),{recursive:true});await writeFile(file.path,file.contents);}
  return {...result,...(result.metafile?{metafile:deep(result.metafile,metadata)}:{}),...(options.write===false?{outputFiles:files}:{outputFiles:undefined})};
}
