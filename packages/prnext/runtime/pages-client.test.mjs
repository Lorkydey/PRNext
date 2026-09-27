import test from 'node:test';
import assert from 'node:assert/strict';
import { pageDataURL, readPageDataResponse } from './pages-client.mjs';
import { flightResponseURL, pageDataRedirectURL, publicNavigationURL, isApplicationURL } from './client-navigation.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Link from '../compat/link.cjs';
import { RouterProvider, formatUrl } from '../compat/router.cjs';
import { AppRouterProvider } from '../compat/app-context.cjs';

test('base paths apply only to logical navigation and keep data on the application origin', () => {
  const base = 'https://example.test/docs/current?old=one';
  assert.equal(publicNavigationURL('/next?value=one#part', base, '/docs').href, 'https://example.test/docs/next?value=one#part');
  assert.equal(publicNavigationURL('/?root=one#part', base, '/docs').href, 'https://example.test/docs?root=one#part');
  assert.equal(publicNavigationURL('/docs/next', base, '/docs').pathname, '/docs/docs/next');
  assert.equal(publicNavigationURL('#part', base, '/docs').href, `${base}#part`);
  assert.equal(publicNavigationURL('https://example.test/docs/next', base, '/docs').pathname, '/docs/next');
  assert.equal(publicNavigationURL(new URL(base), base, '/docs').href, base);
  assert.equal(publicNavigationURL('//cdn.test/outside', base, '/docs').origin, 'https://cdn.test');
  assert.equal(isApplicationURL(new URL('https://example.test/docs-next'), 'https://example.test', '/docs'), false);
  assert.equal(pageDataURL('build', `${base}#part`, '/docs'), 'https://example.test/docs/_prnext/data/build/current.json?old=one');
  assert.equal(pageDataURL('build', 'https://example.test/docs/index/nested', '/docs'), 'https://example.test/docs/_prnext/data/build/index/index/nested.json');
});

test('Pages and App SSR links use provider basePath while absolute external URLs remain untouched', () => {
  for (const Provider of [RouterProvider, AppRouterProvider]) {
    const markup = renderToStaticMarkup(React.createElement(Provider, { router: { pathname: '/', basePath: '/docs' } },
      React.createElement(React.Fragment, null,
        React.createElement(Link, { href: '/hello?from=link' }, 'Local'),
        React.createElement(Link, { href: '/' }, 'Home'),
        React.createElement(Link, { href: { protocol: 'https', hostname: 'object.test', pathname: '/outside', query: { from: 'object' } } }, 'Absolute object'),
        React.createElement(Link, { href: 'https://external.test/path' }, 'External'))));
    assert.match(markup, /href="\/docs\/hello\?from=link"/);
    assert.match(markup, /href="\/docs"/);
    assert.match(markup, /href="https:\/\/external.test\/path"/);
    assert.match(markup, /href="https:\/\/object.test\/outside\?from=object"/);
  }
});

test('URL objects retain their absolute origin and interpolate parameters without folding hosts into basePath', () => {
  assert.equal(formatUrl({ protocol: 'https', hostname: 'example.test', port: 8443, pathname: '/docs/post/[id]', query: { id: 'book', tag: ['a', 'b'] } }),
    'https://example.test:8443/docs/post/book?tag=a&tag=b');
  assert.equal(formatUrl({ protocol: 'http:', hostname: '::1', port: '8080', pathname: 'hello' }), 'http://[::1]:8080/hello');
  assert.equal(formatUrl({ host: 'example.test', pathname: '/path', search: '?literal=one#two' }), '//example.test/path?literal=one%23two');
  assert.equal(formatUrl({ pathname: '/post/[id]', query: 'id=book&from=query' }), '/post/book?from=query');
});

test('fallback data URLs preserve encoded paths and rewrite queries, omit fragments, and distinguish literal index routes', () => {
  const expected = new Map([
    ['/', '/index.json'],
    ['/?query=one#hash', '/index.json?query=one'],
    ['/index', '/index/index.json'],
    ['/index/nested/', '/index/index/nested.json'],
    ['/%69ndex', '/index/%69ndex.json'],
    ['/%69ndex/nested', '/index/%69ndex/nested.json'],
    ['/indexed', '/indexed.json'],
    ['/blog/caf%C3%A9?from=query#hash', '/blog/caf%C3%A9.json?from=query'],
    ['/docs/one/two/', '/docs/one/two.json'],
  ]);
  for (const [pathname, suffix] of expected) {
    assert.equal(pageDataURL('build-id', `https://example.test${pathname}`), `https://example.test/_prnext/data/build-id${suffix}`);
  }
  assert.throws(() => pageDataURL(undefined, 'https://example.test/'), /build ID/);
});

test('App navigation commits same-origin final redirect URLs and rejects foreign Flight before decoding', () => {
  assert.equal(flightResponseURL({ url: 'https://example.test/static?redirect=middleware' }, 'https://example.test/mw/redirect#section').href,
    'https://example.test/static?redirect=middleware#section');
  assert.equal(flightResponseURL({ url: 'https://example.test/static#destination' }, 'https://example.test/source#old').hash, '#destination');
  assert.equal(flightResponseURL({ url: '' }, 'https://example.test/mw/static?visible=visitor').href,
    'https://example.test/mw/static?visible=visitor');
  assert.throws(() => flightResponseURL({ url: 'https://foreign.test/flight' }, 'https://example.test/source'), /Cross-origin/);
  assert.throws(() => flightResponseURL({ url: 'javascript:alert(1)' }, 'https://example.test/source'), /Unsupported navigation/);
});

test('Pages data middleware redirects bypass JSON decoding and release the response body', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('not page JSON')); },
    cancel() { canceled = true; },
  }), { status: 307, headers: { 'x-nextjs-redirect': '/destination?from=middleware#section' } });
  assert.deepEqual(await readPageDataResponse(response, 'https://example.test/fallback/one?visible=visitor'), {
    redirect: 'https://example.test/destination?from=middleware#section',
  });
  assert.equal(canceled, true);
  assert.equal(pageDataRedirectURL(new Response(null, { status: 307, headers: { location: '/docs/redirected' } }), 'https://example.test/docs/old').href, 'https://example.test/docs/redirected');
  assert.equal(pageDataRedirectURL(new Response(null, { status: 201, headers: { location: '/docs/created' } }), 'https://example.test/docs/old'), null);
  assert.equal(pageDataRedirectURL(new Response(null, { headers: { 'x-nextjs-redirect': 'https://external.test/target' } }), 'https://example.test/').href,
    'https://external.test/target', 'external redirects use document navigation rather than a Flight fetch');
  await assert.rejects(readPageDataResponse(new Response('ignored', { headers: { 'x-nextjs-redirect': 'javascript:alert(1)' } }), 'https://example.test/'), /Unsupported navigation/);
});

test('Pages data rewrites retain destination metadata separately from props and handle failed data normally', async () => {
  const data = { pageProps: { value: 1 }, __PRNEXT_ROUTER__: { pathname: '/fallback/[id]', isFallback: false } };
  const rewrite = { url: '/fallback/one?dest=middleware', params: { id: 'one' } };
  const response = Response.json(data, { headers: { 'x-prnext-rewrite': encodeURIComponent(JSON.stringify(rewrite)) } });
  assert.deepEqual(await readPageDataResponse(response, 'https://example.test/mw/one?visible=visitor'), { data, rewrite });
  await assert.rejects(readPageDataResponse(new Response('<html>stale build</html>', { status: 404, headers: { 'content-type': 'text/html' } }), 'https://example.test/'), /Invalid page data/);
  await assert.rejects(readPageDataResponse(new Response('unavailable', { status: 503 }), 'https://example.test/'), /failed \(503\)/);
});

test('legacy middleware probes discard arbitrary bodies and never cache their content', async () => {
  const rewrite = { url: '/legacy/book?from=middleware', params: { slug: 'book' } };
  for (const [body, status, type] of [
    ['server ended', 202, 'text/plain'], ['{broken', 200, 'application/json'],
    ['{"notFound":true,"pageProps":{"__N_REDIRECT":"/wrong"}}', 200, 'application/json'],
    [null, 204, undefined],
  ]) {
    const headers = { 'x-prnext-legacy-navigation': '1', 'x-prnext-rewrite': encodeURIComponent(JSON.stringify(rewrite)) };
    if (type) headers['content-type'] = type;
    const result = await readPageDataResponse(new Response(body, { status, headers }), 'https://example.test/alias', { includeBytes: true });
    assert.deepEqual(result, { data: null, legacy: true, rewrite, bytes: Buffer.byteLength(body || ''), cacheable: false });
  }
  await assert.rejects(readPageDataResponse(new Response(null, { status: 204 }), 'https://example.test/'), /Invalid page data/);
  for (const status of [404, 500]) {
    await assert.rejects(readPageDataResponse(Response.json({ notFound: true }, { status, headers: { 'x-prnext-legacy-navigation': '1' } }),
      'https://example.test/'), new RegExp(`failed \\(${status}\\)`));
  }
});

test('discarded legacy bodies still enforce byte limits and cancel on abort', async () => {
  let canceled = 0;
  const response = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { canceled++; },
  }), { headers: { 'x-prnext-legacy-navigation': '1' } });
  await assert.rejects(readPageDataResponse(response(), 'https://example.test/', { maxBytes: 12 }), /response limit/);
  assert.equal(canceled, 1);
  const abort = new AbortController();
  const pending = new Response(new ReadableStream({ cancel() { canceled++; } }), { headers: { 'x-prnext-legacy-navigation': '1' } });
  const result = readPageDataResponse(pending, 'https://example.test/', { signal: abort.signal });
  abort.abort(new Error('navigation superseded'));
  await assert.rejects(result, /navigation superseded/);
  assert.equal(canceled, 2);
  assert.equal(pending.body.locked, false);
});

test('legacy Location follows the actual response URL and retains only final rewrite metadata', async () => {
  const intermediate = { url: '/legacy/old', params: {} }, final = { url: '/legacy/final?from=last', params: {} };
  for (const lastRewrite of [undefined, final]) {
    let canceled = false;
    const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: {
      'x-prnext-legacy-navigation': '1', 'x-prnext-legacy-location': '../destination?from=redirect',
      'x-prnext-rewrite': encodeURIComponent(JSON.stringify(intermediate)),
    } });
    Object.defineProperty(response, 'url', { value: 'https://example.test/docs/_prnext/data/build/legacy/probe.json' });
    const abort = new AbortController();
    const result = await readPageDataResponse(response, 'https://example.test/docs/visible', {
      signal: abort.signal,
      async fetcher(url, options) {
        assert.equal(canceled, true);
        assert.equal(url, 'https://example.test/docs/_prnext/data/build/destination?from=redirect');
        assert.equal(options.signal, abort.signal); assert.equal(options.redirect, 'follow');
        assert.equal(options.credentials, 'same-origin'); assert.equal(options.headers['x-nextjs-data'], '1');
        return new Response('<html>final rendered page</html>', { headers: lastRewrite
          ? { 'x-prnext-rewrite': encodeURIComponent(JSON.stringify(lastRewrite)) } : {} });
      },
    });
    assert.deepEqual(result, { data: null, legacy: true, rewrite: lastRewrite });
  }
});

test('legacy redirect probes reject unsafe protocols, final errors and excessive chains', async () => {
  const response = location => new Response(null, { headers: {
    'x-prnext-legacy-navigation': '1', 'x-prnext-legacy-location': location,
  } });
  await assert.rejects(readPageDataResponse(response('javascript:alert(1)'), 'https://example.test/'), /Unsupported navigation/);
  await assert.rejects(readPageDataResponse(response('/target'), 'https://example.test/', {
    fetcher: async () => new Response('failed', { status: 503 }),
  }), /failed \(503\)/);
  assert.deepEqual(await readPageDataResponse(response('/step'), 'https://example.test/', {
    fetcher: async () => new Response(null, { status: 307, headers: { 'x-nextjs-redirect': '/done' } }),
  }), { redirect: 'https://example.test/done' });
  let calls = 0;
  await assert.rejects(readPageDataResponse(response('/loop'), 'https://example.test/', {
    fetcher: async () => { calls++; return response('/loop'); },
  }), /Too many legacy page redirects/);
  assert.equal(calls, 20);
  const abort = new AbortController(); abort.abort(new Error('stopped'));
  await assert.rejects(readPageDataResponse(response('/target'), 'https://example.test/', {
    signal: abort.signal, fetcher: () => assert.fail('must not fetch after cancellation'),
  }), /stopped/);
});
