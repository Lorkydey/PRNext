import { context } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {clearDirectoryCache} from './directory-cache.mjs';
import {closeWebpackCompiler,webpackCompilerStats} from './webpack-graph.mjs';
const contexts = new Map();
const LIMIT = 8;
const AUXILIARY_LIMIT = 2;
const RESERVES = Object.freeze({ main: 6, styles: 2 });
const counters = () => ({ created: 0, reused: 0, evicted: 0 });
const roles = () => ({ main: counters(), styles: counters(), auxiliary: counters() });
const totals = counters(), roleTotals = roles();

function record(metrics, role, event) {
  totals[event]++;
  roleTotals[role][event]++;
  metrics[event]++;
  metrics.roles[role][event]++;
}

function roleStats(metrics, active) {
  return Object.fromEntries(Object.entries(metrics).map(([role, values]) => [role, {
    ...values,
    contexts: active.filter(slot => slot.role === role).length,
  }]));
}

export function incrementalCompilerStats() {
  const active = [...contexts.values()];
  // Counters belong to retained projects, rather than an unbounded registry of
  // every project ever compiled by this process. Global role totals persist.
  const projects = [...new Set(active.map(slot => slot.metrics))].map(metrics => {
    const retained = active.filter(slot => slot.metrics === metrics);
    return {
      root: metrics.root,
      created: metrics.created,
      reused: metrics.reused,
      evicted: metrics.evicted,
      contexts: retained.length,
      roles: roleStats(metrics.roles, retained),
    };
  });
  return {
    contexts: contexts.size,
    ...totals,
    roles: roleStats(roleTotals, active),
    projects,
    limits: { project: LIMIT, auxiliary: AUXILIARY_LIMIT, reserves: { ...RESERVES } },
    webpack: webpackCompilerStats(),
  };
}

function evictionCandidate(group, role) {
  const candidates = [...contexts].filter(([, slot]) => slot.group === group);
  if (group === 'auxiliary') return candidates[0];
  const count = candidateRole => candidates.filter(([, slot]) => slot.role === candidateRole).length;
  // Both roles can borrow unused capacity. Once full, a role at its reserve
  // replaces its own oldest graph; a role below its reserve reclaims a loan.
  if (count(role) >= RESERVES[role]) return candidates.find(([, slot]) => slot.role === role);
  return candidates.find(([, slot]) => count(slot.role) > RESERVES[slot.role]);
}
export async function closeIncrementalCompiler(root) {
  clearDirectoryCache();
  const active=[];for(const [key,slot] of contexts)if(root===undefined||slot.root===root){contexts.delete(key);active.push(slot);}
  const results=await Promise.allSettled([...active.map(slot=>slot.context.dispose()),closeWebpackCompiler(root)]);
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'Unable to dispose incremental compiler sessions');
}
/** Retain esbuild's parsed module graphs while rebinding per-build framework plugins. */
export async function incrementalBuild(options, {root,stage,group='project',role=group==='auxiliary'?'auxiliary':'main',run=callback=>callback()}) {
  if (!['project', 'auxiliary'].includes(group) || (group === 'project' ? !Object.hasOwn(RESERVES, role) : role !== 'auxiliary')) {
    throw new TypeError('Invalid incremental compiler group or role');
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    const canonical = value => typeof value === 'string' ? value.replaceAll(root, canonicalRoot) : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof RegExp) && !ArrayBuffer.isView(value) ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,canonical(item)])) : value;
    return incrementalBuild(canonical(options),{root:canonicalRoot,stage:stage.replace(root,canonicalRoot),group,role,run});
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
  const key=JSON.stringify([root,group,role,createHash('sha256').update(signature).digest('hex')]);
  slot=contexts.get(key);
  if(slot){contexts.delete(key);record(slot.metrics,role,'reused');}
  else {
    const metrics = [...contexts.values()].find(slot => slot.root === root)?.metrics || { root, ...counters(), roles: roles() };
    while ([...contexts.values()].filter(slot => slot.group === group).length >= (group === 'auxiliary' ? AUXILIARY_LIMIT : LIMIT)) {
      const [oldest, previous] = evictionCandidate(group, role);
      contexts.delete(oldest);
      record(previous.metrics, previous.role, 'evicted');
      await previous.context.dispose();
    }
    slot={group,role,root,metrics};
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
    record(metrics,role,'created');
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
