import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { supersedableDevelopmentFlight, developmentFlightRoot } from './development-flight.mjs';
import { createFlightTransport } from '../compat/flight-delta.cjs';
import { installFlightModuleLoader } from './app-client.mjs';

const require = createRequire(import.meta.url);
// Exercise the same installed browser Flight client used by app-client, with
// protocol-only bytes: no application module, native process, socket or browser.
installFlightModuleLoader({});
const { createFromReadableStream } = require('react-server-dom-webpack/client.browser');
const bytes = value => new TextEncoder().encode(value);

test('owned supersession halts unresolved rows without rejecting an already decoded root', async () => {
  const abort = new AbortController(); let cancelled = 0, eof = 0;
  const source = new ReadableStream({
    start(controller) { controller.enqueue(bytes('0:{"ready":"received","pending":"$@1"}\n')); },
    cancel() { cancelled++; },
  });
  const transport = createFlightTransport();
  const response = await transport.response(new Response(source), undefined, { onEnd() { eof++; } });
  const model = await createFromReadableStream(supersedableDevelopmentFlight(response.body, abort.signal), { unstable_allowPartialStream: true });
  assert.equal(model.ready, 'received');
  let settled = 0;
  model.pending.then(() => settled++, () => settled++);
  abort.abort(new DOMException('Newer navigation', 'AbortError'));
  await delay(10);
  assert.equal(settled, 0);
  assert.equal(model.ready, 'received');
  assert.equal(cancelled, 1);
  assert.equal(eof, 0, 'synthetic decoder close must not qualify genuine transport EOF');
  assert.equal(transport.snapshot(), undefined);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('genuine read failures still reject unresolved Flight rows', async () => {
  const abort = new AbortController(); let source;
  const stream = new ReadableStream({ start(controller) { source = controller; controller.enqueue(bytes('0:{"pending":"$@1"}\n')); } });
  const model = await createFromReadableStream(supersedableDevelopmentFlight(stream, abort.signal), { unstable_allowPartialStream: true });
  const rejected = assert.rejects(Promise.resolve(model.pending), /genuine read failure/);
  source.error(new Error('genuine read failure'));
  await rejected;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('a supersession before the first pull cancels exactly once', async () => {
  const abort = new AbortController(); let cancelled = 0;
  const source = new ReadableStream({ cancel() { cancelled++; } });
  abort.abort();
  const reader = supersedableDevelopmentFlight(source, abort.signal).getReader();
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  await delay(0);
  assert.equal(cancelled, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);

});

test('genuine EOF preserves received rows and rejects missing rows without owned supersession', async () => {
  const complete = new AbortController(); let eof = 0;
  const transport = createFlightTransport();
  const received = await transport.response(new Response(new ReadableStream({
    start(value) { value.enqueue(bytes('0:{"ready":true,"pending":"$@1"}\n')); value.close(); },
  })), undefined, { onEnd() { eof++; } });
  const model = await createFromReadableStream(supersedableDevelopmentFlight(received.body, complete.signal), { unstable_allowPartialStream: true });
  assert.equal(model.ready, true);
  await assert.rejects(Promise.resolve(model.pending), /Connection closed/);
  assert.equal(eof, 1);
  assert.equal(getEventListeners(complete.signal, 'abort').length, 0);

  const full = new AbortController();
  const root = await createFromReadableStream(supersedableDevelopmentFlight(new ReadableStream({
    start(value) { value.enqueue(bytes('0:{"ready":true}\n')); value.close(); },
  }), full.signal), { unstable_allowPartialStream: true });
  assert.equal(root.ready, true);
  await delay(0);
  assert.equal(getEventListeners(full.signal, 'abort').length, 0);
});

test('owned supersession before the root row resolves rejects the navigation wait', async () => {
  const abort = new AbortController(); let cancelled = 0;
  const source = new ReadableStream({ cancel() { cancelled++; } });
  const root = createFromReadableStream(supersedableDevelopmentFlight(source, abort.signal), { unstable_allowPartialStream: true });
  const waiting = developmentFlightRoot(root, abort.signal);
  const rejected = assert.rejects(waiting, /newest route/);
  abort.abort(new DOMException('newest route', 'AbortError'));
  await rejected;
  await delay(0);
  assert.equal(cancelled, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});
