import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolOutput, ProtocolWriteError, MAX_STREAM_CHUNK } from './transport.mjs';
import { setImmediate as immediate } from 'node:timers/promises';

test('broken transport cancels every response shape once without a replacement error frame', async () => {
  for (const mode of ['head', 'chunk', 'compact', 'batch', 'legacy', 'head-method']) {
    const writes = [], abort = new AbortController();
    let cancellations = 0;
    const output = createProtocolOutput((part, done) => {
      writes.push(Buffer.from(part));
      done(mode === 'chunk' && writes.length === 1 ? undefined : Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    }, mode === 'batch' ? { cork() {}, uncork() {} } : undefined);
    const body = ['head', 'chunk'].includes(mode) ? (async function* () { yield Buffer.from('hello'); })() : Buffer.from('hello');
    await assert.rejects(output(42, { status: 200, body, cancel() { cancellations++; } }, {
      stream: mode !== 'legacy', compactResponse: mode === 'compact', signalController: abort,
      method: mode === 'head-method' ? 'HEAD' : 'GET',
    }), ProtocolWriteError);
    assert.equal(abort.signal.aborted, true, mode);
    assert.equal(cancellations, 1, mode);
    assert.ok(!writes.some(part => part.toString().includes('"type":"error"')), mode);
    assert.equal(writes.length, mode === 'chunk' ? 2 : mode === 'batch' ? 4 : 1, mode);
  }
});

test('an already cancelled producer is released without writing response bytes', async () => {
  const abort = new AbortController(); abort.abort(new Error('client cancelled'));
  let cancelled = 0;
  await assert.rejects(createProtocolOutput(() => assert.fail('must not write after cancellation'))(1, {
    status: 200, body: 'unused', cancel() { cancelled++; },
  }, { stream: true, signalController: abort }), /client cancelled/);
  assert.equal(cancelled, 1);
});

test('application stream failures retain a terminal error frame and private production message', async () => {
  const writes = [], logs = [], originalError = console.error;
  console.error = (...args) => logs.push(args);
  let cancelled = 0;
  try {
    await createProtocolOutput((part, done) => { writes.push(Buffer.from(part)); done(); })(7, {
      status: 200, body: (async function* () { yield Buffer.from('prefix'); throw new Error('PRIVATE_APPLICATION_FAILURE'); })(),
      cancel() { cancelled++; },
    }, { stream: true, signalController: new AbortController() });
  } finally { console.error = originalError; }
  assert.equal(cancelled, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(writes.at(-1)), { id: 7, type: 'error', message: 'Response stream failed' });
  assert.ok(!Buffer.concat(writes).includes('PRIVATE_APPLICATION_FAILURE'));
});

test('stream transport preserves byte views and splits every producer shape into bounded nonempty chunks', async () => {
  const backing = Uint8Array.from([250, 1, 2, 3, 251]);
  const view = new DataView(backing.buffer, 1, 3);
  const large = Buffer.alloc(2 * MAX_STREAM_CHUNK + 1, 97);
  const samples = [
    { body: large, expected: large },
    { body: 'é🚀'.repeat(20000), expected: Buffer.from('é🚀'.repeat(20000)) },
    { body: view, expected: Buffer.from([1, 2, 3]) },
    { body: [Buffer.alloc(0), view, large, new Uint8Array([4]).buffer, 'é'], expected: Buffer.concat([Buffer.from([1, 2, 3]), large, Buffer.from([4]), Buffer.from('é')]) },
    { body: (async function* () { yield Buffer.alloc(0); yield view; yield large; })(), expected: Buffer.concat([Buffer.from([1, 2, 3]), large]) },
    { body: (async function* () { yield Buffer.alloc(0); })(), expected: Buffer.alloc(0) },
  ];
  for (const { body, expected } of samples) {
    const parts = [];
    await createProtocolOutput((part, done) => { parts.push(Buffer.from(part)); queueMicrotask(done); }, { cork() {}, uncork() {} })
      (9, { status: 200, body }, { stream: true });
    const wire = Buffer.concat(parts), chunks = [];
    let offset = 0, ended = false;
    while (offset < wire.length) {
      const newline = wire.indexOf(10, offset);
      assert.ok(newline >= offset);
      const frame = JSON.parse(wire.subarray(offset, newline));
      assert.equal(frame.id, 9);
      offset = newline + 1;
      if (frame.type === 'chunk') {
        assert.ok(frame.length > 0 && frame.length <= MAX_STREAM_CHUNK);
        chunks.push(wire.subarray(offset, offset + frame.length));
        offset += frame.length;
      } else if (frame.type === 'end') ended = true;
      else assert.equal(frame.type, 'head');
    }
    assert.equal(ended, true);
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
});

test('transport waits for chunk writes before pulling and closes the producer on failed backpressure', async () => {
  const queued = [], writes = [];
  let pulls = 0, finalized = 0, cancelled = 0;
  const body = (async function* () {
    try {
      pulls++; yield Buffer.alloc(2 * MAX_STREAM_CHUNK + 1, 97);
      pulls++; yield Buffer.from('next');
    } finally { finalized++; }
  })();
  const output = createProtocolOutput((part, done) => { writes.push(Buffer.from(part)); queued.push(done); }, { cork() {}, uncork() {} });
  const complete = output(10, { status: 200, body, cancel() { cancelled++; } }, { stream: true });
  const rejected = assert.rejects(complete, ProtocolWriteError);
  await immediate();
  assert.equal(pulls, 0, 'headers must be accepted before reading the producer');
  for (const done of queued.splice(0)) done();
  await immediate();
  assert.equal(pulls, 1);
  for (const expectedLength of [MAX_STREAM_CHUNK, MAX_STREAM_CHUNK, 1]) {
    assert.equal(writes.at(-1).length, expectedLength);
    assert.equal(pulls, 1, 'splitting one value does not prefetch another producer value');
    for (const done of queued.splice(0)) done();
    await immediate();
  }
  assert.equal(pulls, 2);
  for (const done of queued.splice(0)) done(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await rejected;
  assert.equal(finalized, 1);
  assert.equal(cancelled, 1);
  assert.ok(!writes.some(part => part.toString().includes('"type":"end"') || part.toString().includes('"type":"error"')));
});

test('uncorked transport awaits each write and closes a synchronous iterator once on failure', async () => {
  const queued = [], writes = [], abort = new AbortController();
  let pulls = 0, returned = 0, cancelled = 0;
  const body = {
    [Symbol.iterator]() { return this; },
    next() {
      pulls++;
      return { done: false, value: Buffer.alloc(MAX_STREAM_CHUNK + 1, 97) };
    },
    return() { returned++; return { done: true }; },
  };
  const output = createProtocolOutput((part, done) => { writes.push(Buffer.from(part)); queued.push(done); });
  const complete = output(11, { status: 200, body, cancel() { cancelled++; } }, { stream: true, signalController: abort });
  const rejected = assert.rejects(complete, ProtocolWriteError);
  const accept = async error => {
    assert.equal(queued.length, 1, 'uncorked writes must remain sequential');
    queued.shift()(error);
    await immediate();
  };
  await immediate();
  assert.equal(pulls, 0, 'headers must settle before the first synchronous next()');
  await accept();
  assert.equal(pulls, 1);
  assert.deepEqual(JSON.parse(writes.at(-1)), { id: 11, type: 'chunk', length: MAX_STREAM_CHUNK });
  await accept();
  assert.equal(writes.at(-1).length, MAX_STREAM_CHUNK);
  assert.equal(pulls, 1, 'a pending data write must not prefetch the next producer value');
  await accept();
  assert.deepEqual(JSON.parse(writes.at(-1)), { id: 11, type: 'chunk', length: 1 });
  assert.equal(pulls, 1, 'splitting the existing value must not advance the iterator');
  await accept();
  assert.equal(writes.at(-1).length, 1);
  await accept(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await rejected;
  assert.equal(pulls, 1);
  assert.equal(returned, 1, 'for-await must close the underlying synchronous iterator');
  assert.equal(cancelled, 1);
  assert.equal(abort.signal.aborted, true);
  assert.equal(writes.length, 5, 'head, two chunk headers and their data; no terminal/error write after EPIPE');
  assert.equal(queued.length, 0);
});
