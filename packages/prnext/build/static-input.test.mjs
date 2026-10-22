import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStatic } from './static-adapter.mjs';
import { detectBuildAdapter } from './static-input.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-plain-html-'));
  t.after(() => rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const put = async (file, text) => {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text)};
  return {root,put};
}
test('plain HTML root builds publish browser files and exclude project/server material across rebuilds', async t => {
  const {root,put} = await fixture(t);
  for (const [file,text] of Object.entries({'index.html':'<link rel="stylesheet" href="/style.css"><h1>Plain HTML</h1>','style.css':'h1{color:red}','assets/app.js':'window.ready=true','about.html':'About','.env':'SECRET','package.json':'{}','credentials.json':'SECRET','server.js':'SECRET','src/secret.js':'SECRET','handler.php':'SECRET','node_modules/pkg/index.js':'SECRET','.well-known/security.txt':'Contact: mailto:security@example.test'})) await put(file,text);
  assert.deepEqual(await detectBuildAdapter(root),{adapter:'static',from:'.'});
  const first = await buildStatic(root,{from:'.'}),second = await buildStatic(root,{from:'.',spa:true});
  assert.notEqual(first.buildId,second.buildId);
  const paths = second.prerendered.map(p=>p.path);
  for (const url of ['/', '/style.css', '/assets/app.js', '/about', '/.well-known/security.txt']) assert.ok(paths.includes(url),url);
  for (const url of ['/.env','/package.json','/credentials.json','/server.js','/src/secret.js','/handler.php','/node_modules/pkg/index.js']) assert.ok(!paths.includes(url),url);
  assert.equal(await readFile(path.join(root,'server.js'),'utf8'),'SECRET');
  assert.equal(second.files,5);
  await put('package.json',JSON.stringify({devDependencies:{'@thomas.f/prnext':'0.1.16-alpha'},scripts:{build:'prnext build'}}));
  assert.deepEqual(await detectBuildAdapter(root),{adapter:'static',from:'.'});
});
test('automatic adapter never serves unbuilt Vite input or evaluates framework config',async t=>{
  const {root,put}=await fixture(t);
  await put('index.html','<script type="module" src="/src/main.tsx"></script>');
  await put('package.json',JSON.stringify({devDependencies:{vite:'8'},scripts:{build:'vite build'}}));
  await put('vite.config.mjs','throw Error("must not evaluate");');
  assert.equal((await detectBuildAdapter(root)).adapter,'react');
  await assert.rejects(detectBuildAdapter(root,{prepared:true}),/Run your framework build/);
  await put('dist/index.html','built');
  assert.deepEqual(await detectBuildAdapter(root,{prepared:true}),{adapter:'static',from:'dist'});
  await put('build/index.html','also built');
  await assert.rejects(detectBuildAdapter(root,{prepared:true}),/Multiple static outputs/);
});
test('completed static output shapes from different builders import with their public assets',async t=>{
  for(const [from,asset]of [['dist','_astro/site.css'],['build','_app/immutable/start.js'],['.output/public','_nuxt/app.js'],['out','assets/index.js']]){
    const {root,put}=await fixture(t);await put(from+'/index.html','<h1>Generated</h1>');await put(from+'/'+asset,'asset');
    assert.deepEqual(await detectBuildAdapter(root,{prepared:true}),{adapter:'static',from});
    const built=await buildStatic(root,{from});assert.ok(built.prerendered.some(p=>p.path==='/'+asset));
  }
  const {root,put}=await fixture(t);await put('src/pages/index.astro','<h1>Source</h1>');await put('package.json',JSON.stringify({devDependencies:{astro:'6'}}));await put('dist/index.html','built');
  assert.deepEqual(await detectBuildAdapter(root,{prepared:true}),{adapter:'static',from:'dist'});
});
