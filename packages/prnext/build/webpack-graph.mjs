import {build as esbuild, transform} from 'esbuild';
import {mkdir, mkdtemp, readFile, writeFile, rm, rmdir, realpath} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import { cachedAsyncTransform } from './transform-cache.mjs';
import {inlineSourceMap} from './source-maps.mjs';
import {buildCacheIdentity} from './persistent-cache.mjs';

const require = createRequire(import.meta.url);
const {active} = require('./webpack-bridge.cjs');
const loaderPath = fileURLToPath(new URL('./webpack-loader.cjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const slash = value => value.replaceAll(path.sep, '/');
const safeAsset = name => { if (path.isAbsolute(name) || /[\\\0?#]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe webpack asset path: ${name}`); };
async function discardPrivateFile(file,boundary){
  await rm(file,{force:true});
  for(let directory=path.dirname(file);directory!==boundary&&directory.startsWith(boundary+path.sep);directory=path.dirname(directory)){
    try{await rmdir(directory);}catch(error){if(['ENOTEMPTY','EEXIST'].includes(error.code))break;if(error.code!=='ENOENT')throw error;}
  }
}
const sessions=new Map(),sessionLimit=6,sessionBuildLimit=64,objectIds=new WeakMap();
let nextId=0,created=0,reused=0,graphQueue=Promise.resolve();
const objectId=value=>{if(!objectIds.has(value))objectIds.set(value,++nextId);return objectIds.get(value);};
// Arbitrary plugin closures are not interchangeable just because their source
// text matches. Only known webpack constructors with the same options may be
// recreated; other plugins must retain their actual instance identity.
function fingerprint(value,seen=new Set()){
  if(typeof value==='function')return ['function',objectId(value)];
  if(value instanceof RegExp)return ['regexp',value.source,value.flags];
  if(value===undefined)return ['undefined'];
  if(typeof value==='symbol')throw new Error('Opaque symbol in webpack configuration');
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))return ['number',String(value),Object.is(value,-0)];
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return ['object',objectId(value)];
  seen.add(value);
  const properties=(skipIndices=false)=>{
    const keys=Reflect.ownKeys(value);
    if(keys.length>10000||keys.some(key=>typeof key==='symbol'))throw new Error('Opaque or excessive webpack configuration');
    return keys.filter(key=>!skipIndices||!/^(?:0|[1-9]\d*)$/.test(key)).sort().map(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor.get||descriptor.set)throw new Error('Accessor in webpack configuration');
      return[key,descriptor.enumerable,descriptor.configurable,descriptor.writable,fingerprint(descriptor.value,seen)];
    });
  };
  const prototype=Object.getPrototypeOf(value);let result;
  if(Array.isArray(value))result=['array',properties()];
  else if(prototype===Map.prototype){
    const extras=properties();
    if(value.size>10000)throw new Error('Excessive webpack Map configuration');
    const key=item=>item&&(typeof item==='object'||typeof item==='function')?['identity',objectId(item),fingerprint(item,seen)]:fingerprint(item,seen);
    result=['map',[...Map.prototype.entries.call(value)].map(([name,item])=>[key(name),fingerprint(item,seen)]),extras];
  }else if(prototype===Set.prototype){
    const extras=properties();
    if(value.size>10000)throw new Error('Excessive webpack Set configuration');
    result=['set',[...Set.prototype.values.call(value)].map(item=>item&&(typeof item==='object'||typeof item==='function')?['identity',objectId(item),fingerprint(item,seen)]:fingerprint(item,seen)),extras];
  }else if(prototype===Date.prototype)result=['date',String(Date.prototype.getTime.call(value)),properties()];
  else if(prototype===ArrayBuffer.prototype){
    if(value.byteLength>1024*1024)throw new Error('Excessive webpack binary configuration');
    result=['array-buffer',Buffer.from(value).toString('base64'),value.resizable,value.maxByteLength,properties()];
  }else if(ArrayBuffer.isView(value)){
    if(value.byteLength>10000)throw new Error('Excessive webpack binary view configuration');
    const types=[Buffer,Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,DataView];
    const type=types.find(type=>prototype===type.prototype);
    if(!type)throw new Error('Opaque webpack binary configuration');
    result=[type.name,fingerprint(value.buffer,seen),value.byteOffset,value.byteLength,properties(true)];
  }else if(prototype===Object.prototype||prototype===null)result=['record',prototype===null,properties()];
  else throw new Error('Opaque webpack configuration instance');
  seen.delete(value);return result;
}
function pluginIdentity(plugin,webpack){
  const fields={NormalModuleReplacementPlugin:['resourceRegExp','newResource'],IgnorePlugin:['options'],ProvidePlugin:['definitions'],DefinePlugin:['definitions'],BannerPlugin:['options']};
  for(const[name,keys]of Object.entries(fields))if(plugin.constructor===webpack[name])return[name,fingerprint(Object.fromEntries(keys.map(key=>[key,plugin[key]])))];
  return ['instance',objectId(plugin),fingerprint(plugin)];
}
export const webpackCompilerStats=()=>({contexts:sessions.size,created,reused,limit:sessionLimit,buildLimit:sessionBuildLimit});
function queued(callback){const task=graphQueue.then(callback);graphQueue=task.catch(()=>{});return task;}
export function closeWebpackCompiler(root){return queued(async()=>{
  if(root!==undefined){
    try{root=await realpath(root);}
    catch(error){
      if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;
      root=path.resolve(root);
    }
  }
  const closing=[];for(const[key,session]of sessions)if(root===undefined||session.root===root){sessions.delete(key);closing.push(session.dispose());}
  const results=await Promise.allSettled(closing),errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'Unable to dispose webpack compiler sessions');
});}

async function compileGraph(resolver,loads,options,{state,config,target}){
  return queued(async()=>{
    // Ownership uses one canonical identity for invalidation and disposal.
    // Compiler paths and graph fingerprints retain the caller's lexical root.
    const ownerRoot=await realpath(state.root);
    const webpack=(await import('webpack')).default;
    let reusable=state.dev&&state.incremental,identity;
    if(reusable){try{identity=await buildCacheIdentity(state.root);}catch{}if(!identity)reusable=false;}
    let base,key;
    if(reusable)try{
      const normalize=value=>typeof value==='string'?value.replaceAll(state.stage,'<stage>'):Array.isArray(value)?value.map(normalize):value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)])):value;
      const normalized=normalize({...options,plugins:(options.plugins||[]).map(plugin=>plugin.name),stdin:options.stdin&&{...options.stdin,contents:undefined}});
      base=hash(JSON.stringify(fingerprint([state.root,target,normalized])));
      key=hash(JSON.stringify([base,identity,fingerprint({...config,graphPlugins:undefined}),config.graphPlugins.map(plugin=>pluginIdentity(plugin,webpack))]));
    }catch{reusable=false;}
    // Unknown data structures, safe mode and unavailable identities all keep
    // compilation correct through a one-shot compiler. Hidden mutable closure
    // state cannot be fingerprinted: replace the plugin instance when it changes.
    if(state.dev&&!reusable)for(const[key,session]of sessions)if(session.root===ownerRoot){sessions.delete(key);await session.dispose();}
    let session=reusable&&sessions.get(key);
    if(session&&session.builds>=sessionBuildLimit){sessions.delete(key);await session.dispose();session=undefined;}
    if(reusable){
      for(const[old,previous]of sessions)if(previous.root===ownerRoot&&(previous.identity!==identity||previous.base===base&&old!==key)){sessions.delete(old);await previous.dispose();}
    }
    if(session){sessions.delete(key);reused++;}
    else{
      if(reusable)while(sessions.size>=sessionLimit){const[old,previous]=sessions.entries().next().value;sessions.delete(old);await previous.dispose();}
      session=await createGraphSession(state.root,{webpack,reusable,stage:state.stage});created++;
      Object.assign(session,{root:ownerRoot,base,identity,builds:0});
    }
    if(reusable)sessions.set(key,session);
    try{session.builds++;return await session.run(resolver,loads,options,{state,config,target});}
    catch(error){if(reusable)sessions.delete(key);await session.dispose();throw error;}
    finally{if(!reusable)await session.dispose();}
  });
}

/** Webpack owns the actual module/chunk graph. PRNext's resolve/load transforms
 * remain authoritative for React boundaries and the Node/Edge/browser targets.
 */
export async function webpackGraph(options, {state, config, target}) {
  const loads = [], starts = [], ends = [], disposes = [];
  let output;
  const scaffold = {...options, entryPoints:undefined, stdin:{contents:'',resolveDir:state.root},
    outfile:undefined, outdir:path.join(state.stage,'.webpack-resolver'), outbase:undefined, splitting:false, write:false, metafile:false,
    plugins:[{name:'prnext-webpack-resolver',async setup(builder) {
      for (const plugin of options.plugins || []) await plugin.setup({...builder,
        onLoad(settings,callback){loads.push({settings,callback,configuredLoaders:plugin.name==='prnext-webpack-loaders',framework:/^prnext-(?:pages-compatibility|app-|edge)/.test(plugin.name)});},
        onStart(callback){starts.push(callback);}, onEnd(callback){ends.push(callback);}, onDispose(callback){disposes.push(callback);},
      });
      builder.onStart(async()=>{
        for (const start of starts) await start();
        output = await compileGraph(builder, loads, options, {state,config,target});
        for (const end of ends) await end(output);
      });
    }}]};
  try { await esbuild(scaffold); return output; }
  finally { for (const dispose of disposes) await dispose(); }
}

async function createGraphSession(root,{webpack,reusable,stage}) {
  const bridgeId = randomUUID();
  await mkdir(path.join(stage,'.entries'),{recursive:true});
  const home=await realpath(await mkdtemp(path.join(reusable?root:path.join(stage,'.entries'),'.prnext-webpack-')));
  const virtualDirectory=path.join(home,'modules'),virtualStage=path.join(home,'stage'),scratchOut=path.join(home,'output');
  await mkdir(virtualDirectory,{recursive:true});
  const projectRequire = createRequire(path.join(root,'package.json'));
  let compiler,resolver,loads,options,state,config,target,outdir,actualOut,extension,modules,entries,runtime,disposed=false;
  const virtualFiles=new Set(),loaderFiles=new Set(),previousOutputs=new Set();let usedVirtualFiles;
  const fromVirtual=value=>typeof value==='string'&&(value===virtualStage||value.startsWith(virtualStage+path.sep))?state.stage+value.slice(virtualStage.length):value;
  const toVirtual=value=>reusable&&typeof value==='string'&&(value===state.stage||value.startsWith(state.stage+path.sep))?virtualStage+value.slice(state.stage.length):value;
  const stageFile=async file=>{
    const mapped=toVirtual(file);if(mapped===file)return file;
    virtualFiles.add(mapped);usedVirtualFiles.add(mapped);
    const contents=await readFile(file);await mkdir(path.dirname(mapped),{recursive:true});
    let previous;try{previous=await readFile(mapped);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!previous?.equals(contents))await writeFile(mapped,contents);return mapped;
  };
  const run=async(nextResolver,nextLoads,nextOptions,next)=>{
  resolver=nextResolver;loads=nextLoads;options=nextOptions;({state,config,target}=next);
  usedVirtualFiles=new Set();
  outdir=options.outdir||(options.outfile?path.dirname(options.outfile):scratchOut);actualOut=reusable||options.write===false?scratchOut:outdir;extension=options.outExtension?.['.js']||'.js';modules=new Map();
  // Webpack may retain SizeOnlySource for unchanged assets and assume the last
  // emitted file still exists. Keep current outputs until the next run finishes.
  await mkdir(actualOut,{recursive:true});
  entries=options.stdin?{entry:path.join(virtualDirectory,'entry.js')}:Array.isArray(options.entryPoints)?Object.fromEntries(options.entryPoints.map(file=>[path.basename(file,path.extname(file)),toVirtual(file)])):Object.fromEntries(Object.entries(options.entryPoints).map(([name,file])=>[name,toVirtual(file)]));
  for(const file of Object.values(entries))if(file.startsWith(virtualStage+path.sep))await stageFile(fromVirtual(file));
  if (options.stdin) {
    const file = entries.entry;
    await writeFile(file,options.stdin.contents);
    virtualFiles.add(file);usedVirtualFiles.add(file);
    modules.set(file,{path:file,namespace:'file',resolveDir:options.stdin.resolveDir || state.root,stdin:true});
  }
  const identify = record => record.namespace === 'file' ? slash(path.relative(state.root,record.path)) : record.namespace+':'+slash(path.relative(state.root,record.path));
  const lookup = resource => modules.get(resource) || modules.get(resource?.split('?')[0]) || {path:fromVirtual(resource?.split('?')[0]),namespace:'file',suffix:resource?.includes('?')?'?'+resource.split('?').slice(1).join('?'):''};
  const load = async(record,source,webpackContext,sourceMap) => {
    if (record.stdin) return {contents:source,loader:options.stdin.loader || 'js',resolveDir:record.resolveDir};
    for (const {settings,callback,framework,configuredLoaders} of loads) {
      if (configuredLoaders && record.inline) continue;
      if (settings.namespace && settings.namespace !== record.namespace) continue;
      settings.filter.lastIndex = 0;
      if (!(record.customLoader && framework && settings.namespace==='file') && !settings.filter.test(record.path)) continue;
      const result = await callback({...record,webpackContext,prnextSourceMap:sourceMap,prnextSource:record.namespace==='file' && (!configuredLoaders || record.nativeLoaders)?(configuredLoaders?source.toString():inlineSourceMap(source.toString(),sourceMap)):undefined});
      if (result) {
        if (result.errors?.length) throw new Error(result.errors.map(error=>error.text).join('\n'));
        return result;
      }
    }
    return {contents:inlineSourceMap(source.toString(),sourceMap),loader:options.loader?.[path.extname(record.path)] || ({'.json':'json','.ts':'ts','.tsx':'tsx','.jsx':'jsx','.css':'css'}[path.extname(record.path)] || 'js')};
  };
  active.set(bridgeId,{async transform(context,source,sourceMap) {
    const record = modules.get(context._module.rawRequest) || lookup(context.resource);
    if (record.namespace==='file' && context.loaders.length===1) state.devInputs?.record(record.path,source);
    // CSS url() inputs are binary resources, not JavaScript export wrappers.
    if (record.cssAsset) return {code:source};
    record.nativeLoaders = context.loaders.length > 1;
    if (context.loaders.length > 1 && record.namespace==='file') state.loaded.set(record.path,{source:source.toString()});
    const result = await load(record,source,context,sourceMap);
    record.resolveDir = result.resolveDir || record.resolveDir || path.dirname(record.path);
    for (const file of result.watchFiles || []) context.addDependency(file);
    for (const directory of result.watchDirs || []) context.addContextDependency(directory);
    for (const warning of result.warnings || []) context.emitWarning(new Error(warning.text));
    const contents = Buffer.from(result.contents);
    if (['css','json'].includes(result.loader)) return {code:contents.toString()};
    if (result.loader === 'file') {
      const name = path.basename(record.path,path.extname(record.path))+'-'+hash(contents)+path.extname(record.path);
      context.emitFile(name,contents);
      return {code:`export default ${JSON.stringify(state.assetBase+'/'+name)}`};
    }
    const flightAdapter=/[/\\]react-server-dom-webpack[/\\].*client\.browser/.test(record.path);
    const settings={loader:result.loader || 'js',sourcefile:record.path,
      jsx:options.jsx || 'automatic',target:options.target || 'es2022',define:{...options.define,...(flightAdapter?{
        __webpack_require__:'globalThis.__webpack_require__',__webpack_chunk_load__:'globalThis.__webpack_chunk_load__',__webpack_get_script_filename__:'globalThis.__webpack_get_script_filename__',
      }:{})},
      sourcemap:options.sourcemap ? 'external' : false,format:undefined,
    };
    const code = JSON.parse(await cachedAsyncTransform('webpack-syntax',contents.toString(),settings,async()=>JSON.stringify(await transform(contents.toString(),settings))));
    return {code:code.code,map:code.map ? JSON.parse(code.map) : sourceMap};
  }});
  const naming = template => (template || '[name]').replaceAll('[hash]','[contenthash:16]');
  // A changed synchronous chunk may leave webpack's runtime bytes unchanged.
  // Give each published build its own module cache; React's dev singletons
  // still retain their identities across the new runtime instance.
  runtime = 'webpack-runtime-'+hash(JSON.stringify([state.stage,Object.keys(entries),options.conditions,target]));
  try {
    if(!compiler)compiler = webpack({name:target,context:state.root,mode:state.dev?'development':'production',
      ...(config.watchOptions ? {watchOptions:config.watchOptions} : {}),
      target:target==='node'?'node22':['web','es2022'],entry:entries,cache:reusable?{type:'memory',maxGenerations:1}:false,devtool:options.sourcemap?'source-map':false,
      experiments:{outputModule:true,css:true},externalsType:'module',
      output:{path:actualOut,filename:options.outfile?path.basename(options.outfile):naming(options.entryNames)+extension,
        chunkFilename:naming(options.chunkNames || 'chunk-[hash]')+extension,cssFilename:naming(options.entryNames)+'.css',
        cssChunkFilename:'style-[contenthash:16].css',module:true,library:{type:'module'},chunkFormat:'module',chunkLoading:'import',
        publicPath:target==='node'?'./':state.assetBase+'/',environment:{module:true,dynamicImport:true},compareBeforeEmit:false,clean:false},
      performance:false,
      optimization:{minimize:!!options.minify,mangleExports:options.minify?'size':false,minimizer:[{apply(compiler){
        compiler.hooks.compilation.tap('PRNextMinify',compilation=>{
          compilation.hooks.processAssets.tapPromise({name:'PRNextMinify',stage:webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE},async()=>{
            // Sequential native esbuild transforms avoid a Terser worker pool.
            for(const asset of compilation.getAssets()){
              if(!/\.(?:m?js|css)$/.test(asset.name))continue;
              const original=asset.source.sourceAndMap(),source=original.source.toString();
              const settings={loader:asset.name.endsWith('.css')?'css':'js',minify:true,target:options.target || 'es2022',sourcefile:asset.name,sourcemap:options.sourcemap?'external':false,legalComments:'eof'};
              const minified=JSON.parse(await cachedAsyncTransform('webpack-minify',source,settings,async()=>JSON.stringify(await transform(source,settings))));
              compilation.updateAsset(asset.name,minified.map?new webpack.sources.SourceMapSource(minified.code,asset.name,JSON.parse(minified.map),source,original.map,true):new webpack.sources.RawSource(minified.code));
            }
          });
        });
      }}],runtimeChunk:options.splitting?{name:()=>runtime}:false,
        splitChunks:options.splitting?{chunks:'all',minSize:0,cacheGroups:{default:false,defaultVendors:false,shared:{minChunks:2,reuseExistingChunk:true,test:module=>!module.type.startsWith('css'),name:false}}}:false},
      resolve:{alias:config.resolution.resolveAlias || {},conditionNames:[...(options.conditions || []),'...'],extensions:config.resolution.resolveExtensions || ['.tsx','.ts','.jsx','.js','.mjs','.json'],fullySpecified:false},
      module:{unsafeCache:false,rules:[{test:/./,type:'javascript/auto',enforce:'post',use:[{loader:loaderPath,options:{bridge:bridgeId}}]},
        {test:/\.json$/,type:'json'},{test:/\.(?:css|scss|sass)$/,type:'css'},
        {dependency:'url',type:'asset/resource'}]},
      plugins:[...config.graphPlugins,
        ...(!options.splitting?[new webpack.optimize.LimitChunkCountPlugin({maxChunks:1})]:[]),
        ...(options.banner?.js?[new webpack.BannerPlugin({banner:options.banner.js,raw:true})]:[]),
        ...(options.footer?.js?[new webpack.BannerPlugin({banner:options.footer.js,raw:true,footer:true})]:[]),
        {apply(compiler) {
          if (state.devInputs && config.graphPlugins.some(plugin=>plugin.constructor?.name==='ContentlayerWebpackPlugin')) {
            compiler.hooks.beforeCompile.tapPromise({name:'PRNextGeneratedInputs',stage:Number.MAX_SAFE_INTEGER},()=>
              state.devInputs&&(state.generatedInputs ||= state.devInputs.captureDirectory('.contentlayer/generated')));
          }
          compiler.hooks.normalModuleFactory.tap('PRNextFramework',factory=>{
            factory.hooks.beforeResolve.tapPromise({name:'PRNextFramework',stage:10000},async data=>{
              if (!data || modules.has(data.request)) return;
              const importer = lookup(data.contextInfo.issuer);
              const dependency = data.dependencies[0];
              const kind = dependency?.type?.includes('url') ? 'url-token' : dependency?.type==='css @import'?'import-rule':data.dependencyType==='commonjs'?'require-call':dependency?.type==='import()'?'dynamic-import':data.contextInfo.issuer?'import-statement':'entry-point';
              const settings={resolveDir:fromVirtual(importer.resolveDir || data.context || state.root),importer:importer.path || '',namespace:importer.namespace || 'file',kind};
              // Let webpack resolve/execute the inline loader chain itself. Only
              // its resource passes through framework resolution.
              const bang=data.request.lastIndexOf('!');
              const inline=bang<0?'':data.request.slice(0,bang+1);
              const request=fromVirtual(bang<0?data.request:data.request.slice(bang+1));
              const resolved = await resolver.resolve(request,settings);
              if (resolved.errors.length) throw new Error(resolved.errors.map(error=>error.text).join('\n'));
              if (resolved.external) {
                data.prnextExternal=resolved.path;
                if (dependency?.type==='css url()') {
                  data.prnextExternalType='asset';data.prnextExternalMeta={sourceType:'asset-url'};
                } else if (kind==='import-rule') {
                  data.prnextExternalType='css-import';
                  data.prnextExternalMeta={layer:dependency.layer,supports:dependency.supports,media:dependency.media};
                }
                return;
              }
              const record={...resolved,namespace:resolved.namespace || 'file',cssAsset:dependency?.type==='css url()',inline:!!inline,customLoader:!!inline,inlinePrefix:inline.startsWith('!!')?'!!':inline.startsWith('-!')?'-!':inline.startsWith('!')?'!':''};
              let resource=record.path+(record.suffix || '');
              if(record.namespace!=='file'){
                resource=path.join(virtualDirectory,hash(JSON.stringify([record.namespace,record.path,record.suffix]))+(/css$/.test(record.namespace)?'.css':'.js'));
                if(!modules.has(resource))await writeFile(resource,'');
                virtualFiles.add(resource);usedVirtualFiles.add(resource);
              }else if(toVirtual(record.path)!==record.path){
                resource=await stageFile(record.path)+(record.suffix||'');
              }
              data.request=inline+resource;
              modules.set(data.request,record);
            });
            factory.hooks.afterResolve.tap({name:'PRNextInlineLoaders',stage:10000},data=>{
              const record=modules.get(data.createData.rawRequest);
              if (!record?.inline) return;
              const selected=(record.pluginData?.prnextLoaders || []).filter(item=>record.inlinePrefix==='!!'?false:record.inlinePrefix==='-!'?item.enforce==='post':record.inlinePrefix==='!'?!!item.enforce:true);
              const resolve=item=>({loader:projectRequire.resolve(item.loader),options:item.options});
              // The framework bridge must run even when !! disables user rules.
              // Normal webpack order: post, inline, normal, pre (right to left).
              data.createData.loaders=[{loader:loaderPath,options:{bridge:bridgeId}},
                ...selected.filter(item=>item.enforce==='post').map(resolve),
                ...data.createData.loaders.filter(item=>item.loader!==loaderPath),
                ...selected.filter(item=>!item.enforce).map(resolve),
                ...selected.filter(item=>item.enforce==='pre').map(resolve)];
              // Webpack computed the identity before this hook. Prefix variants
              // must not collapse onto the same module after adding user rules.
              data.createData.request=data.createData.loaders.map(item=>item.loader+(item.options?'?'+JSON.stringify(item.options):'')).join('!')+'!'+data.createData.resource;
            });
            factory.hooks.factorize.tapAsync({name:'PRNextExternals',stage:-10000},(data,done)=>{
              if(data.prnextExternal!==undefined)return done(null,new webpack.ExternalModule(data.prnextExternal,data.prnextExternalType || (target==='node'&&!data.prnextExternal.endsWith('.mjs')?'node-commonjs':'module'),data.request,data.prnextExternalMeta));
              done();
            });
          });
          compiler.hooks.compilation.tap('PRNextOutput',compilation=>{
            compilation.hooks.processAssets.tap({name:'PRNextAssetPaths',stage:webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT},()=>{
              for(const asset of compilation.getAssets())safeAsset(asset.name);
            });
          });
        }},
      ]});
    // Native loader modules live outside webpack's graph cache. Reload tracked
    // implementations so editing a loader cannot retain its require() closure.
    const clearLoader=file=>{const loaded=require.cache[file];delete require.cache[file];for(const child of loaded?.children||[])if(child.filename!==loaderPath)clearLoader(child.filename);};
    for(const file of loaderFiles)clearLoader(file);
    compiler.inputFileSystem.purge?.();
    const stats=await new Promise((resolve,reject)=>compiler.run((error,stats)=>error?reject(error):resolve(stats)));
    if(stats.hasErrors())throw new Error(stats.toString({all:false,errors:true,errorDetails:true}));
    for(const warning of stats.compilation.warnings){
      const file=warning.module?.resource || warning.module?.identifier?.() || '';
      const location=typeof warning.loc==='string'?warning.loc:warning.loc?.start?`${warning.loc.start.line}:${warning.loc.start.column}`:'';
      console.warn(`[PRNext webpack ${target}] ${file?slash(path.relative(state.root,file)):''}${location?':'+location:''}\n${warning.message}`);
    }
    const compilation=stats.compilation, inputs={}, outputs={}, outputFiles=[];
    const entryFiles=new Map(), styles=new Map(), chunkFiles=new Set();
    for(const chunk of compilation.chunks)for(const file of chunk.files)chunkFiles.add(file);
    for(const [name,entry] of compilation.entrypoints){
      const file=[...entry.getEntrypointChunk().files].find(file=>file.endsWith(extension));
      if(file)entryFiles.set(file,fromVirtual(entries[name]));
      const css=entry.getFiles().find(file=>file.endsWith('.css'));if(file&&css)styles.set(file,css);
    }
    for(const module of compilation.modules){
      for(const loader of module.loaders||[])if(loader.loader!==loaderPath)loaderFiles.add(loader.loader);
      if(!module.resource)continue;
      const record=lookup(module.resource), imports=[];
      for(const connection of compilation.moduleGraph.getOutgoingConnections(module)){
        if(connection.module?.resource)imports.push({path:identify(lookup(connection.module.resource)),kind:'import-statement'});
      }
      inputs[identify(record)]={bytes:module.originalSource()?.size() || 0,imports};
    }
    const inputSizes=Object.fromEntries(Object.keys(inputs).map(key=>[key,{bytesInOutput:0}]));
    for(const asset of compilation.getAssets()){
      safeAsset(asset.name);
      const contents=await readFile(path.join(actualOut,asset.name));
      const file=path.join(outdir,asset.name), key=slash(path.relative(state.root,file));
      if(options.write!==false&&file!==path.join(actualOut,asset.name)){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,contents);}
      outputs[key]={bytes:contents.length,imports:[],exports:[],inputs:inputSizes,
        ...(entryFiles.has(asset.name)?{entryPoint:slash(path.relative(state.root,entryFiles.get(asset.name)))}:{}),
        ...(styles.has(asset.name)?{cssBundle:slash(path.relative(state.root,path.join(outdir,styles.get(asset.name))))}:{})};
      outputFiles.push({path:file,contents,get text(){return this.contents.toString();},hash:hash(contents)});
      if(!chunkFiles.has(asset.name)&&!asset.name.endsWith('.map')){
        const destination=path.join(state.stage,'assets',asset.name);
        if(destination!==path.join(actualOut,asset.name)){
          try {if(!(await readFile(destination)).equals(contents))throw new Error(`Conflicting webpack asset: ${asset.name}`);}catch(error){if(error.code!=='ENOENT')throw error;}
          await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,contents);
        }
      }
    }
    const rank = file => entryFiles.has(slash(path.relative(outdir,file.path))) ? 0 : file.path.endsWith(extension) ? 1 : 2;
    outputFiles.sort((a,b)=>rank(a)-rank(b));
    if(reusable){
      const currentOutputs=new Set(compilation.getAssets().map(asset=>asset.name));
      for(const name of previousOutputs)if(!currentOutputs.has(name))await discardPrivateFile(path.join(actualOut,name),actualOut);
      previousOutputs.clear();for(const name of currentOutputs)previousOutputs.add(name);
    }
    // This compatibility metafile does not yet encode webpack's runtime and
    // async chunk-group edges. Consumers must not mistake empty import lists
    // for a complete initial browser graph.
    return {errors:[],warnings:[],metafile:{inputs,outputs,initialGraphComplete:false},...(options.write===false?{outputFiles}:{})};
  } finally {
    active.delete(bridgeId);
    for(const file of virtualFiles)if(!usedVirtualFiles.has(file)){virtualFiles.delete(file);await discardPrivateFile(file,home);}
  }
  };
  return {run,async dispose(){
    if(disposed)return;disposed=true;
    try{if(compiler)await new Promise((resolve,reject)=>compiler.close(error=>error?reject(error):resolve()));}
    finally{active.delete(bridgeId);await rm(home,{recursive:true,force:true});compiler=resolver=state=config=options=modules=undefined;loads=[];virtualFiles.clear();loaderFiles.clear();previousOutputs.clear();}
  }};
}
