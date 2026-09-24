import { AsyncLocalStorage } from 'node:async_hooks';
import { build as esbuild } from 'esbuild';
import { runLoaders } from 'loader-runner';
import fs from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { moduleResolutionPlugin, validateWebpackResolution } from './module-resolution.mjs';
import { cachedLoader } from './loader-cache.mjs';
import { incrementalBuild } from './incremental.mjs';
import { webpackGraph } from './webpack-graph.mjs';
import { turbopackRules, sourceReader } from './turbopack-conditions.mjs';
import {withSourceMaps,configureSourceMaps,inlineSourceMap} from './source-maps.mjs';

let validateOptions;
const compilation = new AsyncLocalStorage();
export const withCompilation = callback => withSourceMaps(()=>compilation.run({ targets: new Map(), loaded: new Map() }, callback));
export function configureCompiler(options) { Object.assign(compilation.getStore() || {}, options);configureSourceMaps(options.dev || options.config?.productionBrowserSourceMaps); }
export async function compilerSource(file, fallback) {
  return compilation.getStore()?.loaded.get(file)?.source ?? fallback ?? await readFile(file, 'utf8');
}
const framework = /^(?:rustyx-pages-compatibility|rustyx-app-(?:rsc|ssr|browser)|rustyx-edge-app|rustyx-edge|rustyx-middleware-compatibility)$/;
function condition(value, input) {
  if (value === undefined) return true;
  if (value instanceof RegExp) { value.lastIndex = 0; return value.test(input); }
  if (typeof value === 'string') return input.startsWith(value);
  if (typeof value === 'function') return !!value(input);
  if (Array.isArray(value)) return value.some(item => condition(item, input));
  if (value && typeof value === 'object' && Object.keys(value).some(key=>!['and','or','not'].includes(key))) throw new Error('Unsupported webpack rule condition field');
  if (value && typeof value === 'object') return (!value.and || value.and.every(item => condition(item,input))) && (!value.or || value.or.some(item => condition(item,input))) && (!value.not || !condition(value.not,input));
  throw new Error('Unsupported webpack rule condition');
}
function applies(rule,file,issuer,query) { return condition(rule.test,file) && condition(rule.include,file) && !(rule.exclude && condition(rule.exclude,file)) && condition(rule.issuer,issuer) && condition(rule.resourceQuery,query); }
async function matching(rules, file, issuer = '', query = '', output = [], read = sourceReader(file)) {
  for (const rule of rules) {
    if (!applies(rule,file,issuer,query)) continue;
    if (rule.rustyxCondition && !await rule.rustyxCondition(file,read)) continue;
    if (rule.oneOf) { const selected = rule.oneOf.find(item => applies(item,file,issuer,query)); if (selected) await matching([selected],file,issuer,query,output,read); }
    if (rule.rules) await matching(rule.rules,file,issuer,query,output,read);
    const use = typeof rule.use === 'function' ? rule.use({resource:file,resourceQuery:query,issuer}) : rule.use ?? (rule.loader ? {loader:rule.loader,options:rule.options} : []);
    for (const item of Array.isArray(use) ? use : [use]) output.push({ ...(typeof item === 'string' ? {loader:item} : item), enforce:rule.enforce });
  }
  return output;
}
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 256) throw new Error('webpack.module.rules must contain at most 256 rules');
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') throw new Error('Invalid webpack rule');
    for (const key of Object.keys(rule)) if (!['test','include','exclude','issuer','resourceQuery','use','loader','options','oneOf','rules','enforce','type','resolve'].includes(key)) throw new Error(`webpack rule ${key} is not implemented`);
    // The bridge already parses JavaScript as auto and resolves extensionless
    // ESM requests. Accept the equivalent rule injected by Contentlayer.
    if (rule.type !== undefined && rule.type !== 'javascript/auto') throw new Error(`webpack rule type ${rule.type} is not implemented`);
    if (rule.resolve !== undefined && (!rule.resolve || typeof rule.resolve !== 'object' || Array.isArray(rule.resolve) || Object.keys(rule.resolve).some(key => key !== 'fullySpecified') || rule.resolve.fullySpecified !== false)) throw new Error('webpack rule resolve only supports fullySpecified: false');
    if (rule.enforce && !['pre','post'].includes(rule.enforce)) throw new Error('Invalid webpack rule enforce');
    if (rule.rules) validateRules(rule.rules);
    if (rule.oneOf) validateRules(rule.oneOf);
  }
}
async function targetConfig(state, target) {
  if (!state.targets.has(target)) state.targets.set(target,(async()=>{
    const webpack = state.config.webpack ? (await import('webpack')).default : undefined;
    const base = { mode:state.dev?'development':'production', context:state.root, resolve:{alias:{},extensions:['.tsx','.ts','.jsx','.js','.mjs','.json']},module:{rules:[]},plugins:[] };
    const configured = state.config.webpack ? await state.config.webpack(base,{buildId:state.buildId,dev:state.dev,isServer:target!=='browser',nextRuntime:target==='browser'?undefined:target==='edge'?'edge':'nodejs',webpack,
      defaultLoaders:{babel:{loader:new URL('./passthrough-loader.cjs',import.meta.url).pathname}}}) : base;
    if (!configured || typeof configured !== 'object') throw new Error('webpack hook must return its configuration');
    for (const key of Object.keys(configured)) if (!['mode','context','resolve','module','plugins','watchOptions'].includes(key)) throw new Error(`webpack.${key} cannot be translated to the Rustyx compiler`);
    const watchOptions = configured.watchOptions;
    if (watchOptions !== undefined) {
      if (!watchOptions || typeof watchOptions !== 'object' || Array.isArray(watchOptions) || Object.keys(watchOptions).some(key => key !== 'ignored')) throw new Error('webpack.watchOptions only supports ignored');
      const ignored = watchOptions.ignored;
      if (ignored !== undefined && !(ignored instanceof RegExp) && typeof ignored !== 'string' && !(Array.isArray(ignored) && ignored.every(value => typeof value === 'string'))) throw new Error('webpack.watchOptions.ignored must be a string, RegExp or array of strings');
    }
    if (configured.mode !== base.mode || configured.context !== state.root) throw new Error('webpack mode/context cannot be changed');
    for (const key of Object.keys(configured.resolve || {})) if (!['alias','extensions'].includes(key)) throw new Error(`webpack.resolve.${key} is not implemented`);
    for (const key of Object.keys(configured.module || {})) if (key !== 'rules') throw new Error(`webpack.module.${key} is not implemented`);
    const rules = state.config.webpack ? configured.module?.rules || [] : turbopackRules(state.config.turbopack?.rules,state,target);
    if (state.config.webpack) validateRules(rules);
    const resolution = validateWebpackResolution(configured.resolve);
    const define = {}, graphPlugins = [], banners = [], footers = [];
    for (let plugin of configured.plugins || []) {
      if (plugin instanceof webpack.EnvironmentPlugin) {
        const values = {};
        for (const key of plugin.keys) {
          const value = process.env[key] ?? plugin.defaultValues[key];
          if (value === undefined) throw new Error(`EnvironmentPlugin: ${key} environment variable is undefined`);
          values[`process.env.${key}`] = JSON.stringify(value);
          values[`import.meta.env.${key}`] = JSON.stringify(value);
        }
        plugin = new webpack.DefinePlugin(values);
      }
      if (plugin instanceof webpack.BannerPlugin) {
        if (typeof plugin.options.banner !== 'string' || Object.keys(plugin.options).some(key => !['banner','raw','footer'].includes(key))) {graphPlugins.push(plugin);continue;}
        (plugin.options.footer ? footers : banners).push(plugin.banner({}));
        continue;
      }
      if (!(plugin instanceof webpack.DefinePlugin)) {
        if (!plugin || typeof plugin.apply !== 'function') throw new Error('Webpack plugins must implement apply(compiler)');
        graphPlugins.push(plugin); continue;
      }
      const validateDefinitions = (values,prefix='') => {for(const [name,value] of Object.entries(values)) {
        const key=prefix+name;
        if (/^(?:process\.env\.(?:NODE_ENV|NEXT_RUNTIME|RUSTYX_)|__rustyx)/.test(key.replace(/^typeof /,''))) throw new Error(`DefinePlugin cannot override reserved ${key}`);
        if(value && Object.getPrototypeOf(value)===Object.prototype)validateDefinitions(value,key+'.');
      }};
      validateDefinitions(plugin.definitions);
      if(Object.entries(plugin.definitions).some(([key,value])=>key.startsWith('typeof ') || !['string','number','boolean'].includes(typeof value))) {graphPlugins.push(plugin);continue;}
      for (const [key,value] of Object.entries(plugin.definitions)) {
        define[key] = String(value);
      }
    }
    return {rules,resolution,define,graphPlugins,banners,footers,watchOptions,graph:graphPlugins.length>0 || !!state.config.webpack && rules.length>0};
  })());
  return state.targets.get(target);
}
export async function validateCompilerConfig(config, root, {dev=false,edge=false}={}) {
  if (!config.webpack) return;
  const state={config,root,dev,buildId:'rustyx-check',targets:new Map()};
  for (const target of ['node','browser',...(edge?['edge']:[])]) await targetConfig(state,target);
}
export async function build(options) {
  const state = compilation.getStore();
  // esbuild's shared service dispatches callbacks from its own async context.
  // Re-enter this build so transforms never inherit another project's map mode,
  // action registry or configuration from the first service invocation.
  const run=AsyncLocalStorage.snapshot();
  options={...options,plugins:(options.plugins || []).map(plugin=>({...plugin,setup(builder){
    return run(()=>{
      const hooks={};
      for(const name of ['onResolve','onLoad'])hooks[name]=(settings,callback)=>builder[name](settings,(...args)=>run(callback,...args));
      for(const name of ['onStart','onEnd','onDispose'])hooks[name]=callback=>builder[name]((...args)=>run(callback,...args));
      return plugin.setup({...builder,...hooks});
    });
  }}))};
  // Runtime vendor bundles are framework-owned, not project webpack targets.
  const projectGraph = (options.plugins || []).some(plugin => framework.test(plugin.name));
  const compile = input => state?.incremental && state.dev && (projectGraph || !input.plugins?.length) ? incrementalBuild(input,{root:state.root,stage:state.stage,group:projectGraph?'project':'auxiliary',run:callback=>compilation.run(state,callback)}) : esbuild(input);
  if (!(state?.config?.webpack || Object.keys(state?.config?.turbopack?.rules || {}).length) || !projectGraph) return compile(options);
  const target = options.define?.['process.env.NEXT_RUNTIME'] === '"edge"' ? 'edge' : options.platform === 'browser' ? 'browser' : 'node';
  const config = await targetConfig(state,target);
  validateOptions ||= (await import('schema-utils')).validate;
  const callbacks = [];
  const require = createRequire(path.join(state.root,'package.json'));
  const emitted = new Map();
  const loaderPlugin = {name:'rustyx-webpack-loaders',setup(builder) {
    builder.onResolve({filter:/.*/},async args=>{
      if (args.pluginData?.rustyxLoaderResolution || args.namespace && args.namespace !== 'file') return;
      if (args.path.includes('!')) throw new Error('Inline loader requests require the webpack backend; configure webpack.module.rules or a graph plugin');
      const result = await builder.resolve(args.path,{resolveDir:args.resolveDir,importer:args.importer,kind:args.kind,with:args.with,pluginData:{...args.pluginData,rustyxLoaderResolution:true}});
      if (result.errors.length || result.external || !path.isAbsolute(result.path)) return;
      const loaders = await matching(config.rules,result.path,args.importer,result.suffix || '');
      if (!loaders.length) return;
      return {path:result.path,namespace:'file',suffix:result.suffix,pluginData:{rustyxLoaders:loaders,issuer:args.importer}};
    });
    builder.onLoad({filter:/.*/,namespace:'file'},async args=>{
      let selected = args.pluginData?.rustyxLoaders || await matching(config.rules,args.path,'',args.suffix);
      if(args.inlinePrefix)selected=selected.filter(item=>args.inlinePrefix==='!'?!!item.enforce:args.inlinePrefix==='-!'?item.enforce==='post':false);
      if (!selected.length) return;
      const loaders = selected.sort((a,b)=>({post:0,pre:2}[a.enforce]??1)-({post:0,pre:2}[b.enforce]??1)).map(item=>({loader:require.resolve(item.loader),options:item.options}));
      const execute = ()=>new Promise((resolve,reject)=>{
        const assets = [], warnings = [], errors = [];
        function resolveModule(context,request,callback){
          if (args.webpackContext) {this.cacheable(false);return args.webpackContext.getResolve()(context,request,callback);}
          const promise = builder.resolve(request,{resolveDir:context,kind:'import-statement',pluginData:{rustyxLoaderResolution:true}}).then(value=>{if(value.errors.length || !value.path)throw new Error(`Cannot resolve ${request} from ${context}`);return value.path;});
          if (callback) promise.then(value=>callback(null,value),callback); else return promise;
        }
        runLoaders({resource:args.path+(args.suffix || ''),loaders,readResource:(file,done)=>args.rustyxSource!==undefined && file===args.path ? done(null,Buffer.from(args.rustyxSource),args.rustyxSourceMap) : fs.readFile(file,done),context:{
          version:2,rootContext:state.root,mode:state.dev?'development':'production',target:target==='node'?'node':'web',sourceMap:!!options.sourcemap,fs,
          getOptions(schema){const value=this.query && typeof this.query==='object'?this.query:this.query?Object.fromEntries(new URLSearchParams(this.query.slice(1))):{};if(schema)validateOptions(schema,value,{name:this.loaders[this.loaderIndex].path});return value;},
          resolve:resolveModule,getResolve(settings){
            if (!settings || !Object.keys(settings).length) return resolveModule.bind(this);
            if (!args.webpackContext) throw new Error('Custom getResolve options require a webpack configuration');
            const resolve=args.webpackContext.getResolve(settings),loader=this;
            return (context,request,callback)=>{
              // Native resolution tracks dependencies on the webpack module, not
              // the disk runner: do not persist an incomplete dependency snapshot.
              loader.cacheable(false);
              return resolve(context,request,callback);
            };
          },
          getLogger:()=>console,emitWarning:error=>warnings.push(String(error?.message||error)),emitError:error=>errors.push(error instanceof Error?error:new Error(String(error))),
          emitFile(name,content){if(typeof name!=='string'||path.isAbsolute(name)||name.split(/[\\/]/).some(part=>part==='..'||!part)||/[\0?#]/.test(name))throw new Error(`Unsafe loader asset path: ${name}`);assets.push({name,data:Buffer.from(content).toString('base64')});},
          importModule(...values){if(!args.webpackContext)throw new Error('loader importModule requires a webpack configuration');this.cacheable(false);return args.webpackContext.importModule(...values);},
          loadModule(...values){if(!args.webpackContext)throw new Error('loader loadModule requires a webpack configuration');this.cacheable(false);return args.webpackContext.loadModule(...values);},
        }},(error,result)=>{
          if(error||errors.length)return reject(error||errors[0]);
          if(!result?.result || !['string','object'].includes(typeof result.result[0]))return reject(new Error('Loader must return JavaScript source'));
          const source=Buffer.isBuffer(result.result[0])?result.result[0].toString():result.result[0];
          if(typeof source!=='string')return reject(new Error('Loader must return a string or Buffer'));
          resolve({source,...(options.sourcemap && result.result[1]?{map:typeof result.result[1]==='string'?JSON.parse(result.result[1]):result.result[1]}:{}),assets,warnings,cacheable:result.cacheable,dependencies:result.fileDependencies,contexts:result.contextDependencies,missing:result.missingDependencies});
        });
      });
      // A loader installed by a graph plugin may already have changed the input.
      // Its source is not represented by the disk-loader cache's fingerprint.
      const transformed = args.rustyxSource!==undefined ? await execute() : await cachedLoader({root:state.root,file:args.path,query:args.suffix || '',loaders,target,dev:state.dev,sourceMap:!!options.sourcemap,mapPipeline:1,resolution:config.resolution,turbopackResolution:{resolveAlias:state.config.turbopack?.resolveAlias,resolveExtensions:state.config.turbopack?.resolveExtensions}},execute);
      const mappedSource=inlineSourceMap(transformed.source,transformed.map);
      for(const asset of transformed.assets){const previous=emitted.get(asset.name);if(previous && previous!==asset.data)throw new Error(`Conflicting loader asset: ${asset.name}`);emitted.set(asset.name,asset.data);}
      state.loaded.set(args.path,{...transformed,source:mappedSource});
      for (const callback of callbacks) {
        const result=await callback({...args,rustyxSource:mappedSource});
        if(result)return {...result,loader:result.loader || 'jsx',watchFiles:[...(result.watchFiles||[]),...transformed.dependencies],watchDirs:transformed.contexts,warnings:[...(result.warnings||[]),...transformed.warnings.map(text=>({text}))]};
      }
      return {contents:mappedSource,loader:'jsx',resolveDir:path.dirname(args.path),watchFiles:transformed.dependencies,watchDirs:transformed.contexts,warnings:transformed.warnings.map(text=>({text}))};
    });
  }};
  const plugins = (options.plugins || []).map(plugin=>!framework.test(plugin.name)?plugin:{...plugin,setup(builder){
    return plugin.setup({...builder,onLoad(settings,callback){if(settings.namespace==='file')callbacks.push(callback);builder.onLoad(settings,callback);}});
  }});
  if (config.graph) return webpackGraph({...options,
    ...(config.banners.length ? {banner:{...options.banner,js:[options.banner?.js,...config.banners].filter(Boolean).join('\n')}} : {}),
    ...(config.footers.length ? {footer:{...options.footer,js:[options.footer?.js,...config.footers].filter(Boolean).join('\n')}} : {}),
    define:{...options.define,...config.define},plugins:[moduleResolutionPlugin(config.resolution,state.root),loaderPlugin,...plugins],
  }, {state,config,target}).then(async result=>{
    for(const [name,data] of emitted){const file=path.join(state.stage,'assets',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.from(data,'base64'));}
    return result;
  });
  const result = await compile({...options,
    ...(config.banners.length ? {banner:{...options.banner,js:[options.banner?.js,...config.banners].filter(Boolean).join('\n')}} : {}),
    ...(config.footers.length ? {footer:{...options.footer,js:[options.footer?.js,...config.footers].filter(Boolean).join('\n')}} : {}),
    define:{...options.define,...config.define,__webpack_public_path__:JSON.stringify(state.assetBase+'/')},plugins:[moduleResolutionPlugin(config.resolution,state.root),loaderPlugin,...plugins]});
  for(const [name,data] of emitted){const file=path.join(state.stage,'assets',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.from(data,'base64'));}
  return result;
}
