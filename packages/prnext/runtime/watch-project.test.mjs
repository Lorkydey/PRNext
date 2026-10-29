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

async function fixture(t,{nativeRecursive=process.platform==='darwin'}={}) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-watch-'));
  const events = [], errors = [], watched = [], notifications = [];
  let ignored = 'build/server';
  const put = async (relative, contents = 'source') => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), contents); };
  await put('app/page.jsx');
  await put('node_modules/dependency/index.js');
  await put('build/server/runtime/output.js');
  const watcher = await watchProject(root, {
    nativeRecursive,
    onChange: file => events.push(file), onError: error => errors.push(error),
    ignore: relative => relative === ignored || relative.startsWith(ignored + '/'),
    watch(file, options, callback) {
      assert.equal(options.recursive, nativeRecursive);
      const directory = path.relative(root, file).replaceAll(path.sep, '/');
      watched.push(directory);
      return watch(file, options, (event, filename) => {
        notifications.push({ directory, event, filename: filename == null ? null : String(filename) });
        if (notifications.length > 200) notifications.shift();
        callback(event, filename);
      });
    },
  });
  t.after(async () => { watcher.close(); await rm(root, { recursive: true, force: true }); });
  return { root, events, errors, watched, notifications, watcher, put, nativeRecursive, ignore: relative => { ignored = relative; } };
}
async function until(condition, diagnostics = () => '') {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('watcher did not observe source change' + diagnostics()); await delay(20); }
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

test('source-directory watcher refresh prunes a changed output directory and reports watch limit failures', async t => {
  // Pruning individual subscriptions belongs to the non-recursive backend.
  // Native recursive exclusion updates are exercised separately below.
  const f = await fixture(t,{nativeRecursive:false});
  await f.put('new-output/deep/generated.js');
  // This test exercises explicit refresh/pruning, not native event delivery on
  // a backend the platform may not select. Discover its inputs with refresh.
  await f.watcher.refresh();
  assert.ok(f.watched.includes('new-output/deep'));
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

test('source-directory watcher reconciles coalesced events below an already watched directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-watch-coalesced-'));
  const subscriptions = new Map(), events = [], errors = [];
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app/page.jsx'), 'initial');
  const watcher = await watchProject(root, {
    nativeRecursive: false,
    onChange: file => events.push(file), onError: error => errors.push(error),
    watch(directory, options, callback) {
      assert.equal(options.recursive, false);
      const relative = path.relative(root, directory).replaceAll(path.sep, '/');
      const handle = new EventEmitter();
      handle.close = () => subscriptions.delete(relative);
      subscriptions.set(relative, { callback, handle });
      return handle;
    },
  });
  t.after(async () => { watcher.close(); await rm(root, { recursive: true, force: true }); });
  // A backend may coalesce all descendant changes into the ancestor's name.
  // Re-reading only the root sees that app is already watched and misses new.
  await mkdir(path.join(root, 'app/new/deep'), { recursive: true });
  await writeFile(path.join(root, 'app/new/deep/page.jsx'), 'new source');
  subscriptions.get('').callback('rename', 'app');
  await until(() => subscriptions.has('app/new/deep'));
  await until(() => events.includes('app/new/deep/page.jsx'));
  // A notification with no filename also has to reconcile existing children.
  await mkdir(path.join(root, 'app/new/deep/added'), { recursive: true });
  await writeFile(path.join(root, 'app/new/deep/added/page.jsx'), 'another source');
  subscriptions.get('').callback('rename', null);
  await until(() => subscriptions.has('app/new/deep/added'));
  await until(() => events.includes('app/new/deep/added/page.jsx'));
  assert.deepEqual(errors, []);
});

test('platform watcher keeps concurrent nested source creations live after discovery', async t => {
  // Exercise the backend selected in production: one native recursive root on
  // macOS, source-only subscriptions on Linux/Windows. The injected-event test
  // above covers non-recursive reconciliation independently of the OS backend.
  const f = await fixture(t);
  const directories = Array.from({ length: 20 }, (_, index) => `app/burst-${index}/nested`);
  const diagnostics = () => '\n' + JSON.stringify({ nativeRecursive: f.nativeRecursive, watched: f.watched, events: f.events, errors: f.errors.map(error => String(error)), notifications: f.notifications });
  await Promise.all(directories.map(relative => f.put(`${relative}/page.jsx`)));
  await until(() => directories.every(relative => f.nativeRecursive
    ? f.events.includes(`${relative}/page.jsx`)
    : f.watched.includes(relative)), diagnostics);
  // Finish initial discovery before clearing events, so the assertion below
  // observes subsequent edits rather than initial snapshot invalidations.
  await f.watcher.refresh();
  f.events.length = 0;
  await Promise.all(directories.map((relative, index) => f.put(`${relative}/page.jsx`, `updated ${index}`)));
  await until(() => directories.every(relative => f.events.includes(`${relative}/page.jsx`)), diagnostics);
  assert.deepEqual(f.errors, []);
});
