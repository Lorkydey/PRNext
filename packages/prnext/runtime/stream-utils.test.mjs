import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { STREAM_CHUNK_BYTES, streamingBody } from './stream-utils.mjs';

test('streaming response splits bytes with one idle timer and releases it on completion', async () => {
  const timers = [];
  const hook = createHook({ init(_id, type, _trigger, resource) { if (type === 'Timeout') timers.push(resource); } });
  let complete = 0, canceled = 0;
  const bytes = new Uint8Array(STREAM_CHUNK_BYTES * 5 + 13).fill(91);
  hook.enable();
  try {
    const source = { async *[Symbol.asyncIterator]() { yield bytes; } };
    const response = streamingBody(source, { timeoutMs: 40, onComplete() { complete++; }, onCancel() { canceled++; } });
    let length = 0;
    for await (const part of response) {
      assert.ok(part.byteLength <= STREAM_CHUNK_BYTES);
      assert.ok(part.every(value => value === 91));
      length += part.byteLength;
    }
    assert.equal(length, bytes.byteLength);
    assert.equal(complete, 1);
    assert.equal(timers.length, 1, 'chunk progress must not allocate new timer resources');
    assert.equal(timers[0].hasRef(), false);
    assert.deepEqual(await response.next(), { done: true, value: undefined });
    hook.disable();
    await delay(80);
    assert.equal(complete, 1);
    assert.equal(canceled, 0, 'a completed response must not later run its idle cancellation');
  } finally { hook.disable(); }
});

test('stream progress extends the idle deadline and a stalled read still expires', async () => {
  let resolveRead, returned = 0, completed = 0;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => { resolveRead = resolve; }); },
    return() { returned++; return { done: true }; },
  };
  const response = streamingBody(source, { timeoutMs: 300, onComplete() { completed++; } });
  for (let i = 0; i < 4; i++) {
    const pending = response.next();
    await delay(110);
    resolveRead({ value: Uint8Array.of(i), done: false });
    assert.deepEqual(await pending, { value: Uint8Array.of(i), done: false });
  }
  assert.equal(returned, 0, 'an active response must survive its original idle deadline');
  // The source does not settle its outstanding read; the idle guard must reject it.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(response.next(), error => error.statusCode === 504 && /response idle/.test(error.message));
    assert.equal(returned, 1);
    assert.equal(completed, 1);
  } finally { clearTimeout(keepAlive); await response.return(); }
});

test('cancellation promptly settles a pending read and never rearms its idle timer', async () => {
  let returned = 0, completed = 0, canceled = 0, resolveRead;
  const signal = new AbortController();
  const response = streamingBody({
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => { resolveRead = resolve; }); },
    return() { returned++; return new Promise(() => {}); },
  }, { signal: signal.signal, timeoutMs: 40,
    onComplete() { completed++; }, onCancel() { canceled++; } });
  const pending = response.next();
  signal.abort(new Error('left request'));
  await assert.rejects(pending, /left request/);
  resolveRead({ value: Uint8Array.of(1), done: false });
  await response.return();
  await delay(80);
  assert.deepEqual({ returned, completed, canceled }, { returned: 1, completed: 1, canceled: 1 });
  await assert.rejects(response.next(), /left request/);
});

test('idle callbacks retain each response context across reads from another request', async () => {
  const context = new AsyncLocalStorage();
  const observed = [];
  const response = context.run({ user: 'owner' }, () => streamingBody({
    async *[Symbol.asyncIterator]() { yield Uint8Array.of(1); await new Promise(() => {}); },
  }, { timeoutMs: 50, onCancel() { observed.push(context.getStore()?.user); } }));
  await context.run({ user: 'other' }, () => response.next());
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(context.run({ user: 'other' }, () => response.next()), { statusCode: 504 });
    assert.deepEqual(observed, ['owner']);
  } finally { clearTimeout(keepAlive); await response.return(); }
});

for (const abort of [true, false]) {
  test(`${abort ? 'abort' : 'return'} can interrupt immediate empty chunks without another producer read`, async () => {
    const controller = new AbortController();
    let reads = 0, returned = 0, completed = 0, readsAfterStop = 0, stopped = false;
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (stopped) readsAfterStop++;
        return Promise.resolve({ done: false, value: ++reads < 96 ? new Uint8Array(0) : Uint8Array.of(1) });
      },
      return() { returned++; stopped = true; return new Promise(() => {}); },
    };
    const response = streamingBody(source, { signal: controller.signal, timeoutMs: 1000, onComplete() { completed++; } });
    const cancellation = setImmediate(() => {
      if (abort) controller.abort(new Error('cancel empty producer'));
      else void response.return();
    });
    try {
      if (abort) await assert.rejects(response.next(), /cancel empty producer/);
      else assert.deepEqual(await response.next(), { done: true, value: undefined });
      assert.ok(reads < 96, 'scheduled cancellation must run before the producer finishes its empty burst');
      assert.deepEqual({ returned, completed, readsAfterStop }, { returned: 1, completed: 1, readsAfterStop: 0 });
    } finally { clearImmediate(cancellation); await response.return(); }
  });
}

test('empty chunks do not extend the response idle deadline', async () => {
  let reads = 0, returned = 0;
  const response = streamingBody({
    [Symbol.asyncIterator]() { return this; },
    next() { return Promise.resolve({ done: ++reads > 1_000_000, value: new Uint8Array(0) }); },
    return() { returned++; return { done: true }; },
  }, { timeoutMs: 20 });
  try {
    await assert.rejects(response.next(), error => error.statusCode === 504 && /response idle/.test(error.message));
    assert.ok(reads < 1_000_000, 'an idle empty producer must not prevent its own watchdog from running');
    assert.equal(returned, 1);
  } finally { await response.return(); }
});

test('a cooperative empty burst still delivers its following bytes unchanged', async () => {
  const response = streamingBody({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 96; i++) yield new Uint8Array(0);
      yield Uint8Array.of(7, 8);
    },
  });
  assert.deepEqual(await response.next(), { done: false, value: Uint8Array.of(7, 8) });
  assert.deepEqual(await response.next(), { done: true, value: undefined });
});
