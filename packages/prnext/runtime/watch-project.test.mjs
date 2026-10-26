import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { rename } from './fs.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchProject } from './watch-project.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-watch-'));
  const events = [], errors = [], watched = [];
  let ignored = 'build/server';
  const put = async (relative, contents = 'source') => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), contents); };
  await put('app/page.jsx');
  await put('node_modules/dependency/index.js');
  await put('build/server/runtime/output.js');
  const watcher = await watchProject(root, {
    onChange: file => events.push(file), onError: error => errors.push(error),
    ignore: relative => relative === ignored || relative.startsWith(ignored + '/'),
    watch(file, options, callback) { assert.equal(options.recursive, process.platform === 'darwin'); watched.push(path.relative(root, file).replaceAll(path.sep, '/')); return watch(file, options, callback); },
  });
  t.after(async () => { watcher.close(); await rm(root, { recursive: true, force: true }); });
  return { root, events, errors, watched, watcher, put, ignore: relative => { ignored = relative; } };
}
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('watcher did not observe source change'); await delay(20); }
}

test('watcher never traverses transient build trees and stays live during atomic output swaps', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    await f.put(`.prnext-stage-${i}/runtime/worker.mjs`);
    await rename(path.join(f.root, `.prnext-stage-${i}`), path.join(f.root, `.prnext-backup-${i}`));
    await rm(path.join(f.root, `.prnext-backup-${i}`), { recursive: true });
  }
  await f.put('app/page.jsx', 'changed');
  await until(() => f.events.includes('app/page.jsx'));
  assert.deepEqual(f.errors, []);
  assert.ok(!f.watched.some(file => file.includes('node_modules') || file.includes('.prnext-') || file.includes('build/server')));
  assert.ok(!f.events.some(file => file.includes('.prnext-')));
});

test('watcher follows created, renamed and removed source directories and root env files', async t => {
  const f = await fixture(t);
  await f.put('app/new/page.jsx');
  await until(() => process.platform === 'darwin'
    ? f.events.some(file => file === 'app/new' || file.startsWith('app/new/'))
    : f.watched.includes('app/new'));
  await f.put('app/new/page.jsx', 'changed');
  await until(() => f.events.includes('app/new/page.jsx'));
  await rename(path.join(f.root, 'app/new'), path.join(f.root, 'app/moved'));
  await until(() => process.platform === 'darwin'
    ? f.events.some(file => file === 'app/moved' || file.startsWith('app/moved/'))
    : f.watched.includes('app/moved'));
  await f.put('app/moved/page.jsx', 'moved');
  await until(() => f.events.includes('app/moved/page.jsx'));
  await rm(path.join(f.root, 'app/moved'), { recursive: true });
  await f.put('.env.development.local', 'VALUE=updated');
  await until(() => f.events.includes('.env.development.local'));
  assert.deepEqual(f.errors, []);
});

test('watcher discovers Contentlayer generated inputs without watching its cache', async t => {
  const f = await fixture(t);
  await f.put('.contentlayer/generated/data.js');
  await f.put('.contentlayer/.cache/config.js');
  await until(() => process.platform === 'darwin'
    ? f.events.some(file => file.startsWith('.contentlayer/generated'))
    : f.watched.includes('.contentlayer/generated'));
  await f.put('.contentlayer/generated/data.js', 'changed');
  await until(() => f.events.includes('.contentlayer/generated/data.js'));
  assert.ok(!f.watched.some(file => file.includes('.cache')));
  assert.deepEqual(f.errors, []);
});

test('watcher refresh prunes a changed output directory and reports watch limit failures', async t => {
  const f = await fixture(t);
  await f.put('new-output/deep/generated.js');
  await until(() => process.platform === 'darwin'
    // Native FSEvents can coalesce a newly-created subtree to its top directory.
    ? f.events.some(file => file === 'new-output' || file.startsWith('new-output/'))
    : f.watched.includes('new-output/deep'));
  f.ignore('new-output');
  await f.watcher.refresh();
  f.events.length = 0;
  await f.put('new-output/deep/generated.js', 'changed');
  await f.put('app/page.jsx', 'still watched');
  await until(() => f.events.includes('app/page.jsx'));
  assert.ok(!f.events.some(file => file.startsWith('new-output/')));
  await assert.rejects(watchProject(f.root, { onChange() {}, onError() {}, nativeRecursive: false, maxDirectories: 1 }), /exceeds 1 source directories/);
  assert.deepEqual(f.errors, []);
});

test('native recursive watcher accepts coalesced subtree events and applies refreshed output exclusions',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-watch-native-')),events=[],errors=[];
  let callback,ignored='old-output',closed=false;
  const native=new EventEmitter();native.close=()=>{closed=true;};
  const watcher=await watchProject(root,{nativeRecursive:true,onChange:file=>events.push(file),onError:error=>errors.push(error),
    ignore:relative=>relative===ignored||relative.startsWith(ignored+'/'),
    watch(directory,options,listener){assert.equal(directory,root);assert.equal(options.recursive,true);callback=listener;return native;}});
  t.after(async()=>{watcher.close();await rm(root,{recursive:true,force:true});});
  callback('rename','new-output');
  callback('change','new-output/deep/generated.js');
  assert.deepEqual(events,['new-output','new-output/deep/generated.js']);
  ignored='new-output';await watcher.refresh();events.length=0;
  callback('rename','new-output');callback('change','new-output/deep/generated.js');callback('change','app/page.jsx');
  assert.deepEqual(events,['app/page.jsx']);assert.deepEqual(errors,[]);assert.equal(closed,false);
});
