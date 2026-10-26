import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRefreshTransform, devClientFile } from './dev.mjs';
import { build } from './index.mjs';
import { validateProjectConfig } from './config.mjs';

test('reactStrictMode accepts only explicit boolean configuration', () => {
  assert.equal(validateProjectConfig({ reactStrictMode: true }).reactStrictMode, true);
  assert.equal(validateProjectConfig({ reactStrictMode: false }).reactStrictMode, false);
  assert.equal(validateProjectConfig({}).reactStrictMode, undefined);
  assert.throws(() => validateProjectConfig({ reactStrictMode: 'true' }), /reactStrictMode must be a boolean/);
});

test('development transform records official React hook signatures and unsafe mixed exports', async () => {
  const refresh = createRefreshTransform('/fixture');
  const code = `import{useState}from'react';export default function Counter(){const[count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{count}</button>}`;
  const transformed = await refresh(code, '/fixture/Counter.jsx');
  assert.match(transformed, /__prnextRefreshSig\(\)/);
  assert.match(transformed, /__prnextRefreshReg\([^;]+"Counter"/);
  assert.match(transformed, /__prnextRegisterModule\("Counter.jsx","[a-f0-9]+",true\)/);
  assert.match(await refresh(code + '\nexport const answer=42;', '/fixture/Counter.jsx'), /__prnextRegisterModule\("Counter.jsx","[a-f0-9]+",false\)/);
  assert.equal(await refresh(code, '/fixture/node_modules/widget/index.js'), code);
});

test('anonymous default JSX components register stable names without changing other exports', async () => {
  const refresh=createRefreshTransform('/fixture');
  const anonymous=await refresh("import{useState}from'react';const PRNextDefaultComponent=1;export default()=>{const[n]=useState(0);return <p>{n}</p>}",'/fixture/Anonymous.jsx');
  assert.match(anonymous,/__prnextRefreshReg\([^;]+"PRNextDefaultComponent1"/);
  assert.match(anonymous,/__prnextRefreshSig\(\)/);
  assert.match(anonymous,/__prnextRegisterModule\("Anonymous.jsx","[a-f0-9]+",true\)/);
  const ordinary=await refresh('export default()=>42','/fixture/value.js');
  assert.doesNotMatch(ordinary,/const PRNextDefaultComponent/);
  assert.match(ordinary,/__prnextRegisterModule\("value.js","[a-f0-9]+",false\)/);
});

test('Fast Refresh preserves CommonJS exports, requires and change registration', async () => {
  const refresh = createRefreshTransform('/fixture');
  for (const [source, expected] of [
    ["module.exports = {title: require('./title.cjs')};", {title:'CommonJS title'}],
    ["exports.title = require('./title.cjs');", {title:'CommonJS title'}],
    ["'use strict';module.exports={strict:(function(){return this})()===undefined};", {strict:true}],
  ]) {
    const transformed = await refresh(source, '/fixture/data/siteMetadata.js');
    const module = {exports:{}}, registrations=[];
    runInNewContext(transformed, {module, exports:module.exports, require(specifier) {
      if (specifier === './title.cjs') return 'CommonJS title';
      assert.equal(specifier,devClientFile);
      return {register(){}, signature(){}, registerModule(...args){registrations.push(args)}};
    }});
    assert.deepEqual(JSON.parse(JSON.stringify(module.exports)), expected);
    assert.equal(registrations.length,1);
    assert.equal(registrations[0][0],'data/siteMetadata.js');
    assert.equal(registrations[0][2],false,'data module edits require a safe document reload');
  }
});

test('refresh generations reevaluate exact reverted source while JSX exposes only relative element locations', async()=>{
 const source='export default function Counter(){return <main><button>Ready</button><CounterChild/></main>}';
 const first=await createRefreshTransform('/fixture',{generation:'one'})(source,'/fixture/components/Counter.jsx');
 assert.equal(await createRefreshTransform('/fixture',{generation:'unchanged'})(source,'/fixture/components/Counter.jsx'),first,'unchanged sources keep their compiler parse cache');
 await createRefreshTransform('/fixture',{generation:'two'})(source.replace('Ready','Changed'),'/fixture/components/Counter.jsx');
 const second=await createRefreshTransform('/fixture',{generation:'three'})(source,'/fixture/components/Counter.jsx');
 assert.notEqual(first,second);assert.match(first,/evaluatedGeneration="one"/);assert.match(second,/evaluatedGeneration="three"/);
 assert.match(second,/data-prnext-source="components\/Counter.jsx:1:/);assert.doesNotMatch(second,/<CounterChild data-prnext-source/);
 const registration=code=>code.match(/__prnextRegisterModule\("components\/Counter.jsx","([a-f0-9]+)",true\)/)?.[1];assert.equal(registration(first),registration(second));
});

test('Fast Refresh also instruments files resolved through a symlinked project root', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../../../.prnext-refresh-path-test-', import.meta.url)));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const actual=path.join(directory,'actual'), linked=path.join(directory,'linked');
  await mkdir(actual);await symlink(actual,linked,'dir');
  const source='export default function Counter(){return null}';
  const refresh=createRefreshTransform(linked);
  const transformed=await refresh(source,path.join(await realpath(actual),'Counter.jsx'));
  assert.match(transformed,/__prnextRegisterModule\("Counter.jsx","[a-f0-9]+",true\)/);
  assert.equal(await refresh(source,path.join(directory,'elsewhere/Counter.jsx')),source);
});

test('development builds publish refresh entries while production excludes browser refresh code', async t => {
  const root = await mkdtemp(fileURLToPath(new URL('../../../.prnext-dev-build-test-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pages'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'pages/index.jsx'), `import{useState}from'react';export default function Page(){const[count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{count}</button>}`);
  const development = await build(root, { dev: true });
  const metadata = JSON.parse(await readFile(path.join(development.outputDirectory, 'assets', path.basename(development.devClient)), 'utf8'));
  assert.equal(metadata.buildId, development.buildId);
  assert.ok(metadata.pages.some(route => route.pattern === '/' && route.client));
  const readJavaScript = async result => {
    const assets = path.join(result.outputDirectory, 'assets');
    return (await Promise.all((await readdir(assets)).filter(file => file.endsWith('.js')).map(file => readFile(path.join(assets, file), 'utf8')))).join('\n');
  };
  assert.match(await readJavaScript(development), /performReactRefresh/);
  const production = await build(root);
  assert.equal(production.devClient, undefined);
  assert.doesNotMatch(await readJavaScript(production), /performReactRefresh|__PRNEXT_DEV_MODULES__|__prnext_dev_error__|new EventSource|data-prnext-source|evaluatedGeneration/);
});
