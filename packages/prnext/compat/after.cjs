'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

function after(task) {
  const context = require('./headers.cjs').currentRequest();
  if (require('./data-cache.cjs').inCacheScope()) throw new Error('after() cannot be registered inside a cache scope');
  if (!context.afterScope || !['route', 'action', 'after'].includes(context.phase)) throw new Error('after() currently requires a Node Route Handler or Server Action in PRNext. Server Component and Edge after() lifecycles are not implemented.');
  context.afterScope.add(task, context, AsyncLocalStorage.snapshot());
}

function createAfterScope({ signal, timeoutMs = 25000, onTimeout = () => {}, onComplete, report = error => console.error('[prnext] after() failed:', error?.stack || error) } = {}) {
  const queue = []; let count = 0, closed = false, finishing;
  const deadline = Date.now() + timeoutMs;
  const track = promise => signal?.[Symbol.for('prnext.request-work')]?.(promise, { timeoutMs: Math.max(1, deadline - Date.now()) });
  const observe = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
  const scope = {
    add(task, context, run) {
      if (closed) throw new Error('after() request has already completed');
      if (typeof task !== 'function' && (!task || typeof task.then !== 'function')) throw new TypeError('after() expects a callback or a Promise');
      if (++count > 128) throw new Error('after() exceeds 128 tasks per request');
      const pending = typeof task === 'function' ? null : observe(task);
      if (pending) track(pending);
      queue.push({ task: pending ? null : task, pending, context, run });
    },
    finish() {
      return finishing ||= (async () => {
        try {
          while (queue.length) {
            const item = queue.shift(), remaining = deadline - Date.now();
            if (remaining <= 0) { const error = new Error('after() exceeded the request maxDuration'); report(error); onTimeout(error); break; }
            const abort = new AbortController();
            item.context.cookies._mutable = false;
            item.context.phase = 'after';
            item.context.signal = abort.signal;
            item.context.cacheState.closed = false;
            const work = item.pending || observe(Promise.resolve().then(() => item.run(item.task)));
            track(work);
            let timer;
            try {
              const outcome = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => { const error = new Error('after() exceeded the request maxDuration'); abort.abort(error); resolve({ error }); }, remaining); })]);
              if ('error' in outcome) report(outcome.error);
              if (abort.signal.aborted) { onTimeout(outcome.error); break; }
            } finally { clearTimeout(timer); item.context.cacheState.closed = true; await onComplete?.(item.context); }
          }
        } finally { closed = true; queue.length = 0; }
      })();
    },
  };
  return scope;
}
module.exports = { after, createAfterScope };
