import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { validateTurbopack, validateWebpackResolution, moduleResolutionPlugin } from './module-resolution.mjs';

test('aliases resolve subpaths, nested aliases, browser conditions and custom extension order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-alias-'));
  try {
    await mkdir(path.join(root, 'lib'));
    for (const [name, source] of Object.entries({ 'entry.js': "import x from 'library/value';import y from 'conditional';console.log(x,y)", 'lib/value.js': "import value from 'other';export default value", 'alternate.js': "export default 'nested-alias'", 'browser.js': "export default 'browser-alias'", 'alternate.ts': "export default 'typescript-priority'" })) await writeFile(path.join(root, name), source);
    await mkdir(path.join(root, 'node_modules/conditional'), {recursive:true});
    await writeFile(path.join(root, 'node_modules/conditional/index.js'), "export default 'server-original'");
    const config = validateTurbopack({resolveAlias:{library:'./lib',other:'./alternate',conditional:{browser:'./browser.js'}},resolveExtensions:['.ts','.js']});
    for (const platform of ['node','browser']) {
      const result = await build({absWorkingDir:root,entryPoints:['entry.js'],bundle:true,write:false,platform,plugins:[moduleResolutionPlugin(config,root)]});
      const code = result.outputFiles[0].text;
      assert.match(code,/typescript-priority/); assert.doesNotMatch(code,/nested-alias/);
      assert.ok(code.includes(platform==='node'?'server-original':'browser-alias'));
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
test('unsupported compiler hooks and ambiguous alias forms fail explicitly', () => {
  for (const input of [{rules:{'*.svg':{condition:true}}},{root:'relative/root'},{root:42},{resolveAlias:{react:'preact'}},{resolveAlias:{'x*':'./y'}},{resolveAlias:{x:{node:'./x'}}},{resolveExtensions:['../x']},null]) assert.throws(()=>validateTurbopack(input));
  assert.deepEqual(validateTurbopack({}),{resolveAlias:{}});
});

test('Turbopack root anchors relative aliases outside the application folder', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-turbo-root-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const app = path.join(root,'app'); await mkdir(app);
  await writeFile(path.join(root,'shared.js'), "export default 'workspace value'");
  await writeFile(path.join(app,'entry.js'), "import value from 'shared';console.log(value)");
  const config = validateTurbopack({root,resolveAlias:{shared:'./shared.js'}});
  const result = await build({absWorkingDir:app,entryPoints:['entry.js'],bundle:true,write:false,plugins:[moduleResolutionPlugin(config,app)]});
  assert.match(result.outputFiles[0].text, /workspace value/);
});

test('webpack aliases support exact matches, ignored modules and ordered fallbacks',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-webpack-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'node_modules/exact'),{recursive:true});
  for(const [name,source]of Object.entries({
    'entry.js':`import one from 'exact';import two from 'exact/subpath';import three from 'fallback';import ignored from 'disabled';export default [one,two,three,Object.keys(ignored).length]`,
    'node_modules/exact/subpath.js':`export default 'subpath'`,
    'replacement.js':`export default 'replacement'`,
  }))await writeFile(path.join(root,name),source);
  const config=validateWebpackResolution({alias:{'exact$':'./replacement.js',fallback:['./absent.js','./replacement.js'],disabled:false}});
  const result=await build({absWorkingDir:root,entryPoints:['entry.js'],bundle:true,write:false,platform:'node',format:'esm',plugins:[moduleResolutionPlugin(config,root)]});
  const value=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  assert.deepEqual(value.default,['replacement','subpath','replacement',0]);
  await mkdir(path.join(root,'nested'));
  await writeFile(path.join(root,'nested/entry.js'),`import value from 'exact';export default value`);
  await writeFile(path.join(root,'nested/replacement.js'),`export default 'relative to importer'`);
  const nested=await build({absWorkingDir:root,entryPoints:['nested/entry.js'],bundle:true,write:false,platform:'node',format:'esm',plugins:[moduleResolutionPlugin(config,root)]});
  assert.match(nested.outputFiles[0].text,/relative to importer/);
  for(const alias of [{'react$':false},{'next/link$':'x'},{x:[]},{x:[3]}])assert.throws(()=>validateWebpackResolution({alias}));
});
