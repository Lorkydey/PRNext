import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFrames } from './request-transport.mjs';
import { workerMetadata, flightBundler } from './worker-metadata.mjs';

test('binary request frames preserve arbitrary bytes and boundaries under fragmented reads', async () => {
  const body = Buffer.from([0, 10, 13, 255, 128, 34]);
  const wire = Buffer.concat([Buffer.from('secret\n{"id":1,"bodyLength":6}\n'), body, Buffer.from('{"id":2,"bodyLength":0}\n')]);
  for (const width of [1, 2, 9, 65536]) {
    let authenticated = 0;
    async function* source() { for (let at = 0; at < wire.length; at += width) yield wire.subarray(at, at + width); }
    const result = [];
    for await (const frame of requestFrames(source(), { authenticate(value) { assert.equal(value, 'secret'); authenticated++; } })) result.push(frame);
    assert.equal(authenticated, 1);
    assert.deepEqual(result, [{ id: 1, bodyLength: 6, body }, { id: 2, bodyLength: 0, body: Buffer.alloc(0) }]);
  }
});

test('request framing rejects oversized, malformed and truncated input before dispatch', async () => {
  for (const value of ['{"bodyLength":8388609}\n', '{"bodyLength":-1}\n', '{"bodyLength":1.5}\n', 'null\n', '{"bodyLength":4}\nabc', '{"id":1', 'x'.repeat(256 * 1024 + 1)]) {
    await assert.rejects(async () => { for await (const _ of requestFrames([Buffer.from(value)])) {} });
  }
  await assert.rejects(async () => { for await (const _ of requestFrames([Buffer.from('x'.repeat(257))], { authenticate() {} })) {} });
});

test('worker manifest registration is bounded and ordered, and re-registers evicted builds', () => {
  const messages = [], register = workerMetadata({ postMessage: value => messages.push(value) }, 2);
  const first = { client: { browserModule: '/one.js' } }, second = {}, third = {};
  const id = register(first);
  assert.equal(register(first), id);
  assert.equal(messages.length, 1);
  register(second); register(third);
  assert.deepEqual(messages[2], { type: 'metadata-drop', id });
  assert.notEqual(register(first), id);
  const resident = new Map();
  for (const message of messages) {
    if (message.type === 'metadata') resident.set(message.id, message.value);
    else resident.delete(message.id);
    assert.ok(resident.size <= 2);
  }
  assert.equal(flightBundler(first), flightBundler(first));
  assert.deepEqual(flightBundler(first).client.chunks, ['client', '/one.js']);
  assert.deepEqual(flightBundler(first, false).client.chunks, []);
});
