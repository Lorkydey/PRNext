import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {SourceMap} from 'node:module';
import {stripServerCode} from './transform.mjs';
import {build,withCompilation,configureCompiler,validateCompilerConfig} from './compiler.mjs';
import {closeIncrementalCompiler} from './incremental.mjs';
import {webpackCompilerStats} from './webpack-graph.mjs';

test('webpack plugins replace dependencies, inject providers and inspect real modules and chunks',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-graph-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=path.join(root,'stage');await mkdir(stage);
  const files={'entry.js':"import message from './replaced.js';try{require('./ignored.js')}catch{};export default message+PROVIDED;export const lazy=async()=> (await import('./lazy.js')).default",'replacement.js':"export default 'changed:'",'provider.cjs':'module.exports=7','lazy.js':"export default 'lazy value'"};
  for(const [name,source]of Object.entries(files))await writeFile(path.join(root,name),source);
  await writeFile(path.join(root,'configured.cjs'),'module.exports=source=>source');
  await writeFile(path.join(root,'injected.cjs'),`module.exports=source=>source.replace('changed:','hook:')`);
  let inspected=false,chunks=false;
  const result=await withCompilation(async()=>{
    configureCompiler({root,stage,loaded:new Map(),assetBase:'/_prnext/assets',config:{webpack(config,{webpack}){
      config.module.rules.push({test:/replacement\.js$/,use:[path.join(root,'configured.cjs')]});
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(/replaced\.js$/,path.join(root,'replacement.js')),
        new webpack.IgnorePlugin({resourceRegExp:/ignored\.js$/}),new webpack.ProvidePlugin({PROVIDED:path.join(root,'provider.cjs')}),
        new webpack.BannerPlugin({banner:({chunk})=>'Graph entry '+chunk.name,entryOnly:true}),
        {apply(compiler){compiler.hooks.normalModuleFactory.tap('InjectLoader',factory=>factory.hooks.afterResolve.tap('InjectLoader',data=>{
          if(data.createData.resource.endsWith(path.sep + 'replacement.js'))data.createData.loaders.push({loader:path.join(root,'injected.cjs')});
        }));compiler.hooks.compilation.tap('Inspect',compilation=>{
          compilation.hooks.optimizeModules.tap('Inspect',modules=>{inspected ||= [...modules].some(module=>module.resource?.endsWith(path.sep + 'replacement.js'));});
          compilation.hooks.optimizeChunks.tap('Inspect',values=>{chunks ||= [...values].length>1;});
        });}});return config;
    }}});
    return build({absWorkingDir:root,entryPoints:{entry:path.join(root,'entry.js')},outdir:path.join(stage,'server'),outExtension:{'.js':'.mjs'},bundle:true,splitting:true,format:'esm',platform:'node',metafile:true,plugins:[{name:'prnext-pages-compatibility',setup(){}}]});
  });
  assert.ok(inspected);assert.ok(chunks);
  const entry=Object.keys(result.metafile.outputs).find(file=>result.metafile.outputs[file].entryPoint);
  const module=await import(pathToFileURL(path.resolve(root,entry)).href);
  assert.match(await readFile(path.resolve(root,entry),'utf8'),/Graph entry entry/);
  assert.equal(module.default,'hook:7');assert.equal(await module.lazy(),'lazy value');
});

async function fixture(t, files) {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-loader-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=path.join(root,'stage');await mkdir(stage);
  for(const [name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),source);}
  return {root,stage,async compile(configure, name='entry', options={}) {
    return withCompilation(async()=>{
      configureCompiler({root,stage,loaded:new Map(),assetBase:'/_prnext/assets',config:{productionBrowserSourceMaps:!!options.sourcemap,webpack(config,context){configure(config,context,root);return config;}}});
      const outfile=path.join(stage,name+'.mjs');
      await build({absWorkingDir:root,entryPoints:[path.join(root,'entry.js')],outfile,bundle:true,format:'esm',platform:'node',metafile:true,plugins:[{name:'prnext-pages-compatibility',setup(){}}],...options});
      return import(pathToFileURL(outfile).href);
    });
  }};
}

test('Contentlayer-style hooks generate modules before compilation with watch exclusions and relaxed ESM rules', async t => {
  const f = await fixture(t, {'entry.js':"import message from './generated';export default message"});
  let beforeCompile = 0;
  const actual = await f.compile(config => {
    config.watchOptions = {ignored:['**/node_modules/!(.contentlayer)/**/*']};
    config.module.rules.push({test:/\.m?js$/,type:'javascript/auto',resolve:{fullySpecified:false}});
    config.plugins.push({apply(compiler) {
      assert.deepEqual(compiler.options.watchOptions.ignored,config.watchOptions.ignored);
      compiler.hooks.beforeCompile.tapPromise('GenerateContent',async () => {
        beforeCompile++;
        await writeFile(path.join(f.root,'generated.js'),"export default 'generated content'");
      });
    }});
  });
  assert.equal(actual.default,'generated content');
  assert.equal(beforeCompile,1);
  for (const patch of [config=>{config.watchOptions={poll:true}},config=>{config.watchOptions={ignored:12}},config=>config.module.rules.push({type:'asset'}),config=>config.module.rules.push({resolve:{fullySpecified:true}})]) {
    await assert.rejects(validateCompilerConfig({webpack(config){patch(config);return config}},f.root),/watchOptions|rule/);
  }
});

test('webpack Flight loader imports runtime URLs, retries failures and refreshes loaded modules', async t => {
  const runtime=fileURLToPath(new URL('../runtime/app-client.mjs',import.meta.url));
  const f=await fixture(t,{'entry.js':`export {installFlightModuleLoader} from ${JSON.stringify(runtime)}`});
  await symlink(fileURLToPath(new URL('../../../node_modules',import.meta.url)),path.join(f.root,'node_modules'),process.platform==='win32'?'junction':'dir');
  const warnings=[];t.mock.method(console,'warn',value=>warnings.push(value));
  const previous=Object.fromEntries(['__webpack_require__','__webpack_chunk_load__','__webpack_get_script_filename__'].map(key=>[key,globalThis[key]]));
  t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
  const {installFlightModuleLoader}=await f.compile(config=>config.plugins.push({apply(){}}),'entry',{packages:'external'});
  const url=value=>'data:text/javascript,'+encodeURIComponent(`export default ${JSON.stringify(value)}`);
  let attempts=0;
  const loader=installFlightModuleLoader({string:url('string'),object:{browserModule:url('object')},retry:()=>{
    if(++attempts===1)throw new Error('temporary failure');return import(url('retried'));
  }});
  const load=globalThis.__webpack_chunk_load__, require=globalThis.__webpack_require__;
  const first=load('string');assert.equal(load('string'),first);
  await Promise.all([first,load('object')]);
  assert.equal(require('string').default,'string');assert.equal(require('object').default,'object');
  await assert.rejects(load('retry'),/temporary failure/);await load('retry');
  assert.equal(require('retry').default,'retried');
  await loader.updateModules({string:{browserModule:url('updated')},object:()=>import(url('updated object'))});
  assert.equal(require('string').default,'updated');assert.equal(require('object').default,'updated object');
  assert.deepEqual(warnings,[],'valid runtime imports must not become webpack contexts');
});

test('webpack CSS preserves external URLs and binary assets without JavaScript imports', async t => {
  const font = Buffer.from([0,255,127,128,1,2,3]);
  const f = await fixture(t,{
    'entry.js':"import './styles.css';export default 'interactive'",
    'styles.css':`@import url("https://example.test/theme.css") layer(theme) supports(display: grid) screen;
@font-face{font-family:Local;src:url('./font.woff2')}
@font-face{font-family:Public;src:url('/fonts/public.woff2')}
body{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")}`,
    'font.woff2':font,
  });
  const value=await f.compile(config=>config.plugins.push({apply(){}}),'entry',{
    platform:'browser',loader:{'.woff2':'file'},plugins:[{name:'prnext-pages-compatibility',setup(builder){
      builder.onResolve({filter:/^\//},args=>args.kind==='url-token'?{path:args.path,external:true}:undefined);
    }}],
  });
  assert.equal(value.default,'interactive');
  const css=await readFile(path.join(f.stage,'entry.css'),'utf8');
  assert.match(css,/https:\/\/example\.test\/theme\.css/);
  assert.match(css,/layer\(theme\).*supports\(display: grid\).*screen/);
  assert.match(css,/\/fonts\/public\.woff2/);
  assert.match(css,/data:image\/svg\+xml/);
  assert.doesNotMatch(css,/data:,/);
  const outputs=await readdir(f.stage);
  const emitted=outputs.filter(file=>file.endsWith('.woff2'));
  assert.equal(emitted.length,1);
  assert.deepEqual(await readFile(path.join(f.stage,emitted[0])),font);
  const js=await readFile(path.join(f.stage,'entry.mjs'),'utf8');
  assert.doesNotMatch(js,/(?:import|from)\s*["'][^"']*(?:woff2|data:image|theme\.css)/);
});

test('configured webpack loaders use real importModule/loadModule and customized resolution without stale cache',async t=>{
  const f=await fixture(t,{
    'entry.js':"import result from './data.note';export default result",
    'data.note':'input',
    'value.js':'export default 7',
    'dependency.js':'export default 42',
    'choice.custom':'custom resolution',
    'api.cjs':`module.exports=function(){const done=this.async();(async()=>{
      const value=await this.importModule('./value.js');
      const callbackValue=await new Promise((resolve,reject)=>this.importModule('./value.js',{},(error,value)=>error?reject(error):resolve(value)));
      const loaded=await new Promise((resolve,reject)=>this.loadModule('./dependency.js',(error,source,map,module)=>error?reject(error):resolve({source,resource:module.resource})));
      const resolve=this.getResolve({extensions:['.custom']});
      const promisePath=await resolve(this.context,'./choice');
      const callbackPath=await new Promise((yes,no)=>resolve(this.context,'./choice',(err,file)=>err?no(err):yes(file)));
      const defaultPath=await this.getResolve()(this.context,'aliased-value');
      const resolvedPath=await new Promise((yes,no)=>this.resolve(this.context,'aliased-value',(err,file)=>err?no(err):yes(file)));
      return 'export default '+JSON.stringify({value:value.default,callback:callbackValue.default,source:loaded.source,resource:loaded.resource,promisePath,callbackPath,defaultPath,resolvedPath});
    })().then(source=>done(null,source),done)}`,
  });
  const configure=(config,_context,root)=>{
    config.resolve.alias['aliased-value$']=path.join(root,'value.js');
    config.module.rules.push({test:/\.note$/,use:[path.join(root,'api.cjs')]});
  };
  const first=(await f.compile(configure)).default;
  assert.equal(first.value,7);assert.equal(first.callback,7);assert.match(first.source,/42/);assert.ok(first.resource.endsWith(path.sep + 'dependency.js'));
  assert.ok(first.promisePath.endsWith(path.sep + 'choice.custom'));assert.equal(first.promisePath,first.callbackPath);
  assert.ok(first.defaultPath.endsWith(path.sep + 'value.js'));assert.equal(first.defaultPath,first.resolvedPath);
  await writeFile(path.join(f.root,'value.js'),'export default 9');
  assert.equal((await f.compile(configure,'updated')).default.value,9);
});

test('webpack composes loader maps through framework transforms and final minification',async t=>{
  const f=await fixture(t,{
    'entry.js':`export {default} from './input.note'`,
    'input.note':'original input',
    'mapped.cjs':`module.exports=function(){this.callback(null,'\\n\\nexport default function Page(){throw new Error("mapped template failure")}',{version:3,sources:['original.template'],sourcesContent:['\\n'.repeat(7)+'template line'],names:[],mappings:';;AAOA'})}`,
  });
  const configure=(config,_context,root)=>config.module.rules.push({test:/\.note$/,use:[path.join(root,'mapped.cjs')]});
  const options={sourcemap:true,minify:true,plugins:[{name:'prnext-pages-compatibility',setup(builder){
    builder.onLoad({filter:/\.(js|note)$/,namespace:'file'},async args=>({contents:stripServerCode(args.prnextSource ?? await readFile(args.path,'utf8'),args.path),loader:'js'}));
  }}]};
  for(const name of ['mapped','cached']){
    await f.compile(configure,name,options);
    const code=await readFile(path.join(f.stage,name+'.mjs'),'utf8'),map=JSON.parse(await readFile(path.join(f.stage,name+'.mjs.map'),'utf8'));
    const position=code.indexOf('mapped template failure');assert.ok(position>=0);
    const lines=code.slice(0,position).split('\n');const entry=new SourceMap(map).findEntry(lines.length-1,lines.at(-1).length);
    assert.ok(entry.originalSource?.endsWith('original.template'),JSON.stringify({entry,map,code}));assert.equal(entry.originalLine,7);
  }
});

test('inline loader prefixes preserve ordering, query options and independent resource identities',async t=>{
  const files={
    'entry.js':`import ordinary from './value.txt';import full from './inline.cjs!./value.txt';import normalOff from '!./inline.cjs!./value.txt';import preOff from '-!./inline.cjs!./value.txt';import allOff from '!!./inline.cjs!./value.txt';export default {ordinary,full,normalOff,preOff,allOff}`,
    'value.txt':`export default "seed"`,
  };
  for(const [name,letter]of [['pre','P'],['normal','N'],['post','O'],['inline','I']])files[name+'.cjs']=`module.exports=source=>source.replace(/seed[A-Z]*/,value=>value+'${letter}')`;
  const f=await fixture(t,files);
  const actual=(await f.compile((config,_context,root)=>{
    for(const [loader,enforce]of [['pre','pre'],['normal',undefined],['post','post']])config.module.rules.push({test:/\.txt$/,use:[path.join(root,loader+'.cjs')],...(enforce?{enforce}:{})});
  })).default;
  assert.deepEqual(actual,{ordinary:'seedPNO',full:'seedPNIO',normalOff:'seedPIO',preOff:'seedIO',allOff:'seedI'});
});

test('complex DefinePlugin values run in webpack, including objects, typeof and runtime values',async t=>{
  const f=await fixture(t,{'entry.js':`export default {object:SETTINGS,kind:typeof UNKNOWN,computed:COMPUTED,pattern:PATTERN.test('prnext')}`});
  const actual=(await f.compile((config,{webpack})=>config.plugins.push(new webpack.DefinePlugin({
    SETTINGS:{enabled:true,nested:{value:JSON.stringify('nested')}},'typeof UNKNOWN':JSON.stringify('function'),
    COMPUTED:webpack.DefinePlugin.runtimeValue(()=>JSON.stringify('computed'),true),PATTERN:/prnext/,
  })))).default;
  assert.deepEqual(actual,{object:{enabled:true,nested:{value:'nested'}},kind:'function',computed:'computed',pattern:true});
  await assert.rejects(f.compile((config,{webpack})=>{
    config.plugins.push(new webpack.DefinePlugin({process:{env:{NEXT_RUNTIME:JSON.stringify('invalid')}}}));
  },'reserved'),/reserved/);
});

async function incrementalFixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-webpack-session-'));
  t.after(async()=>{await closeIncrementalCompiler(root);await rm(root,{recursive:true,force:true});});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await writeFile(path.join(root,'entry.js'),"import virtual from 'virtual:message';import note from './message.note';export default virtual+':'+note");
  await writeFile(path.join(root,'message.note'),'first');
  await writeFile(path.join(root,'note.cjs'),"module.exports=source=>'export default '+JSON.stringify(source.toString())");
  const compilers=new Set();let starts=0,closed=0;
  const plugin={apply(compiler){compilers.add(compiler);compiler.hooks.beforeCompile.tap('SessionStart',()=>{starts++;});compiler.hooks.shutdown.tap('SessionClose',()=>{closed++;});}};
  let index=0;
  return {root,compilers,counts:()=>({starts,closed}),async compile(marker,{value=1,incremental=true,configure=()=>{},signature='entry'}={}){
    const stage=path.join(root,`.prnext-build-${++index}`);await mkdir(path.join(stage,'.entries'),{recursive:true});
    const entry=path.join(stage,'.entries','entry.js');await writeFile(entry,`export {default} from ${JSON.stringify(path.join(root,'entry.js'))}`);
    let loads=0,disposes=0;
    const result=await withCompilation(async()=>{
      configureCompiler({root,stage,dev:true,incremental,loaded:new Map(),assetBase:'/_prnext/assets',config:{webpack(config,{webpack}){
        config.module.rules.push({test:/\.note$/,use:[path.join(root,'note.cjs')]});
        config.plugins.push(plugin,new webpack.ProvidePlugin({UNUSED:JSON.stringify(value)}));configure(config);return config;
      }}});
      return build({absWorkingDir:root,entryPoints:{[signature]:entry},outdir:path.join(stage,'out'),outExtension:{'.js':'.mjs'},bundle:true,splitting:true,format:'esm',platform:'node',metafile:true,
        plugins:[{name:'prnext-pages-compatibility',setup(builder){
          builder.onResolve({filter:/^virtual:/},()=>({path:'message',namespace:'prnext-session-virtual'}));
          builder.onLoad({filter:/.*/,namespace:'prnext-session-virtual'},()=>{loads++;return {contents:`export default ${JSON.stringify(marker)}`,loader:'js'};});
          builder.onDispose(()=>{disposes++;});
        }}]});
    });
    const file=Object.keys(result.metafile.outputs).find(file=>result.metafile.outputs[file].entryPoint);
    return {value:(await import(pathToFileURL(path.resolve(root,file)).href)).default,stage,result,loads,disposes};
  }};
}

test('webpack sessions reuse actual compiler hooks while rebinding virtual source callbacks and stage outputs',async t=>{
  const f=await incrementalFixture(t),before=webpackCompilerStats();
  const first=await f.compile('one');assert.equal(first.value,'one:first');assert.equal(first.loads,1);assert.equal(first.disposes,1);
  await writeFile(path.join(f.root,'message.note'),'changed');
  const second=await f.compile('two');assert.equal(second.value,'two:changed');assert.equal(second.loads,1);assert.equal(second.disposes,1);
  assert.equal(f.compilers.size,1,'the webpack Compiler instance must survive the rebuild');assert.deepEqual(f.counts(),{starts:2,closed:0});
  assert.equal(webpackCompilerStats().created-before.created,1);assert.equal(webpackCompilerStats().reused-before.reused,1);
  assert.ok(Object.keys(second.result.metafile.outputs).every(file=>!file.includes('.prnext-webpack-')),'metadata must point at the current published stage');
  await writeFile(path.join(f.root,'note.cjs'),"module.exports=source=>'export default '+JSON.stringify('loader:'+source.toString())");
  assert.equal((await f.compile('three')).value,'three:loader:changed','edited loader implementation must replace require() cache state');
  assert.equal((await f.compile('one')).value,'one:loader:changed','exact virtual source reverts must evaluate in the new generation');
  await closeIncrementalCompiler(f.root);assert.equal(f.counts().closed,1);assert.equal(webpackCompilerStats().contexts,0);
  assert.deepEqual((await readdir(f.root)).filter(file=>file.startsWith('.prnext-webpack-')),[],'disposal removes private graph resources');
});

test('webpack sessions invalidate configuration/environment and release graphs in safe mode',async t=>{
  const f=await incrementalFixture(t);
  await f.compile('first');await f.compile('second',{value:2});assert.equal(f.compilers.size,2);assert.equal(f.counts().closed,1);
  const previous=process.env.PRNEXT_WEBPACK_SESSION_TEST;process.env.PRNEXT_WEBPACK_SESSION_TEST='changed';
  try{await f.compile('env');assert.equal(f.compilers.size,3);assert.equal(f.counts().closed,2);}
  finally{if(previous===undefined)delete process.env.PRNEXT_WEBPACK_SESSION_TEST;else process.env.PRNEXT_WEBPACK_SESSION_TEST=previous;}
  await f.compile('safe',{incremental:false});assert.equal(webpackCompilerStats().contexts,0);assert.equal(f.counts().closed,f.compilers.size);
});

test('a failed reused webpack graph is disposed and a repaired source compiles with fresh callbacks',async t=>{
  const f=await incrementalFixture(t);
  await f.compile('before');
  await writeFile(path.join(f.root,'entry.js'),'export default (');
  await assert.rejects(f.compile('broken'),/failed|Unexpected|parse/i);assert.equal(webpackCompilerStats().contexts,0);assert.equal(f.counts().closed,1);
  await writeFile(path.join(f.root,'entry.js'),"import value from 'virtual:message';export default value");
  assert.equal((await f.compile('repaired')).value,'repaired');assert.equal(f.compilers.size,2);
});

test('webpack graph retention is bounded and fresh opaque plugin closures cannot reuse stale hooks',async t=>{
  const f=await incrementalFixture(t),limit=webpackCompilerStats().limit;
  for(let index=0;index<limit+2;index++)await f.compile(String(index),{signature:'entry'+index});
  assert.equal(webpackCompilerStats().contexts,limit);assert.ok(f.counts().closed>=2);
  let observed;
  for(const marker of ['new closure one','new closure two'])await f.compile(marker,{signature:'opaque',configure(config){config.plugins.push({apply(compiler){compiler.hooks.beforeCompile.tap('Opaque',()=>{observed=marker;});}});}});
  assert.equal(observed,'new closure two');
  assert.ok(webpackCompilerStats().contexts<=limit);
  await closeIncrementalCompiler(f.root);assert.equal(f.counts().closed,f.compilers.size);
});

test('real Pages development rebuilds reuse webpack sessions without retaining the previous route source',async t=>{
  const root=await mkdtemp(fileURLToPath(new URL('../../../.prnext-webpack-app-',import.meta.url)));
  t.after(async()=>{await closeIncrementalCompiler(root);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {webpack(config,{webpack}){config.plugins.push(new webpack.IgnorePlugin({resourceRegExp:/^unused-resource$/}));return config}}`);
  const {build:buildProject}=await import('./index.mjs');
  const before=webpackCompilerStats();
  for(const marker of ['first route','changed route']){
    await writeFile(path.join(root,'pages/index.jsx'),`export default function Page(){return <h1>${marker}</h1>}export async function getServerSideProps(){return {props:{}}}`);
    const manifest=await buildProject(root,{dev:true,incremental:true});
    const route=manifest.routes.find(route=>route.pattern==='/');
    const module=await import(pathToFileURL(path.join(manifest.outputDirectory,route.module)).href+'?generation='+manifest.buildId);
    assert.equal(module.default().props.children,marker);
    const client=JSON.parse(await readFile(path.join(manifest.outputDirectory,'assets',path.basename(manifest.devClient)),'utf8'));
    assert.equal(client.buildId,manifest.buildId);
  }
  const after=webpackCompilerStats();assert.ok(after.reused>before.reused,'actual project graphs must enter reusable webpack sessions');
  assert.ok(after.contexts<=after.limit);
});

test('long-lived webpack sessions recycle their compiler and retain only current output assets',async t=>{
  const f=await incrementalFixture(t),buildLimit=webpackCompilerStats().buildLimit;
  let result;
  for(let index=0;index<=buildLimit;index++){
    result=await f.compile('generation '+index);assert.equal(result.value,`generation ${index}:first`);
  }
  assert.equal(f.compilers.size,2,'the compiler asset bookkeeping must have a finite lifetime');assert.equal(f.counts().closed,1);
  const directories=(await readdir(f.root)).filter(name=>name.startsWith('.prnext-webpack-'));assert.equal(directories.length,1);
  const retained=await readdir(path.join(f.root,directories[0],'output'));
  assert.deepEqual(retained.sort(),Object.keys(result.result.metafile.outputs).map(file=>path.basename(file)).sort(),'old runtime and changed chunk assets must not accumulate');
});

test('mutating a Map option on a stable webpack plugin cannot retain its previously captured hook value',async t=>{
  const f=await incrementalFixture(t);let observed;
  const plugin={options:new Map([['label','first']]),apply(compiler){
    const label=this.options.get('label');compiler.hooks.beforeCompile.tap('CapturedMapOption',()=>{observed=label;});
  }};
  const configure=config=>config.plugins.push(plugin);
  await f.compile('first',{configure});assert.equal(observed,'first');
  plugin.options.set('label','second');await f.compile('second',{configure});assert.equal(observed,'second');
  assert.equal(f.compilers.size,2,'changed configuration requires reapplying the plugin');
});

test('webpack configuration fingerprints retain native data types and invalidate their mutable values',async t=>{
  const f=await incrementalFixture(t);
  const arrayBuffer=new ArrayBuffer(4);new Uint8Array(arrayBuffer)[0]=1;
  const view=new DataView(new ArrayBuffer(4));view.setInt32(0,1);
  for(const [name,value,read,mutate]of [
    ['Set',new Set(['first']),value=>[...value].join(','),value=>{value.clear();value.add('second');}],
    ['Date',new Date(1),value=>value.getTime(),value=>value.setTime(2)],
    ['Buffer',Buffer.alloc(2,1),value=>value.toString('hex'),value=>value.fill(2)],
    ['ArrayBuffer',arrayBuffer,value=>new Uint8Array(value)[0],value=>{new Uint8Array(value)[0]=2;}],
    ['TypedArray',new Uint16Array([1,1]),value=>value.join(','),value=>value.fill(2)],
    ['DataView',view,value=>value.getInt32(0),value=>value.setInt32(0,2)],
  ]){
    let observed;
    const plugin={options:value,apply(compiler){const captured=read(this.options);compiler.hooks.beforeCompile.tap(name,()=>{observed=captured;});}};
    const configure=config=>config.plugins.push(plugin),before=f.compilers.size;
    await f.compile(name+' first',{configure});assert.equal(observed,read(value));
    mutate(value);await f.compile(name+' changed',{configure});assert.equal(observed,read(value));assert.equal(f.compilers.size,before+2);
    await f.compile(name+' unchanged',{configure});assert.equal(f.compilers.size,before+2,'unchanged '+name+' options still permit compiler reuse');
  }
});

test('opaque webpack configuration state uses one-shot compilers instead of guessing an identity',async t=>{
  const f=await incrementalFixture(t),key={};let observed;
  const plugin={options:new WeakMap([[key,'first']]),apply(compiler){const captured=this.options.get(key);compiler.hooks.beforeCompile.tap('WeakOption',()=>{observed=captured;});}};
  const configure=config=>config.plugins.push(plugin);
  await f.compile('first',{configure});assert.equal(observed,'first');assert.equal(webpackCompilerStats().contexts,0);
  plugin.options.set(key,'second');await f.compile('second',{configure});assert.equal(observed,'second');assert.equal(f.compilers.size,2);assert.equal(webpackCompilerStats().contexts,0);
});
