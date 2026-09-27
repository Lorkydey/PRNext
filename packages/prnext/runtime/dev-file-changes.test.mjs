import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
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
  tiny.record(path.join(root,'one.js'),'one');assert.deepEqual(tiny.entries(),[]);
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
