import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefetchScheduler, prefetchCacheVictim } from './prefetch-scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const connection = Object.assign(new EventTarget(), { effectiveType: '4g', downlink: 10, saveData: false });
  const win = Object.assign(new EventTarget(), { navigator: { connection, onLine: true } });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  return { win, doc, connection, scheduler: createPrefetchScheduler({ window: win, document: doc }) };
}
function pending(scheduler, events, name, priority = 'viewport') {
  let complete;
  const task = scheduler.schedule(signal => {
    events.push({ name, signal });
    return new Promise(resolve => { complete = resolve; });
  }, { priority });
  task.promise.catch(() => {});
  return { ...task, complete: value => complete?.(value) };
}

test('intent prefetch runs before viewport work with stable FIFO and two producers maximum', async () => {
  const { scheduler } = fixture(), events = [];
  try {
    const a = pending(scheduler, events, 'viewport-a'), b = pending(scheduler, events, 'viewport-b');
    const c = pending(scheduler, events, 'intent', 'intent'), d = pending(scheduler, events, 'viewport-d');
    await tick();
    assert.deepEqual(events.map(value => value.name), ['intent', 'viewport-a']);
    c.complete('ready'); assert.equal(await c.promise, 'ready'); await tick();
    assert.deepEqual(events.map(value => value.name), ['intent', 'viewport-a', 'viewport-b']);
    a.complete(); b.complete(); await tick(); d.complete(); await d.promise;
  } finally { scheduler.dispose(); }
});

test('hover and keyboard intent promote the queued route without duplicate work', async () => {
  const { scheduler } = fixture(), events = [];
  try {
    const a = pending(scheduler, events, 'a'), b = pending(scheduler, events, 'b'), c = pending(scheduler, events, 'c');
    c.promote('intent'); c.promote('viewport');
    await tick(); assert.deepEqual(events.map(value => value.name), ['c', 'a']);
    c.complete(); a.complete(); await tick(); b.complete(); await b.promise;
    assert.equal(events.filter(value => value.name === 'c').length, 1);
  } finally { scheduler.dispose(); }
});

test('a demanded route bypasses blocked producers and speculation stays suspended until navigation ends', async () => {
  const { scheduler, connection } = fixture(), events = [];
  try {
    const a = pending(scheduler, events, 'blocked-a'), b = pending(scheduler, events, 'blocked-b');
    const destination = pending(scheduler, events, 'clicked');
    await tick();
    connection.saveData = true;
    const release = scheduler.navigation(destination);
    connection.dispatchEvent(new Event('change'));
    await tick();
    assert.deepEqual(events.map(value => value.name), ['blocked-a', 'blocked-b', 'clicked']);
    assert.equal(events[0].signal.aborted, true); assert.equal(events[1].signal.aborted, true);
    assert.equal(events[2].signal.aborted, false, 'committed navigation ignores speculative connection policy');
    await assert.rejects(a.promise, { name: 'AbortError' }); await assert.rejects(b.promise, { name: 'AbortError' });
    connection.saveData = false;
    const later = pending(scheduler, events, 'later');
    destination.complete('navigation'); await destination.promise; await tick();
    assert.equal(events.length, 3);
    release(); release(); await tick(); assert.equal(events.at(-1).name, 'later');
    later.complete(); await later.promise;
  } finally { scheduler.dispose(); }
});

test('navigation without a prefetched target cancels obsolete work before new requests start', async () => {
  const { scheduler } = fixture(), events = [];
  try {
    const blocked = pending(scheduler, events, 'never-settles'); await tick();
    const release = scheduler.navigation();
    await assert.rejects(blocked.promise, { name: 'AbortError' });
    const next = pending(scheduler, events, 'next'); await tick(); assert.equal(events.length, 1);
    release(); await tick(); assert.equal(events.at(-1).name, 'next'); next.complete(); await next.promise;
  } finally { scheduler.dispose(); }
});

test('save data, slow2g,2g, offline and hidden tabs do not start speculative traffic', async () => {
  for (const setup of [
    f => { f.connection.saveData = true; },
    f => { f.connection.effectiveType = 'slow-2g'; },
    f => { f.connection.effectiveType = '2g'; },
    f => { f.win.navigator.onLine = false; },
    f => { f.doc.visibilityState = 'hidden'; },
  ]) {
    const f = fixture(); setup(f); let called = false;
    try {
      assert.equal(f.scheduler.schedule(() => { called = true; }), undefined);
      assert.equal(f.scheduler.schedule(() => { called = true; }, { priority: 'intent' }), undefined);
      await tick(); assert.equal(called, false);
    } finally { f.scheduler.dispose(); }
  }
});

test('3g and low downlink reserve a single producer for demonstrated intent', async () => {
  for (const setup of [f => { f.connection.effectiveType = '3g'; }, f => { f.connection.downlink = 0.75; }]) {
    const f = fixture(), events = []; setup(f);
    try {
      assert.equal(f.scheduler.schedule(() => {}, { priority: 'viewport' }), undefined);
      const a = pending(f.scheduler, events, 'a', 'intent'), b = pending(f.scheduler, events, 'b', 'intent');
      await tick(); assert.deepEqual(events.map(value => value.name), ['a']);
      a.complete(); await a.promise; await tick(); assert.equal(events.at(-1).name, 'b'); b.complete(); await b.promise;
    } finally { f.scheduler.dispose(); }
  }
});

test('network and visibility changes abort existing producers and discard queued work promptly', async () => {
  const f = fixture(), events = [];
  try {
    const tasks = [pending(f.scheduler, events, 'a'), pending(f.scheduler, events, 'b'), pending(f.scheduler, events, 'c')];
    await tick(); f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.all(tasks.map(task => assert.rejects(task.promise, { name: 'AbortError' })));
    f.doc.visibilityState = 'visible'; f.doc.dispatchEvent(new Event('visibilitychange'));
    const task = pending(f.scheduler, events, 'visible', 'intent'); await tick();
    f.connection.saveData = true; f.connection.dispatchEvent(new Event('change'));
    await assert.rejects(task.promise, { name: 'AbortError' });
    assert.equal(events.length, 3, 'cancelled queued work is not replayed after visibility returns');
  } finally { f.scheduler.dispose(); }
});

test('queue size is bounded and viewport scans cannot evict stronger intent', async () => {
  const { scheduler } = fixture(), events = [];
  try {
    const tasks = Array.from({ length: 8 }, (_, index) => pending(scheduler, events, String(index), 'intent'));
    assert.equal(scheduler.schedule(() => {}, { priority: 'viewport' }), undefined);
    const newest = pending(scheduler, events, 'newest', 'intent');
    await assert.rejects(tasks[0].promise, { name: 'AbortError' });
    await tick(); assert.deepEqual(events.map(value => value.name), ['1', '2']);
    newest.abort.abort();
  } finally { scheduler.dispose(); }
});

test('late results after abort cannot settle a task twice or steal another producer slot', async () => {
  const { scheduler } = fixture(), events = [];
  try {
    const first = pending(scheduler, events, 'late'); await tick();
    first.abort.abort(); await assert.rejects(first.promise, { name: 'AbortError' });
    const second = pending(scheduler, events, 'second'), third = pending(scheduler, events, 'third');
    await tick(); first.complete('stale'); await tick();
    const fourth = pending(scheduler, events, 'fourth'); await tick(); assert.equal(events.length, 3);
    second.complete(); await tick(); assert.equal(events.at(-1).name, 'fourth');
    third.complete(); fourth.complete(); await Promise.all([second.promise, third.promise, fourth.promise]);
  } finally { scheduler.dispose(); }
});

test('browsers without NetworkInformation work and disposal detaches event listeners', async () => {
  const counts = new Map();
  const target = name => ({ addEventListener(event) { counts.set(name + event, (counts.get(name + event) || 0) + 1); },
    removeEventListener(event) { counts.set(name + event, counts.get(name + event) - 1); } });
  const scheduler = createPrefetchScheduler({ window: target('window'), document: target('document') });
  assert.equal(await scheduler.schedule(() => 7).promise, 7);
  scheduler.dispose(); scheduler.dispose();
  assert.equal(scheduler.schedule(() => 8), undefined);
  assert.deepEqual([...counts.values()], [0, 0, 0]);
});

test('cache and scheduler eviction choose the same lowest-priority FIFO victim and remove aborted entries first', () => {
  const entry = priority => ({ priority, abort: new AbortController() });
  const cache = new Map([['intent', entry(1)], ['viewport-first', entry(0)], ['viewport-last', entry(0)]]);
  assert.equal(prefetchCacheVictim(cache, 0), 'viewport-first');
  cache.get('viewport-first').priority = 1;
  assert.equal(prefetchCacheVictim(cache, 0), 'viewport-last');
  cache.get('viewport-last').priority = 1;
  assert.equal(prefetchCacheVictim(cache, 0), undefined);
  assert.equal(prefetchCacheVictim(cache, 1), 'intent');
  cache.get('viewport-first').abort.abort();
  assert.equal(prefetchCacheVictim(cache, 0), 'viewport-first', 'already-cancelled producer is not a second live eviction');
});
