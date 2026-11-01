import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { rename } from './fs.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchProject } from './watch-project.mjs';
import { createDevChangeFilter, createDevInputSnapshot } from './dev-file-changes.mjs';
import { discoverDevelopment } from '../build/dev-discovery.mjs';

async function fixture(t,{nativeRecursive=process.platform==='darwin',onSourceChange}={}) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-watch-'));
  const events = [], errors = [], watched = [], notifications = [];
  let ignored = 'build/server';
  const put = async (relative, contents = 'source') => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), contents); };
  await put('app/page.jsx');
  await put('node_modules/dependency/index.js');
  await put('build/server/runtime/output.js');
  const watcher = await watchProject(root, {
    nativeRecursive,
    onChange: (file,event) => {const index=events.push(file)-1;onSourceChange?.(file,event,index);}, onError: error => errors.push(error),
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
function directoryEventAfter(fixture, directory, from) {
  return fixture.events.slice(from).some(file => file && (file === directory || file.startsWith(directory + '/')
    || fixture.nativeRecursive && directory.startsWith(file + '/')));
}
function watchDiagnostics(fixture, stage, from) {
  const text = value => String(value).slice(0, 256);
  return () => '\n' + JSON.stringify({ stage, nativeRecursive: fixture.nativeRecursive,
    eventCount: fixture.events.length, events: fixture.events.slice(from).slice(-50).map(text),
    watched: fixture.watched.slice(-50).map(text),
    errors: fixture.errors.slice(-20).map(error => ({ name: error.name, code: error.code })),
    notifications: fixture.notifications.slice(-50).map(value => ({ directory: text(value.directory), event: value.event, filename: value.filename == null ? null : text(value.filename) })) });
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
  let phase,f;
  f = await fixture(t,{onSourceChange(file,_event,index){
    const current=phase;
    if(!current||index<current.from||!directoryEventAfter({events:[file],nativeRecursive:f.nativeRecursive},current.scope,0))return;
    current.observed=true;
    if(current.tasks.length>=200)return;
    current.tasks.push((async()=>{
      await current.mutation;
      try{current.consumed=await readFile(path.join(f.root,current.file),'utf8');}
      catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))current.consumed=null;else throw error;}
    })().catch(error=>f.errors.push(error)));
  }});
  async function mutate(name,scope,file,contents,operation,discovered){
    const current=phase={from:f.events.length,scope,file,tasks:[]};
    current.mutation=operation();
    try{
      await current.mutation;
      const diagnostics=watchDiagnostics(f,name,current.from);
      await until(()=>current.observed&&current.consumed===contents&&(!discovered||discovered()),()=>diagnostics()+'\n'+JSON.stringify({eventObserved:current.observed===true,consumedExpected:current.consumed===contents,readTasks:current.tasks.length}));
    }finally{phase=undefined;await Promise.allSettled(current.tasks);}
  }
  // Native recursive events may name an ancestor of a structural mutation.
  // https://developer.apple.com/documentation/coreservices/1455361-fseventstreameventflags/kfseventstreameventflagmustscansubdirs/
  await mutate('create-directory','app/new','app/new/page.jsx','source',()=>f.put('app/new/page.jsx'),()=>f.nativeRecursive||f.watched.includes('app/new'));
  await mutate('edit-created-page','app/new/page.jsx','app/new/page.jsx','changed',()=>f.put('app/new/page.jsx','changed'));
  await mutate('rename-directory','app/moved','app/moved/page.jsx','changed',()=>rename(path.join(f.root,'app/new'),path.join(f.root,'app/moved')),()=>f.nativeRecursive||f.watched.includes('app/moved'));
  await mutate('edit-moved-page','app/moved/page.jsx','app/moved/page.jsx','moved',()=>f.put('app/moved/page.jsx','moved'));
  await mutate('remove-directory','app/moved','app/moved/page.jsx',null,()=>rm(path.join(f.root,'app/moved'),{recursive:true}));
  await mutate('edit-root-env','.env.development.local','.env.development.local','VALUE=updated',()=>f.put('.env.development.local','VALUE=updated'));
  assert.deepEqual(f.errors, []);
});

test('native ancestor notifications discover structure and refresh consumed nested content', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-watch-native-consumer-'));
  const events = [], errors = [];
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  await put('app/layout.jsx', 'export default function Layout({children}){return <html><body>{children}</body></html>;}');
  await put('app/page.jsx', 'export default function Page(){return null;}');
  const filter = createDevChangeFilter(root, { directoryEventsAreRecursive: true });
  const initialInputs=createDevInputSnapshot([root]);await initialInputs.captureDirectory('app');filter.acceptInputs(initialInputs.entries());
  await filter(['app']);
  let listener, pending = Promise.resolve(), consumed = {}, executions = 0;
  const watcher = await watchProject(root, { nativeRecursive: true, onError: error => errors.push(error), onChange(file) {
    events.push(file);
    pending = pending.then(async () => {
      if (!(await filter([file])).length) return;
      const { project } = await discoverDevelopment(root);
      // Capture at consumption time. Reading after the assertion would conceal
      // a dropped invalidation because the path already points to new bytes.
      consumed = Object.fromEntries(await Promise.all(project.routes.map(async route => [route.pattern, await readFile(route.file, 'utf8')])));
      const inputs=createDevInputSnapshot([root]);await inputs.captureDirectory('app');filter.acceptInputs(inputs.entries());
      executions++;
    });
  }, watch(directory, options, callback) {
    assert.equal(directory, root); assert.equal(options.recursive, true); listener = callback;
    const handle = new EventEmitter(); handle.close = () => {}; return handle;
  } });
  t.after(async () => { watcher.close(); await Promise.allSettled([pending]); await rm(root, { recursive: true, force: true }); });
  const f = { events, nativeRecursive: true };
  listener('rename', 'unrelated'); await pending;
  assert.equal(directoryEventAfter(f, 'app/new', 0), false, 'an unrelated event cannot satisfy target discovery');
  let from = events.length;
  await put('app/new/deep/page.jsx', 'export default function Page(){return "created-v1";}');
  listener('rename', 'app'); await pending;
  assert.equal(directoryEventAfter(f, 'app/new', from), true);
  assert.match(consumed['/new/deep'], /created-v1/);
  const beforeEdit = executions;
  from = events.length;
  await put('app/new/deep/page.jsx', 'export default function Page(){return "changed-v2";}');
  listener('rename', 'app'); await pending;
  assert.equal(events.length, from + 1, 'the second ancestor notification must reach the consumer');
  assert.equal(executions, beforeEdit + 1, 'the ancestor invalidation must reach the real filter and discovery');
  assert.match(consumed['/new/deep'], /changed-v2/);
  from = events.length;
  await rename(path.join(root, 'app/new'), path.join(root, 'app/moved'));
  listener('rename', 'app'); await pending;
  assert.equal(directoryEventAfter(f, 'app/moved', from), true);
  assert.equal(Object.hasOwn(consumed, '/new/deep'), false);
  assert.match(consumed['/moved/deep'], /changed-v2/);
  await put('app/moved/deep/page.jsx', 'export default function Page(){return "moved-v3";}');
  listener('change', 'app/moved/deep/page.jsx'); await pending;
  assert.match(consumed['/moved/deep'], /moved-v3/);
  from = events.length;
  await rm(path.join(root, 'app/moved'), { recursive: true });
  listener('rename', 'app'); await pending;
  assert.equal(directoryEventAfter(f, 'app/moved', from), true);
  assert.deepEqual(Object.keys(consumed), ['/']);
  assert.deepEqual(errors, []);
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
