import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { globalErrorFixture } from './global-error-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => {
  fixture = await globalErrorFixture();
  await fixture.build();
  server = await startServer(fixture.root, ['--workers', '1']);
});
beforeEach(() => {
  Object.assign(fixture.state, { rootFailure: false, pageFailure: false, ssrClientFailure: false });
  fixture.counts.clear();
});
after(async () => { await server?.close(); await fixture?.remove(); });

function embeddedFlight(html) {
  const chunks = [...html.matchAll(/__RUSTYX_FLIGHT_STREAM__\|\|=\[\]\)\.push\("([A-Za-z0-9+/=]+)"\)/g)];
  if (chunks.length) return Buffer.concat(chunks.map(match => Buffer.from(match[1], 'base64'))).toString();
  const legacy = html.match(/<script\b[^>]*\bid="__RUSTYX_FLIGHT__"[^>]*>([A-Za-z0-9+/=]+)<\/script>/);
  assert.ok(legacy, 'the error document retains the original Flight bootstrap');
  return Buffer.from(legacy[1], 'base64').toString();
}

function assertPrivate(html, flight = embeddedFlight(html)) {
  assert.doesNotMatch(html, /PRIVATE_(?:ROOT|PAGE|LOCAL|LATE|INSTANT)_SERVER_ERROR|CLIENT_SSR_FAILURE/);
  assert.doesNotMatch(flight, /PRIVATE_(?:ROOT|PAGE|LOCAL|LATE|INSTANT)_SERVER_ERROR|CLIENT_SSR_FAILURE/);
  return flight;
}

function assertFlightError(flight) {
  assert.match(flight, /"tree":/, 'the original component tree is sent to React');
  const errors = [...flight.matchAll(/^[\da-f]+:E(\{[^\n]*\})$/gm)].map(match => JSON.parse(match[1]));
  assert.ok(errors.some(error => typeof error.digest === 'string' && error.digest.length > 0), 'the Flight error keeps its production digest');
  for (const error of errors) {
    assert.equal(error.stack, undefined, 'production Flight does not publish a server stack');
    assert.equal(error.env, undefined, 'production Flight does not publish server debugging metadata');
  }
}

function assertEmptyErrorDocument(html) {
  assert.match(html, /<html\b[^>]*\bid="__rustyx_error__"/);
  assert.match(html, /<title>Normal document<\/title>/);
  assert.match(html, /<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="noindex")[^>]*>/);
  assert.match(html, /<meta\b[^>]*\bchar[Ss]et="utf-8"/);
  assert.match(html, /<meta\b[^>]*\bname="viewport"/);
  assert.doesNotMatch(html, /<link\b[^>]*\b(?:rel="stylesheet"|as="style")/);
  assert.doesNotMatch(html, /<style\b|data-root-layout="yes"|data-global-document="yes"|data-testid="(?:normal-shell|global-heading|local-error)"/);
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1];
  assert.notEqual(body, undefined, 'the recovery response is a complete HTML document');
  assert.equal(body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim(), '', 'only bootstrap scripts occupy the error document body');
}

async function get(route, options = {}) {
  return fetch(`${server.url}/docs${route}`, { ...options, headers: { 'accept-encoding': 'identity', ...options.headers } });
}

for (const [label, route, counter, failure] of [
  ['root layout', '/', 'root', 'rootFailure'],
  ['unhandled page', '/unhandled', 'unhandled', 'pageFailure'],
  ['page with a local error.js', '/local', 'local', 'pageFailure'],
]) {
  test(`an early ${label} failure sends an empty 500 document without replaying Server Components`, { timeout: 10000 }, async () => {
    fixture.state[failure] = true;
    const response = await get(route);
    assert.equal(response.status, 500);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assertEmptyErrorDocument(html);
    assertFlightError(assertPrivate(html));
    assert.equal(fixture.counts.get('root'), 1, 'root layout executes once');
    assert.equal(fixture.counts.get(counter), 1, 'the failing component executes once');
  });
}

test('a late Server Component failure preserves the streamed 200 loading shell without rendering fallback HTML', { timeout: 10000 }, async () => {
  fixture.state.pageFailure = true;
  const release = fixture.hold('late');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('The loading shell did not arrive before the server gate opened')), 5000);
  let reader;
  try {
    const response = await get('/late', { signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const chunks = [];
    let html = '';
    while (!html.includes('data-testid="late-loading"')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'the loading shell arrives while the component remains suspended');
      chunks.push(Buffer.from(value));
      html = Buffer.concat(chunks).toString();
      assert.ok(html.length < 1024 * 1024, 'the unfinished shell stays bounded');
    }
    assert.match(html, /data-root-layout="yes"/);
    assert.match(html, /Waiting for server/);
    assert.doesNotMatch(html, /data-global-document="yes"|data-testid="(?:global-heading|local-error)"/);
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    html = Buffer.concat(chunks).toString();
    assert.doesNotMatch(html, /data-global-document="yes"|data-testid="(?:global-heading|local-error)"/);
    assertFlightError(assertPrivate(html));
    assert.equal(fixture.counts.get('root'), 1);
    assert.equal(fixture.counts.get('late'), 1);
  } finally {
    clearTimeout(timeout);
    release();
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
});

test('an immediate Server Component failure under loading.js keeps the valid Suspense shell at HTTP 200', { timeout: 10000 }, async () => {
  const instant = await globalErrorFixture();
  let instantServer;
  try {
    // A synchronous layout ensures the page error is known in the very first
    // Flight batch, before its status is handed to the HTML renderer.
    await instant.write('app/layout.jsx', `import Shell from'./shell';import'./normal.css';export const dynamic='force-dynamic';let renders=0;export default function Layout({children}){return <html data-root-layout="yes" data-root-renders={++renders}><head/><body className="normal-theme"><Shell>{children}</Shell></body></html>}`);
    await instant.build();
    instantServer = await startServer(instant.root, ['--workers', '1']);
    const response = await fetch(`${instantServer.url}/docs/instant`, { headers: { 'accept-encoding': 'identity' } });
    const html = await response.text();
    assert.match(html, /data-root-layout="yes"/);
    assert.match(html, /data-testid="normal-shell"/);
    assert.match(html, /data-testid="instant-loading">Immediate failure loading shell/);
    assert.doesNotMatch(html, /id="__rustyx_error__"|data-global-document="yes"|data-testid="(?:global-heading|local-error)"/);
    assertFlightError(assertPrivate(html));
    assert.match(html, /data-root-renders="1"/, 'recovering inside Suspense does not replay the root layout');
    assert.equal(response.status, 200, 'an encoded Flight error does not turn a valid Suspense shell into an HTTP 500');
  } finally { await instantServer?.close(); await instant.remove(); }
});

test('a direct Flight request keeps the rejected tree and digest without executing a second render', { timeout: 10000 }, async () => {
  fixture.state.pageFailure = true;
  const response = await get('/local', { headers: { RSC: '1' } });
  assert.match(response.headers.get('content-type'), /^text\/x-component/);
  const flight = await response.text();
  assertFlightError(assertPrivate('', flight));
  assert.doesNotMatch(flight, /<html\b/);
  assert.equal(fixture.counts.get('root'), 1);
  assert.equal(fixture.counts.get('local'), 1);
});

test('an SSR Client Component failure stays private and leaves the worker able to render the next request', { timeout: 10000 }, async () => {
  fixture.state.ssrClientFailure = true;
  const response = await get('/');
  assert.equal(response.status, 500);
  const html = await response.text();
  assertEmptyErrorDocument(html);
  assertPrivate(html);
  assert.equal(fixture.counts.get('root'), 1, 'SSR failure does not repeat the Server Component phase');

  fixture.state.ssrClientFailure = false;
  const recovered = await get('/');
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /data-testid="healthy-heading">Healthy home/);
  assert.equal(fixture.counts.get('root'), 2);
});
