import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDeadline, acquireReferenceResource, closeReferenceResources } from './lifecycle.mjs';

test('an unresolved operation is bounded independently of its own timeout implementation', async () => {
  await assert.rejects(referenceDeadline(new Promise(() => {}), 'owned operation timeout', 10), /owned operation timeout/);
  assert.equal(await referenceDeadline(Promise.resolve('done'), 'unexpected timeout', 10), 'done');
});

test('a progress write failure cannot skip owned resource cleanup', async () => {
  let closed = false;
  const result = await closeReferenceResources([{ name: 'owned', timeout: 10, close: async () => { closed = true; } }], async () => { throw new Error('injected write failure'); });
  assert.equal(closed, true);
  assert.equal(result[0].phase, 'closed');
  assert.equal(result[0].progressPersistenceFailed, true);
});

test('a progress write that never settles cannot retain owned services', async () => {
  const closed = [];
  let writes = 0;
  const result = await closeReferenceResources(['browser', 'database'].map(name => ({
    name, timeout: 10, close: async () => { closed.push(name); },
  })), () => { writes++; return new Promise(() => {}); }, { checkpointTimeout: 10 });
  assert.deepEqual(closed, ['browser', 'database']);
  assert.equal(writes, 1, 'Do not start more writes after persistence has stalled.');
  assert.ok(result.every(outcome => outcome.phase === 'closed' && outcome.progressPersistenceFailed));
});

test('an owned acquisition resolving after expiration is immediately disposed', async () => {
  let resolve, expired = false;
  const closed = [];
  const pending = acquireReferenceResource(() => new Promise(done => { resolve = done; }), {
    isClosed: () => expired,
    dispose: async resource => { closed.push(resource); },
    timeout: 10,
  });
  expired = true;
  const resource = { owned: true };
  resolve(resource);
  await assert.rejects(pending, /arrived after workflow closure and was closed/);
  assert.deepEqual(closed, [resource]);
  await assert.rejects(acquireReferenceResource(() => assert.fail('Must not start another acquisition.'), {
    isClosed: () => expired, dispose: async () => {},
  }), /started after workflow closure/);
});

test('cleanup persists progress before a stuck close and continues with owned fallback and other resources', async () => {
  const events = [];
  const result = await closeReferenceResources([
    { name: 'browser', timeout: 10, close: () => { events.push('close'); return new Promise(() => {}); }, force: async () => { events.push('force-owned-browser'); } },
    { name: 'database', timeout: 10, close: async () => { events.push('close-database'); } },
  ], async outcomes => events.push(outcomes.at(-1).resource + ':' + outcomes.at(-1).phase));
  assert.equal(events[0], 'browser:closing');
  assert.ok(events.indexOf('browser:graceful-close-failed') < events.indexOf('force-owned-browser'));
  assert.deepEqual(result, [{ resource: 'browser', phase: 'force-closed' }, { resource: 'database', phase: 'closed' }]);
});
