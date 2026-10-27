import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';
import {build as nativeBuild} from 'esbuild';
import {withCompilationGraphCacheReporting,cachedGraphBuild,compilationGraphCacheReport} from './compilation-cache.mjs';
const exec = promisify(execFile);
const cacheUrl = new URL('./compilation-cache.mjs', import.meta.url).href;
const cssUrl = new URL('./css-modules.mjs', import.meta.url).href;
const esbuildUrl = new URL('../../../node_modules/esbuild/lib/main.js', import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-compilation-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}');
  return root;
}
async function invoke(root, mode = 'js', { env = {}, settings = {}, dev = false, stage = '.prnext-build-current', plugin = false } = {}) {
  const code = `import {mkdir,readFile,readdir} from 'node:fs/promises';import path from 'node:path';
    import {build} from ${JSON.stringify(esbuildUrl)};
    import {withCompilationGraphCacheReporting,cachedGraphBuild,compilationGraphCacheReport} from ${JSON.stringify(cacheUrl)};
    import {createCssModules} from ${JSON.stringify(cssUrl)};
    const root=${JSON.stringify(root)}, stage=path.join(root,${JSON.stringify(stage)});await mkdir(stage,{recursive:true});
    await withCompilationGraphCacheReporting(async()=>{let calls=0,value;
      if(${JSON.stringify(mode)}==='css'){
        value=await createCssModules({projectRoot:root,stage,dev:${dev},...${JSON.stringify(settings)}}).compile(path.join(root,'Card.module.css'));
        if(Object.hasOwn(value,'assets'))throw Error('CSS mapping results must not retain replay-only asset buffers');
        value={...value,assets:await Promise.all((await readdir(path.join(stage,'assets'))).sort().map(async name=>({name,data:(await readFile(path.join(stage,'assets',name))).toString('base64')})))};
      }else{
        const options={absWorkingDir:root,entryPoints:[path.join(root,'entry.js')],outdir:path.join(stage,'assets'),bundle:true,write:false,metafile:true,format:'esm',platform:'browser',logLevel:'silent',...${JSON.stringify(settings)},...(${plugin}?{plugins:[{name:'test-effect',setup(builder){builder.onStart(()=>{})}}]}:{})};
        const result=await cachedGraphBuild(options,{root,stage,dev:${dev}},async options=>{calls++;return build(options)});
        value={files:result.outputFiles.map(file=>[path.basename(file.path),Buffer.from(file.contents).toString('base64')]),metafile:result.metafile};
      }
      console.log(JSON.stringify({calls,value,report:compilationGraphCacheReport()}));});`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: { ...process.env, PRNEXT_BUILD_CACHE: '1', ...env }, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
test('native JavaScript graphs persist across fresh processes and new output stages byte for byte', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'entry.js'), "import {answer} from './dependency.js';console.log(answer)");
  await writeFile(path.join(root, 'dependency.js'), 'export const answer=42');
  const first = await invoke(root, 'js', { stage: '.prnext-build-first' });
  const warm = await invoke(root, 'js', { stage: '.prnext-build-second' });
  assert.equal(first.calls, 1); assert.equal(first.report.kinds[0].writes, 1, JSON.stringify(first.report));
  assert.equal(warm.calls, 0, JSON.stringify(warm.report)); assert.equal(warm.report.hits, 1);
  assert.deepEqual(warm.value.files, first.value.files);
  assert.ok(warm.report.reusedBytes > 0);
  assert.ok(Object.keys(warm.value.metafile.outputs).every(file => !file.includes('.prnext-build-first')));
});
test('dependency changes, environment, options, lockfiles and a new higher priority resolution candidate invalidate graphs', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'entry.js'), "import answer from './answer';console.log(answer)");
  await writeFile(path.join(root, 'answer.js'), 'export default 1');
  assert.equal((await invoke(root)).calls, 1); assert.equal((await invoke(root)).calls, 0);
  await writeFile(path.join(root, 'answer.js'), 'export default 2');
  const changed = await invoke(root); assert.equal(changed.calls, 1); assert.match(Buffer.from(changed.value.files[0][1], 'base64').toString(), /default = 2/);
  assert.equal((await invoke(root)).calls, 0);
  await writeFile(path.join(root, 'answer.ts'), 'export default 3');
  const priority = await invoke(root); assert.equal(priority.calls, 1); assert.match(Buffer.from(priority.value.files[0][1], 'base64').toString(), /default = 3/);
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}'); assert.equal((await invoke(root)).calls, 1);
  assert.equal((await invoke(root, 'js', { env: { PRNEXT_GRAPH_FIXTURE: 'changed' } })).calls, 1);
  assert.equal((await invoke(root, 'js', { settings: { minify: true } })).calls, 1);
});
test('package changes and previously missing optional dependencies cannot leave stale compiled output', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'node_modules', 'present'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'optional'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/present/package.json'), '{"main":"main.js"}');
  await writeFile(path.join(root, 'node_modules/present/main.js'), 'module.exports=10');
  await writeFile(path.join(root, 'node_modules/optional/package.json'), '{"main":"missing.js"}');
  await writeFile(path.join(root, 'entry.js'), "import value from 'present';console.log(value);try{console.log(require('optional'))}catch{}");
  assert.equal((await invoke(root)).calls, 1); assert.equal((await invoke(root)).calls, 0);
  await writeFile(path.join(root, 'node_modules/present/main.js'), 'module.exports=20'); assert.equal((await invoke(root)).calls, 1);
  assert.equal((await invoke(root)).calls, 0);
  await writeFile(path.join(root, 'node_modules/optional/missing.js'), 'module.exports="now available"');
  const added = await invoke(root); assert.equal(added.calls, 1); assert.match(Buffer.from(added.value.files[0][1], 'base64').toString(), /now available/);
});
test('CSS module graphs restore class maps, composed styles and emitted assets into a fresh stage', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'shared.module.css'), '.base { font-weight: bold }');
  await writeFile(path.join(root, 'Card.module.css'), '.card { composes: base from "./shared.module.css";color:red;background:url("./image.svg") }:export { brand: coral }');
  await writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const first = await invoke(root, 'css', { stage: '.prnext-build-first' });
  const warm = await invoke(root, 'css', { stage: '.prnext-build-second' });
  assert.equal(first.report.kinds[0].writes, 1, JSON.stringify(first.report));
  assert.equal(warm.report.hits, 1, JSON.stringify(warm.report));
  assert.deepEqual(warm.value, first.value); assert.equal(warm.value.assets.length, 1);
  assert.equal(Buffer.from(warm.value.assets[0].data,'base64').toString(),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(JSON.parse(warm.value.mapping).brand, 'coral'); assert.equal(JSON.parse(warm.value.mapping).card.split(' ').length, 2);
  await writeFile(path.join(root, 'shared.module.css'), '.base { font-weight: 400 }');
  const changed = await invoke(root, 'css'); assert.equal(changed.report.hits, 0); assert.notEqual(changed.value.css, first.value.css);
  assert.equal((await invoke(root, 'css')).report.hits, 1);
  await writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="9"/>');
  const asset = await invoke(root, 'css'); assert.equal(asset.report.hits, 0); assert.notDeepEqual(asset.value.assets, warm.value.assets);
});
test('custom plugins, custom style pipelines, dev and the explicit opt-out run the real compiler', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'entry.js'), 'console.log("original")');
  await writeFile(path.join(root, 'Card.module.css'), '.card {color:red}');
  for (const options of [{ dev: true }, { plugin: true }, { env: { PRNEXT_BUILD_CACHE: '0' } }]) {
    const output = await invoke(root, 'js', options); assert.equal(output.calls, 1); assert.equal(output.report.hits, 0); assert.equal(output.report.bypasses, 1);
  }
  await writeFile(path.join(root, 'postcss.config.json'), '{"plugins":{}}');
  const custom = await invoke(root, 'css'); assert.equal(custom.report.hits, 0); assert.equal(custom.report.bypasses, 1);
  await rm(path.join(root, 'postcss.config.json'));
  const dev = await invoke(root, 'css', { dev: true }); assert.equal(dev.report.bypasses, 1);
  const postcss=await invoke(root,'css',{settings:{cssEngine:'postcss'}});assert.equal(postcss.report.hits,0);assert.equal(postcss.report.bypasses,1);
});
test('corrupt records and unavailable cache directories are optional misses', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'entry.js'), 'console.log(42)');
  await invoke(root);
  const directory = path.join(root, '.prnext-cache/compilation-graphs-v1');
  const cacheFile = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
  const data = JSON.parse(await readFile(cacheFile, 'utf8')); data.payload = data.payload.replace('console', 'poison'); await writeFile(cacheFile, JSON.stringify(data));
  // The payload is base64; deliberately break its checksum even if no word matched.
  data.checksum = '0'.repeat(64); await writeFile(cacheFile, JSON.stringify(data));
  assert.equal((await invoke(root)).calls, 1); assert.equal((await invoke(root)).calls, 0);
  await rm(path.join(root, '.prnext-cache'), { recursive: true }); await writeFile(path.join(root, '.prnext-cache'), 'unavailable');
  assert.equal((await invoke(root)).calls, 1);
});
test('failed graphs never publish cache entries and simultaneous readers produce identical outputs', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'entry.js'), 'import "./missing.js"');
  await assert.rejects(invoke(root), /Could not resolve/);
  const directory = path.join(root, '.prnext-cache/compilation-graphs-v1');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.json')), []);
  await writeFile(path.join(root, 'missing.js'), 'console.log(123)');
  const outputs = await Promise.all([invoke(root, 'js', { stage: '.prnext-build-a' }), invoke(root, 'js', { stage: '.prnext-build-b' })]);
  assert.deepEqual(outputs[0].value.files, outputs[1].value.files);
  assert.equal((await invoke(root)).calls, 0);
});
test('configuration files with untracked tsconfig extends cannot be reused as native graph cache hits', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'entry.js'), 'console.log(42)');
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  const first = await invoke(root), second = await invoke(root);
  assert.equal(first.calls, 1); assert.equal(second.calls, 1); assert.equal(second.report.hits, 0);
  assert.equal(first.report.kinds[0].reasons['untracked-tsconfig'], 1);
});

test('browser target files invalidate styles and arbitrary extended target modules bypass graph persistence',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'Card.module.css'),'.card{appearance:none}');
  await writeFile(path.join(root,'.browserslistrc'),'last 1 Chrome version');
  assert.equal((await invoke(root,'css')).report.hits,0);assert.equal((await invoke(root,'css')).report.hits,1);
  await writeFile(path.join(root,'.browserslistrc'),'last 1 Firefox version');
  assert.equal((await invoke(root,'css')).report.hits,0);
  await mkdir(path.join(root,'node_modules/browserslist-config-fixture'),{recursive:true});
  await writeFile(path.join(root,'node_modules/browserslist-config-fixture/package.json'),'{"main":"index.cjs"}');
  await writeFile(path.join(root,'node_modules/browserslist-config-fixture/index.cjs'),"module.exports=['last 1 Chrome version']");
  for(const directive of ['extends','ExTeNdS']){
    await writeFile(path.join(root,'.browserslistrc'),directive+' browserslist-config-fixture');
    const first=await invoke(root,'css'),second=await invoke(root,'css');
    assert.equal(first.report.hits,0);assert.equal(second.report.hits,0);assert.equal(second.report.kinds[0].reasons['custom-browser-targets'],1);
  }
});

test('custom browser usage statistics never reuse stale prefixed CSS or unnecessarily bypass native JavaScript graphs',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'Card.module.css'),'.card{user-select:none;appearance:none;display:flex}');
  await writeFile(path.join(root,'.browserslistrc'),'> 1% in my stats');
  const stats=path.join(root,'browserslist-stats.json');await writeFile(stats,JSON.stringify({chrome:{35:100}}));
  const first=await invoke(root,'css');assert.equal(first.report.hits,0);assert.equal(first.report.kinds[0].reasons['custom-browser-targets'],1);
  await writeFile(stats,JSON.stringify({chrome:{140:100}}));
  const edited=await invoke(root,'css'),fresh=await invoke(root,'css',{env:{PRNEXT_BUILD_CACHE:'0'}});
  assert.equal(edited.report.hits,0);assert.equal(edited.report.kinds[0].reasons['custom-browser-targets'],1);
  assert.deepEqual(edited.value,fresh.value);assert.notEqual(edited.value.css,first.value.css);
  const env=await invoke(root,'css',{env:{BROWSERSLIST:'> 1% in my stats',BROWSERSLIST_STATS:stats}});
  assert.equal(env.report.hits,0);assert.equal(env.report.bypasses,1);
  await writeFile(path.join(root,'entry.js'),'console.log(42)');
  assert.equal((await invoke(root)).calls,1);assert.equal((await invoke(root)).calls,0);
  await writeFile(stats,JSON.stringify({chrome:{35:100}}));
  assert.equal((await invoke(root)).calls,0,'native JavaScript has no Browserslist statistics dependency');
});

test('metadata shared within a build detects new resolution candidates, changed locks and changed environments',async t=>{
  const root=await fixture(t),stage=path.join(root,'.prnext-build-shared');await mkdir(stage);
  await writeFile(path.join(root,'entry.js'),"import value from './answer';console.log(value)");await writeFile(path.join(root,'answer.js'),'export default 1');
  const options={absWorkingDir:root,entryPoints:[path.join(root,'entry.js')],outdir:path.join(stage,'assets'),bundle:true,write:false,metafile:true,format:'esm',platform:'browser',logLevel:'silent'};
  await withCompilationGraphCacheReporting(async()=>{
    const run=async()=>{let calls=0;const result=await cachedGraphBuild(options,{root,stage},async options=>{calls++;return nativeBuild(options)});return {calls,text:result.outputFiles[0].text};};
    assert.equal((await run()).calls,1);assert.equal((await run()).calls,0);
    await writeFile(path.join(root,'answer.ts'),'export default 2');const changed=await run();assert.equal(changed.calls,1);assert.match(changed.text,/default = 2/);
    await writeFile(path.join(root,'package-lock.json'),'{}');assert.equal((await run()).calls,1);
    await writeFile(path.join(root,'package-lock.json'),'{"lockfileVersion":3}');assert.equal((await run()).calls,1);
    const before=process.env.PRNEXT_GRAPH_SCOPE;process.env.PRNEXT_GRAPH_SCOPE='different';
    try{assert.equal((await run()).calls,1);}finally{if(before===undefined)delete process.env.PRNEXT_GRAPH_SCOPE;else process.env.PRNEXT_GRAPH_SCOPE=before;}
    assert.ok(compilationGraphCacheReport().hits>=1);
  });
});

test('more than 64 small graphs remain reusable instead of thrashing the shared record eviction limit',async t=>{
  const root=await fixture(t),stage=path.join(root,'.prnext-build-many');await mkdir(stage);
  await writeFile(path.join(root,'entry.js'),'console.log(GRAPH_NUMBER)');
  await withCompilationGraphCacheReporting(async()=>{
    const run=async index=>cachedGraphBuild({absWorkingDir:root,entryPoints:[path.join(root,'entry.js')],outdir:path.join(stage,'assets'),bundle:true,write:false,metafile:true,format:'esm',platform:'browser',logLevel:'silent',define:{GRAPH_NUMBER:String(index)}},{root,stage},nativeBuild);
    for(let i=0;i<70;i++)await run(i);
    assert.equal(compilationGraphCacheReport().hits,0);
    for(let i=0;i<70;i++){const result=await run(i);assert.match(result.outputFiles[0].text,new RegExp('console\\.log\\('+i+'\\)'));}
    assert.equal(compilationGraphCacheReport().hits,70);
    assert.equal((await readdir(path.join(root,'.prnext-cache/compilation-graphs-v1'))).filter(name=>name.endsWith('.json')).length,70);
  });
});

test('explicit inputs and dependencies under another generated stage bypass persistence',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.prnext-build-old'));
  await writeFile(path.join(root,'.prnext-build-old/answer.js'),'export default 1');
  await writeFile(path.join(root,'entry.js'),"import value from './.prnext-build-old/answer';console.log(value)");
  const first=await invoke(root),second=await invoke(root);
  assert.equal(first.calls,1);assert.equal(second.calls,1);assert.equal(second.report.kinds[0].reasons['generated-input'],1);
  await writeFile(path.join(root,'.prnext-build-old/answer.ts'),'export default 2');
  const changed=await invoke(root);assert.equal(changed.calls,1);assert.match(Buffer.from(changed.value.files[0][1],'base64').toString(),/default = 2/);
  const entry=await invoke(root,'js',{settings:{entryPoints:[path.join(root,'.prnext-build-old/answer.js')]}});
  assert.equal(entry.report.hits,0);assert.equal(entry.report.kinds[0].reasons['generated-input'],1);
});

test('actual App builds reuse compiled CSS in fresh processes, preserving action renewal and custom distDir', async t => {
  const root = await mkdtemp(fileURLToPath(new URL('../../../.prnext-compiled-graph-app-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root,'app'));
  await writeFile(path.join(root,'package.json'),'{"type":"module","private":true}');
  await writeFile(path.join(root,'prnext.config.mjs'),"export default {distDir:'compiled-output',reactCompiler:true}");
  await writeFile(path.join(root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(root,'app/actions.js'),"'use server';export async function save(){return 'saved'}");
  await writeFile(path.join(root,'app/Card.module.css'),'.card {color:rgb(255,0,0);background:url("./image.svg")}');
  await writeFile(path.join(root,'app/image.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root,'app/page.jsx'),"import styles from './Card.module.css';import {save} from './actions.js';export default function Page(){return <form action={save}><button className={styles.card}>Save safely</button></form>}");
  const buildUrl = new URL('./index.mjs',import.meta.url).href;
  const call = async (enabled=true) => {
    const code = `import {build} from ${JSON.stringify(buildUrl)};import {readFile,readdir} from 'node:fs/promises';import path from 'node:path';const b=await build(${JSON.stringify(root)});const files=await readdir(path.join(b.outputDirectory,'assets'));const css=await Promise.all(files.filter(f=>f.endsWith('.css')).sort().map(async f=>[f,await readFile(path.join(b.outputDirectory,'assets',f),'utf8')]));console.log(JSON.stringify({durationMs:b.durationMs,report:b.compilationCache,css,key:b.app.actionKey,ids:Object.keys(b.app.actions)}));`;
    const env={...process.env,PRNEXT_BUILD_CACHE:enabled?'1':'0'};delete env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
    return JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{env,windowsHide:true,maxBuffer:2*1024*1024})).stdout.trim().split('\n').at(-1));
  };
  const cold = await call(), warm = await call();
  const css = report => report.kinds.find(kind=>kind.kind==='css-modules');
  assert.equal(css(cold.report).writes,1,JSON.stringify(cold.report));
  assert.equal(css(warm.report).hits,1,JSON.stringify(warm.report));
  assert.equal(warm.report.kinds.find(kind=>kind.kind==='javascript').hits,1,'the native env/vendor graph must be reused independently from CSS/source-transform caches');
  assert.deepEqual(warm.css,cold.css,'actual route styles and hashed asset URLs must remain byte-identical');
  assert.notEqual(warm.key,cold.key);assert.notDeepEqual(warm.ids,cold.ids);
  await writeFile(path.join(root,'app/Card.module.css'),'.card {color:rgb(0,0,255);background:url("./image.svg")}');
  const changed=await call();assert.equal(css(changed.report).hits,0);assert.notDeepEqual(changed.css,cold.css);
  const warmChanged=await call();assert.equal(css(warmChanged.report).hits,1);
  const readCache=async()=>{
    const values=[];
    const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else values.push([path.relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex')]);}};
    await walk(path.join(root,'.prnext-cache'));return values.sort((a,b)=>a[0].localeCompare(b[0]));
  };
  const cacheBefore=await readCache(),disabled=await call(false);
  assert.equal(disabled.report.hits,0);assert.equal(disabled.report.reusedBytes,0);assert.equal(disabled.report.misses,0);
  assert.deepEqual(await readCache(),cacheBefore,'global cache opt-out must not create or rewrite reusable cache records');
  const receipt={version:1,platform:process.platform,architecture:process.arch,node:process.version,freshProcesses:5,
    fixture:{router:'app',reactCompiler:true,serverActions:true,cssModules:true,asset:'svg',distDir:'compiled-output'},
    timings:{coldMs:cold.durationMs,warmMs:warm.durationMs,changedMs:changed.durationMs,warmChangedMs:warmChanged.durationMs},
    reports:{cold:cold.report,warm:warm.report,changed:changed.report,warmChanged:warmChanged.report,disabled:disabled.report},
    verified:{stylesByteIdentical:JSON.stringify(cold.css)===JSON.stringify(warm.css),actionKeysRenewed:cold.key!==warm.key,actionIdsRenewed:JSON.stringify(cold.ids)!==JSON.stringify(warm.ids),editInvalidated:css(changed.report).hits===0,globalOptOutLeavesCacheUnchanged:JSON.stringify(await readCache())===JSON.stringify(cacheBefore)},
    styles:cold.css.map(([file,source])=>({file,bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')})),
    limitation:'Timings are whole builds, including existing transform/runtime/compression caches; they do not isolate the new graph cache or predict other applications.'};
  if(process.env.PRNEXT_COMPILATION_CACHE_RECEIPT){await mkdir(path.dirname(process.env.PRNEXT_COMPILATION_CACHE_RECEIPT),{recursive:true});await writeFile(process.env.PRNEXT_COMPILATION_CACHE_RECEIPT,JSON.stringify(receipt,null,2)+'\n');}
  t.diagnostic(JSON.stringify(receipt.timings));
});
