import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, createAfterScope } from '../compat/after.cjs';
import { headers, cookies, currentRequest, runRequestContext } from '../compat/headers.cjs';
import { withCacheRequest } from './cache-request.mjs';
import { revalidateTag, revalidatePath } from '../compat/cache.cjs';

test('after preserves request isolation, nesting and readonly cookies after response', async () => {
  const results = [], finalizers = [];
  await Promise.all(['alice', 'bob'].map(name => withCacheRequest({ headers: { cookie: `user=${name}` }, route: { router: 'app' } }, 'route', async context => {
    after(async () => {
      await delay(name === 'alice' ? 10 : 1);
      results.push((await cookies()).get('user').value);
      assert.equal((await headers()).get('cookie'), `user=${name}`);
      assert.throws(() => context.cookies.set('late', 'no'), /cookie/i);
      after(() => results.push(`${name}-nested`));
    });
    return { status: 200, body: 'ok' };
  }).then(result => finalizers.push(result.finalizeCache))));
  assert.deepEqual(results, []);
  await Promise.all(finalizers.map(finish => finish()));
  assert.deepEqual(results.sort(), ['alice', 'alice-nested', 'bob', 'bob-nested']);
  await Promise.all(finalizers.map(finish => finish()));
  assert.equal(results.length, 4);
});

test('after error work is deferred to transport and survives disconnect', async () => {
  const abort = new AbortController(), finalizers = [], values = [];
  await assert.rejects(withCacheRequest({ signal: abort.signal, deferFinalizer: fn => finalizers.push(fn), route: { router: 'app' } }, 'route', async () => {
    after(() => values.push(currentRequest().signal.aborted));
    abort.abort();
    throw new Error('handler failed');
  }), /handler failed/);
  assert.deepEqual(values, []);
  await finalizers[0]();
  assert.deepEqual(values, [false]);
});

test('after observes promises, reports failures, bounds work and closes its scope', async () => {
  const errors = [], tracked = [];
  const signal = new AbortController().signal;
  signal[Symbol.for('prnext.request-work')] = (work, options) => tracked.push({ work, options });
  const scope = createAfterScope({ signal, timeoutMs: 1000, report: error => errors.push(error) });
  let late;
  await runRequestContext({ phase: 'route', afterScope: scope }, async () => {
    after(Promise.reject(new Error('promise failed')));
    after(() => { throw new Error('callback failed'); });
    for (let i = 0; i < 126; i++) after(() => {});
    assert.throws(() => after(() => {}), /128 tasks/);
    late = () => after(() => {});
    await scope.finish();
    assert.throws(late, /completed/);
  });
  assert.deepEqual(errors.map(e => e.message), ['promise failed', 'callback failed']);
  assert.ok(tracked.length >= 128);
  assert.ok(tracked.every(item => item.options.timeoutMs > 0 && item.options.timeoutMs <= 1000));
});

test('after bounds an abandoned task and explicitly rejects unsupported lifecycles', async () => {
  const errors = [];
  const scope = createAfterScope({ timeoutMs: 20, report: error => errors.push(error) });
  await runRequestContext({ phase: 'route', afterScope: scope }, async () => {
    after(() => new Promise(() => {}));
    await scope.finish();
    assert.equal(currentRequest().signal.aborted, true);
    assert.equal(currentRequest().cacheState.closed, true);
  });
  assert.match(errors[0].message, /maxDuration/);
  assert.throws(() => runRequestContext({ phase: 'render' }, () => after(() => {})), /requires a Node Route Handler/);
});

test('after reports its current cache invalidation limitation instead of silently ignoring it', async () => {
  const errors=[];
  const scope=createAfterScope({report:error=>errors.push(error)});
  await runRequestContext({phase:'route',afterScope:scope},async()=>{
    after(()=>revalidateTag('alpha-limit','max'));
    after(()=>revalidatePath('/alpha-limit'));
    await scope.finish();
  });
  assert.equal(errors.length,2);
  for(const error of errors) assert.match(error.message,/only be called in a Server Action or Route Handler/);
});
