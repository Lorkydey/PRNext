import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createDevChangeFilter,createDevInputSnapshot} from './dev-file-changes.mjs';
import {shouldWatchProjectFile} from './env.mjs';

test('dev watcher skips identical generated files but sees edits, deletion and recreation', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-digests-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filter=createDevChangeFilter(root), file=path.join(root,'index.json');
  await writeFile(file,'first');assert.deepEqual(await filter(['index.json']),['index.json']);
  await writeFile(file,'first');assert.deepEqual(await filter(['index.json']),[]);
  await writeFile(file,'other');await utimes(file,new Date(0),new Date(0));
  assert.deepEqual(await filter(['index.json']),['index.json']);
  await rm(file);assert.deepEqual(await filter(['index.json']),['index.json']);
  assert.deepEqual(await filter(['index.json']),[]);
  await writeFile(file,'other');assert.deepEqual(await filter(['index.json']),['index.json']);
});

test('directory notifications track entries without treating child rewrites as structural changes', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-dirs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filter=createDevChangeFilter(root);await mkdir(path.join(root,'generated'));
  await writeFile(path.join(root,'generated/a.js'),'one');
  assert.deepEqual(await filter(['generated']),['generated']);
  await writeFile(path.join(root,'generated/a.js'),'two');assert.deepEqual(await filter(['generated']),[]);
  await writeFile(path.join(root,'generated/b.js'),'three');assert.deepEqual(await filter(['generated']),['generated']);
});

test('dev change fingerprints stay bounded and evicted inputs are conservatively rebuilt', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-bounds-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const file of ['a','b','c'])await writeFile(path.join(root,file),'content');
  const filter=createDevChangeFilter(root,{maxEntries:2});
  assert.deepEqual(await filter(['a','b','c']),['a','b','c']);
  assert.deepEqual(await filter(['b','c']),[]);
  assert.deepEqual(await filter(['a']),['a']);
  const tiny=createDevChangeFilter(root,{maxBytes:1});
  assert.deepEqual(await tiny(['a']),['a']);assert.deepEqual(await tiny(['a']),['a']);
});

test('Contentlayer generated modules are watched while internal cache output is excluded', () => {
  assert.equal(shouldWatchProjectFile('.contentlayer/generated'),true);
  assert.equal(shouldWatchProjectFile('.contentlayer/generated/Blog/one.mdx.json'),true);
  assert.equal(shouldWatchProjectFile('.contentlayer/cache/config.js'),false);
  assert.equal(shouldWatchProjectFile('.contentlayer/generated/.temporary'),false);
  assert.equal(shouldWatchProjectFile('node_modules/.contentlayer/generated/index.js'),false);
});

test('compiled input digests acknowledge generators without losing edits during compilation', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filter=createDevChangeFilter(root), file=path.join(root,'generated.json');
  await writeFile(file,'generated');
  const inputs=createDevInputSnapshot([root]);
  inputs.record(file,Buffer.from('generated'));
  inputs.record(path.join(root,'node_modules/vendor.js'),'ignored');
  inputs.record(path.join(root,'.prnext-build-test/chunk.js'),'ignored');
  inputs.record(path.join(root,'../outside.js'),'ignored');
  filter.acceptInputs(inputs.entries());
  assert.deepEqual(await filter(['generated.json']),[]);
  await writeFile(file,'edited after compiler read');
  assert.deepEqual(await filter(['generated.json']),['generated.json']);
  inputs.record(file,Buffer.from('edited after compiler read'));
  await writeFile(file,'generated');
  filter.acceptInputs(inputs.entries());
  assert.deepEqual(await filter(['generated.json']),['generated.json'],'inconsistent target reads force a rebuild even after a revert');
  assert.equal(inputs.entries().length,1);
});

test('compiled input snapshots stop retaining new entries at their memory limits', () => {
  const root=path.resolve('fixture');
  const inputs=createDevInputSnapshot([root],{maxEntries:1});
  inputs.record(path.join(root,'one.js'),'one');inputs.record(path.join(root,'two.js'),'two');
  assert.deepEqual(inputs.entries().map(([file])=>file),['one.js']);
  const tiny=createDevInputSnapshot([root],{maxBytes:1});
  tiny.record(path.join(root,'one.js'),'one');assert.deepEqual(tiny.entries().filter(([file])=>file!==null),[]);
  assert.deepEqual(tiny.entries()[0][2],{version:1,limitedPrefixes:['one.js'],globalLimited:false});
});

test('recursive directory notifications verify deep bytes and keep an identical consumed generator stable',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-recursive-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory='.contentlayer/generated',file=path.join(root,directory,'nested/data.json');
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'first');
  const filter=createDevChangeFilter(root,{directoryEventsAreRecursive:true});
  let inputs=createDevInputSnapshot([root]);await inputs.captureDirectory(directory);filter.acceptInputs(inputs.entries());
  assert.deepEqual(await filter([directory]),[],'complete consumed inputs acknowledge the first recursive notification');
  await writeFile(file,'first');assert.deepEqual(await filter([directory]),[]);
  await writeFile(file,'second');assert.deepEqual(await filter([directory]),[directory]);
  inputs=createDevInputSnapshot([root]);await inputs.captureDirectory(directory);filter.acceptInputs(inputs.entries());
  await writeFile(file,'second');assert.deepEqual(await filter([directory]),[],'identical post-build generation must not create an HMR loop');
  assert.deepEqual(filter.recursiveDiagnostics(),[]);
});

test('tree certificates compare against bytes consumed during compilation, including rollback',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-recursive-rollback-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'app'));const file=path.join(root,'app/route.js');await writeFile(file,'v1');
  const filter=createDevChangeFilter(root,{directoryEventsAreRecursive:true});
  const first=createDevInputSnapshot([root]);first.record(file,'v1');filter.acceptInputs(first.entries());
  await writeFile(file,'v2');assert.deepEqual(await filter(['app']),['app']);
  const compiler=createDevInputSnapshot([root]);compiler.record(file,'v1');filter.acceptInputs(compiler.entries());
  assert.deepEqual(await filter(['app']),['app'],'the v2 tree must not acknowledge a compiler that still consumed v1');
  const fresh=createDevInputSnapshot([root]);fresh.record(file,'v2');filter.acceptInputs(fresh.entries());
  assert.deepEqual(await filter(['app']),[]);
  const inconsistent=createDevInputSnapshot([root]);inconsistent.record(file,'v1');inconsistent.record(file,'v2');filter.acceptInputs(inconsistent.entries());
  assert.deepEqual(await filter(['app']),['app'],'inconsistent target reads cannot retain a tree certificate');
});

test('truncated input coverage is scoped and cannot certify an omitted divergent file',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-recursive-coverage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory='.contentlayer/generated',generated=path.join(root,directory,'data.json');
  await mkdir(path.dirname(generated),{recursive:true});await writeFile(generated,'stable');
  await mkdir(path.join(root,'app'));const appFile=path.join(root,'app/page.js');await writeFile(appFile,'v2');
  const notices=[],filter=createDevChangeFilter(root,{directoryEventsAreRecursive:true,onUncertainDirectory:value=>notices.push(value)});
  const seed=createDevInputSnapshot([root]);await seed.captureDirectory(directory);seed.record(appFile,'v2');filter.acceptInputs(seed.entries());
  await filter([directory]);await filter(['app']);
  const limited=createDevInputSnapshot([root],{maxEntries:4});await limited.captureDirectory(directory);
  for(let index=0;index<80;index++)limited.record(path.join(root,`app/folder-${index}/entry.js`),'unrelated');
  limited.record(appFile,'v1');filter.acceptInputs(limited.entries());
  assert.deepEqual(limited.entries()[0][2],{version:1,limitedPrefixes:['app'],globalLimited:false});
  await writeFile(generated,'stable');assert.deepEqual(await filter([directory]),[],'many truncated app folders must not invalidate the complete disjoint generator');
  let compiles=0;
  for(let index=0;index<3;index++){
    await assert.rejects(async()=>{const changed=await filter(['app']);if(changed.length)compiles++;},error=>error.code==='PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'&&/input-coverage/.test(error.message));
    filter.acceptInputs(limited.entries());
  }
  assert.equal(compiles,0,'uncertified repeated generator events must not start an HMR compilation loop');
  await writeFile(appFile,'v3');assert.deepEqual(await filter(['app/page.js']),['app/page.js'],'exact-file callbacks remain usable after the recoverable directory error');
  assert.ok(notices.some(value=>value.directory==='app'&&value.reason==='input-coverage'));
  assert.ok(!notices.some(value=>value.directory===directory));
});

test('recursive snapshots exclude output and reject incomplete reads, links and capacities without unchanged',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-recursive-limits-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'app/output'),{recursive:true});await writeFile(path.join(root,'app/page.js'),'source');await writeFile(path.join(root,'app/output/chunk.js'),'one');
  const filter=createDevChangeFilter(root,{directoryEventsAreRecursive:true,ignore:file=>file==='app/output'||file.startsWith('app/output/')});
  const inputs=createDevInputSnapshot([root]);await inputs.captureDirectory('app');filter.acceptInputs(inputs.entries());
  await filter(['app']);await writeFile(path.join(root,'app/output/chunk.js'),'two');assert.deepEqual(await filter(['app']),[]);
  const limited=createDevChangeFilter(root,{directoryEventsAreRecursive:true,maxTreeEntries:1});limited.acceptInputs(inputs.entries());
  await assert.rejects(limited(['app']),{code:'PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'});await assert.rejects(limited(['app']),{code:'PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'});
  assert.deepEqual(limited.recursiveDiagnostics(),[{directory:'app',reason:'entry-capacity'}]);
  const small=createDevChangeFilter(root,{directoryEventsAreRecursive:true,maxTreeBytes:1});small.acceptInputs(inputs.entries());
  await assert.rejects(small(['app']),{code:'PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'});assert.deepEqual(small.recursiveDiagnostics(),[{directory:'app',reason:'memory-capacity'}]);
  await mkdir(path.join(root,'outside'));await writeFile(path.join(root,'outside/private.js'),'unobserved fixture bytes');
  await symlink(path.join(root,'outside'),path.join(root,'app/linked'),'junction');
  await assert.rejects(filter(['app']),error=>error.code==='PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'&&/symbolic-link/.test(error.message)&&!error.message.includes('unobserved fixture bytes'));
});

test('an explicit empty consumed snapshot permits first nested source discovery',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-recursive-empty-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filter=createDevChangeFilter(root,{directoryEventsAreRecursive:true}),empty=createDevInputSnapshot([root]);
  assert.deepEqual(empty.entries(),[[null,null,{version:1,limitedPrefixes:[],globalLimited:false}]]);
  await mkdir(path.join(root,'app/new/deep'),{recursive:true});await writeFile(path.join(root,'app/new/deep/page.js'),'first source');
  assert.deepEqual(await filter(['app']),['app'],'construction before the first compilation is explicitly empty, without a caller seed');
  filter.acceptInputs([]);await assert.rejects(filter(['app']),{code:'PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'});
  filter.acceptInputs(empty.entries());assert.deepEqual(await filter(['app']),['app'],'a new explicit empty receipt differs from missing legacy metadata');
  const inputs=createDevInputSnapshot([root]);await inputs.captureDirectory('app');filter.acceptInputs(inputs.entries());
  assert.deepEqual(await filter(['app']),[]);
});

test('Contentlayer output snapshots include generated directories and detect later edits and new files', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-generated-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const relative='.contentlayer/generated', directory=path.join(root,relative);
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'types.d.ts'),'export type Entry=string;');
  await writeFile(path.join(directory,'index.json'),'[]');
  const inputs=createDevInputSnapshot([root]);await inputs.captureDirectory(relative);
  const filter=createDevChangeFilter(root);filter.acceptInputs(inputs.entries());
  assert.deepEqual(await filter([relative,relative+'/types.d.ts',relative+'/index.json']),[]);
  await writeFile(path.join(directory,'index.json'),'[1]');
  await writeFile(path.join(directory,'new.json'),'[2]');
  assert.deepEqual(await filter([relative,relative+'/index.json',relative+'/new.json']),[relative,relative+'/index.json',relative+'/new.json']);
});
