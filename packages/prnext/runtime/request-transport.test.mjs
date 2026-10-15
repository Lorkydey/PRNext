import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFrames } from './request-transport.mjs';
import { workerMetadata, flightBundler, freezeClientModules, isImmutableClientModules } from './worker-metadata.mjs';

test('production client manifests seal module paths while mutable and accessor maps stay untrusted', () => {
  const value={client:{ssrModule:'client.mjs',browserModule:'/client.js'}};
  assert.equal(isImmutableClientModules(value),false);
  assert.equal(freezeClientModules(value),value);
  assert.equal(freezeClientModules(value),value);
  assert.equal(isImmutableClientModules(value),true);
  assert.throws(()=>{value.client.ssrModule='replacement.mjs';},TypeError);
  assert.throws(()=>{value.other={ssrModule:'other.mjs'};},TypeError);
  assert.equal(isImmutableClientModules({...value}),false);
  let path='first.mjs';
  const getter={client:{get ssrModule(){return path;}}};
  freezeClientModules(getter); path='second.mjs';
  assert.equal(isImmutableClientModules(getter),false);
  assert.equal(getter.client.ssrModule,'second.mjs');
  const indirect={get client(){return {ssrModule:path};}};
  assert.equal(freezeClientModules(indirect),indirect);
  assert.equal(isImmutableClientModules(indirect),false);
  const empty={}; freezeClientModules(empty); assert.equal(isImmutableClientModules(empty),true);
});

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
  for (const value of ['{"bodyLength":33554433}\n', '{"bodyLength":-1}\n', '{"bodyLength":1.5}\n', 'null\n', '{"bodyLength":4}\nabc', '{"id":1', 'x'.repeat(256 * 1024 + 1)]) {
    await assert.rejects(async () => { for await (const _ of requestFrames([Buffer.from(value)])) {} });
  }
  await assert.rejects(async () => { for await (const _ of requestFrames([Buffer.from('x'.repeat(257))], { authenticate() {} })) {} });
});

test('25 MiB uploads preserve binary bytes and the following frame', async () => {
  const body = Buffer.alloc(25 * 1024 * 1024, 173);
  body[1] = 0; body[body.length - 1] = 255;
  async function* source() {
    yield Buffer.from(JSON.stringify({ id: 1, bodyLength: body.length }) + '\n');
    for (let i = 0; i < body.length; i += 65536) yield body.subarray(i, i + 65536);
    yield Buffer.from('{"id":2,"bodyLength":0}\n');
  }
  const result = [];
  for await (const frame of requestFrames(source())) result.push(frame);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].body, body);
  assert.equal(result[1].id, 2);
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
