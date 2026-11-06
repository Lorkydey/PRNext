import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { parentStreamChannel, workerStreamChannel, APP_STREAM_CHUNK_BYTES } from './app-stream-channel.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('queued reads share a single outstanding Flight credit and resume in order', async () => {
  const messages = [];
  const channel = parentStreamChannel({ postMessage(message) { messages.push(message); } }, 1, () => {});
  const reader = channel.body.getReader();
  const reads = [reader.read(), reader.read(), reader.read()];
  await turn();
  assert.deepEqual(messages, [{ id: 1, type: 'credit' }]);
  for (let index = 0; index < reads.length; index++) {
    channel.chunk(new Uint8Array([index]).buffer);
    assert.deepEqual([...(await reads[index]).value], [index]);
    await turn();
    assert.equal(messages.length, Math.min(index + 2, reads.length));
  }
  channel.end();
  assert.equal((await reader.read()).done, true);
});

test('an unconsumed Flight body grants no credit and cancellation settles all pending reads', async () => {
  const messages = [];
  const reason = new Error('caller disconnected');
  let cancelled;
  const channel = parentStreamChannel({ postMessage(message) { messages.push(message); } }, 2, value => { cancelled = value; });
  await turn();
  assert.equal(messages.length, 0);
  channel.chunk(new Uint8Array(APP_STREAM_CHUNK_BYTES).buffer);
  await turn();
  assert.equal(messages.length, 0);
  const reader = channel.body.getReader();
  assert.equal((await reader.read()).value.byteLength, APP_STREAM_CHUNK_BYTES);
  const reads = [reader.read(), reader.read()];
  await turn();
  assert.equal(messages.length, 1);
  await reader.cancel(reason);
  assert.equal(cancelled, reason);
  assert.ok((await Promise.all(reads)).every(result => result.done));
  assert.deepEqual(messages, [{ id: 2, type: 'credit' }, { id: 2, type: 'cancel' }]);
  channel.chunk(new Uint8Array([1]).buffer);
  channel.end();
  channel.error(new Error('late failure'));
});

test('empty completion and errors settle a pending Flight pull without extra credits', async () => {
  for (const fail of [false, true]) {
    const messages = [];
    const channel = parentStreamChannel({ postMessage(message) { messages.push(message); } }, 3, () => {});
    const reader = channel.body.getReader();
    const read = reader.read();
    await turn();
    if (fail) {
      const failure = new Error('worker failed');
      channel.error(failure);
      await assert.rejects(read, error => error === failure);
    } else {
      channel.end();
      assert.equal((await read).done, true);
    }
    await turn();
    assert.equal(messages.length, 1);
  }
});

test('the bridge retains backpressure with a slow reader and allows cancellation while blocked', async () => {
  let writer;
  let sent = 0;
  const channel = parentStreamChannel({ postMessage(message) {
    setImmediate(() => { if (message.type === 'credit') writer.credit(); else writer.cancel(); });
  } }, 4, () => {});
  writer = workerStreamChannel({ postMessage(message, transfer) {
    const wire = structuredClone(message, { transfer });
    sent++;
    setImmediate(() => {
      if (wire.chunk) channel.chunk(wire.chunk, wire.byteOffset, wire.byteLength);
      if (wire.done || wire.type === 'end') channel.end();
    });
  } }, 4);
  writer.start({ status: 200 });
  const bytes = new Uint8Array(APP_STREAM_CHUNK_BYTES * 8);
  const writing = writer.write(bytes);
  const rejected = assert.rejects(writing, /cancelled/);
  for (let count = 0; count < 3; count++) await turn();
  assert.equal(sent, 1, 'only the initial bounded chunk is sent without a reader');
  const reader = channel.body.getReader();
  await reader.read();
  for (let count = 0; count < 3; count++) await turn();
  assert.equal(sent, 1, 'consuming the initial chunk does not prefetch another');
  const next = reader.read();
  await next;
  assert.equal(sent, 2);
  await reader.cancel();
  await rejected;
});

test('real MessagePorts snapshot every transferred frame before later writes and terminal state changes', async () => {
  const { port1, port2 } = new MessageChannel();
  const wire = [];
  const parent = parentStreamChannel(port2, 17, () => {});
  const worker = workerStreamChannel(port1, 17);
  port1.on('message', message => { if (message.type === 'credit') worker.credit(); else worker.cancel(); });
  port2.on('message', message => {
    wire.push(message);
    if (message.chunk) parent.chunk(message.chunk, message.byteOffset, message.byteLength);
    if (message.done || message.type === 'end') parent.end();
  });
  const input = Uint8Array.from({ length: APP_STREAM_CHUNK_BYTES * 3 + 7 }, (_, index) => index % 251);
  const expected = Buffer.from(input), reader = parent.body.getReader();
  try {
    worker.start({ status: 201, headers: { 'x-owner': 'one' } });
    const writing = worker.write(input, undefined, true);
    const parts = [];
    for (;;) { const next = await reader.read(); if (next.done) break; parts.push(next.value); }
    await writing; worker.end(); await turn();
    assert.deepEqual(Buffer.concat(parts), expected);
    assert.equal(wire.length, 4);
    assert.deepEqual(wire.map(message => message.type), ['start', 'chunk', 'chunk', 'chunk']);
    assert.deepEqual(wire.map(message => message.done), [false, false, false, true]);
    assert.ok(wire.every(message => message.id === 17 && message.byteLength <= APP_STREAM_CHUNK_BYTES));
    assert.deepEqual(wire[0].headers, { 'x-owner': 'one' });
    assert.ok(wire.slice(1).every(message => !Object.hasOwn(message, 'headers')));
  } finally { port1.close(); port2.close(); }
});

test('pooled Buffer producers retain their allocation and cannot mutate transferred Flight bytes', async () => {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise(resolve => port2.once('message', resolve));
  const worker = workerStreamChannel(port1, 18);
  const source = Buffer.allocUnsafe(31); source.fill(3);
  try {
    worker.start({ status: 200 });
    await worker.write(source, undefined, true);
    assert.equal(source.byteLength, 31);
    source.fill(9);
    const message = await received;
    assert.deepEqual([...new Uint8Array(message.chunk, message.byteOffset, message.byteLength)], Array(31).fill(3));
    assert.equal(message.done, true);
    assert.equal(message.id, 18);
  } finally { port1.close(); port2.close(); }
});

test('separate response channels never reuse private start metadata or payload storage', async () => {
  const snapshots = [];
  const channel = id => workerStreamChannel({ postMessage(message, transfer) { snapshots.push(structuredClone(message, { transfer })); } }, id);
  const first = channel(19), second = channel(20);
  first.start({ status: 200, headers: { 'x-owner': 'first' } });
  second.start({ status: 202, headers: { 'x-owner': 'second' } });
  await first.write(new Uint8Array([1]), undefined, true);
  await second.write(new Uint8Array([2]), undefined, true);
  assert.deepEqual(snapshots.map(({ id, status, headers, chunk }) => ({ id, status, owner: headers['x-owner'], bytes: [...new Uint8Array(chunk)] })), [
    { id: 19, status: 200, owner: 'first', bytes: [1] }, { id: 20, status: 202, owner: 'second', bytes: [2] },
  ]);
});
