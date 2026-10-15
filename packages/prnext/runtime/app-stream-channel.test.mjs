import test from 'node:test';
import assert from 'node:assert/strict';
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
