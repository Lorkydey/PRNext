import { createHash } from 'node:crypto';

// Browser lifecycle evidence only. Never retain cookies, form payloads, query
// strings or unhashed action IDs. Complete HTTP replays and DOM/SQL assertions
// are separate checks; ERR_ABORTED alone is never proof of a successful action.
export function createActionNetworkRecorder(origin, { limit = 256 } = {}) {
  const records = [], active = new Map(), known = new WeakMap();
  let overflow = false;
  function terminal(request, state, failure = null) {
    const entry = known.get(request);
    if (!entry) return;
    Object.assign(entry.record, {
      terminal: state,
      failure: failure && /^[A-Za-z0-9_: .-]{1,128}$/.test(failure) ? failure : failure ? 'unclassified network failure' : null,
      durationMs: Math.round((performance.now() - entry.started) * 100) / 100,
    });
    active.delete(request);
  }
  function observeContext(context) {
    const requests = new Set();
    context.on('page', page => {
      page.on('request', request => {
        const action = request.headers()['next-action'];
        if (request.method() !== 'POST' || !action || new URL(request.url()).origin !== origin) return;
        if (records.length >= limit) { overflow = true; return; }
        const record = {
          route: new URL(request.url()).pathname,
          actionSha256: createHash('sha256').update(action).digest('hex'),
          status: null, contentType: null, terminal: 'pending', failure: null, durationMs: null,
        };
        const entry = { record, started: performance.now() };
        records.push(record); known.set(request, entry); active.set(request, entry); requests.add(request);
      });
      page.on('response', response => {
        const entry = known.get(response.request());
        if (!entry) return;
        entry.record.status = response.status();
        entry.record.contentType = (response.headers()['content-type'] || '').split(';')[0];
      });
      page.on('requestfinished', request => { terminal(request, 'finished'); requests.delete(request); });
      page.on('requestfailed', request => { terminal(request, 'failed', request.failure()?.errorText); requests.delete(request); });
    });
    context.on('close', () => {
      for (const request of requests) terminal(request, 'context-closed');
      requests.clear();
    });
  }
  return {
    records, observeContext,
    assertComplete() {
      if (overflow) throw new Error('Reference browser action metrics exceeded their bounded capacity.');
      if (active.size) throw new Error('Reference browser actions have no terminal lifecycle evidence.');
    },
  };
}
