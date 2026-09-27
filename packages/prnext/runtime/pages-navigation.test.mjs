import test from 'node:test';
import assert from 'node:assert/strict';
import { abortable, createPagesNavigation, matchPagePattern, resolvePageRoute } from './pages-navigation.mjs';
import { readPageDataResponse } from './pages-client.mjs';
import DefaultError from '../compat/error.cjs';
import DefaultApp from '../compat/app.cjs';

function fixture({ routes = [], errors, readData, importModule, onCommit, needsServerRouting = true, initial = {}, basePath = '', assetBase = `${basePath}/_prnext/assets`, manifestUrl = `${assetBase}/manifest.json` } = {}) {
  const events = [], commits = [], listeners = new Map(), dataCalls = [], assets = [], assetRequests = [], documents = [];
  const location = url => Object.assign(new URL(url), {
    assign(target) { documents.push({ target, replace: false }); }, replace(target) { documents.push({ target, replace: true }); },
  });
  const win = { location: location(`http://example.test${basePath}/`), scrollX: 0, scrollY: 0,
    addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); },
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  win.history = { state: {}, replaceState(state, _, url) { this.state = state; win.location = location(url); },
    pushState(state, _, url) { this.state = state; win.location = location(url); } };
  const allRoutes = [{ pattern: '/', client: `${assetBase}/home.js`, css: [] }, ...routes.map(route => ({ css: [], ...route }))];
  const map = { buildId: 'build', routes: allRoutes, nonPagesRoutes: [], needsServerRouting, errors };
  const Page = () => null;
  const controller = createPagesNavigation({ window: win, document: { querySelectorAll: () => [], getElementById: () => null, getElementsByName: () => [] },
    initial: { buildId: 'build', Page, props: {}, router: { pathname: '/', query: {}, asPath: '/' }, ...initial },
    initialRoute: allRoutes[0], manifestUrl, basePath, assetBase,
    events: { emit: (...args) => events.push(args) }, commit: async state => { commits.push(state); await onCommit?.(state, controller); },
    importModule: importModule || (async () => ({ Page })),
    fetch: async (url, options) => { assets.push(url); assetRequests.push({ url, ...options }); return url.endsWith('manifest.json') ? Response.json(map) : new Response('export const Page=()=>null'); },
    readData: async (url, signal, options) => {
      dataCalls.push({ url: url.href, speculative: options.speculative });
      if (readData) return readData(url, signal, options);
      const matched = resolvePageRoute(map, basePath ? url.pathname.slice(basePath.length) || '/' : url.pathname);
      return { data: { pageProps: { path: url.pathname }, __PRNEXT_ROUTER__: { pathname: matched.route.pattern, query: matched.params } }, bytes: 100, cacheable: true };
    },
  });
  return { controller, win, events, commits, listeners, dataCalls, assets, assetRequests, documents };
}

test('Pages keep logical snapshots and public history/data while explicitly allowing a configured asset CDN', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const assetBase = 'https://cdn.test/site/_prnext/assets', imports = [];
  const f = fixture({ basePath: '/docs', assetBase, routes: [{ pattern: '/posts/[id]', client: `${assetBase}/posts.js`, ssg: true }],
    importModule: async url => { imports.push(url); return { Page: () => null }; } });
  try {
    await f.controller.prefetch('/posts/[id]', '/posts/book?visible=as');
    await f.controller.navigate('/posts/[id]', '/posts/book?visible=as');
    assert.equal(f.dataCalls[0].url, 'http://example.test/docs/posts/book');
    assert.equal(f.win.location.href, 'http://example.test/docs/posts/book?visible=as');
    assert.equal(f.controller.snapshot().pathname, '/posts/[id]');
    assert.equal(f.controller.snapshot().asPath, '/posts/book?visible=as');
    assert.equal(f.controller.snapshot().basePath, '/docs');
    assert.deepEqual(imports, [`${assetBase}/posts.js`]);
    assert.ok(f.assetRequests.every(request => request.credentials === 'omit' && request.mode === 'cors'));
    await f.controller.navigate('/posts/book?changed=one', undefined, { shallow: true });
    assert.equal(f.dataCalls.length, 1);
    assert.equal(f.controller.snapshot().asPath, '/posts/book?changed=one');
    let state;
    f.controller.beforePopState(value => { state = value; return false; });
    f.listeners.get('popstate')({ state: { __prnextPages: { url: '/docs/', as: '/docs/', options: {} } } });
    assert.equal(state.as, '/docs/');
  } finally { f.controller.dispose(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('custom404 navigation loads static error props and preserves original route metadata and App identity', async () => {
  const Page404 = () => null, App = () => null;
  const errorRoute = { pattern: '/404', client: '/docs/_prnext/assets/error404.js', css: [], ssg: true };
  const f = fixture({ basePath: '/docs', initial: { App }, errors: { notFound: errorRoute },
    routes: [{ pattern: '/fail/[mode]', client: '/docs/_prnext/assets/fail.js', ssp: true }],
    importModule: async () => ({ Page: Page404, App }),
    readData: async url => ({ data: url.pathname === '/docs/404' ? { pageProps: { label: 'generated404' } } : { notFound: true },
      ...(url.pathname === '/docs/alias-missing' ? { rewrite: { url: '/fail/missing?from=rewrite', params: { mode: 'missing' } } } : {}) }),
  });
  try {
    assert.equal(await f.controller.navigate('/fail/missing?from=visible'), true);
    assert.deepEqual(f.dataCalls.map(call => new URL(call.url).pathname), ['/docs/fail/missing', '/docs/404']);
    assert.equal(f.commits[0].Page, Page404);
    assert.equal(f.commits[0].App, App);
    assert.deepEqual(f.commits[0].props, { label: 'generated404' });
    assert.equal(f.controller.snapshot().pathname, '/fail/[mode]');
    assert.equal(f.controller.snapshot().asPath, '/fail/missing?from=visible');
    assert.deepEqual(f.controller.snapshot().query, { from: 'visible', mode: 'missing' });
    await f.controller.navigate('/alias-missing?from=visible');
    assert.equal(f.controller.snapshot().pathname, '/fail/[mode]');
    assert.equal(f.controller.snapshot().asPath, '/alias-missing?from=visible');
    assert.deepEqual(f.controller.snapshot().query, { from: 'rewrite', mode: 'missing' });
    assert.equal(f.commits.at(-1).App, App);
  } finally { f.controller.dispose(); }
});

test('notFound without404 runs _error.getInitialProps with null err and the public asPath', async () => {
  let context;
  const CustomError = Object.assign(() => null, { getInitialProps(value) { context = value; return DefaultError.getInitialProps(value); } });
  const f = fixture({ basePath: '/docs', errors: { error: { pattern: '/_error', client: '/docs/_prnext/assets/error.js', css: [] } },
    routes: [{ pattern: '/fail/[mode]', client: '/docs/_prnext/assets/fail.js', ssp: true }],
    importModule: async () => ({ Page: CustomError }), readData: async () => ({ data: { notFound: true } }) });
  try {
    await f.controller.navigate('/fail/missing?from=visible');
    assert.equal(context.err, null);
    assert.equal(context.pathname, '/_error');
    assert.equal(context.asPath, '/docs/fail/missing?from=visible');
    assert.deepEqual(context.query, { from: 'visible', mode: 'missing' });
    assert.equal(context.req, undefined); assert.equal(context.res, undefined);
    assert.equal(typeof context.AppTree, 'function');
    assert.equal(f.commits[0].props.statusCode, 404);
    assert.equal(f.dataCalls.length, 1);
  } finally { f.controller.dispose(); }
});

test('render failures use previous context during navigation and bound a failing custom error page', async () => {
  const contexts = [], App = () => null, Broken = () => null;
  const CustomError = Object.assign(() => null, { getInitialProps(context) { contexts.push(context); return DefaultError.getInitialProps(context); } });
  let errorRender;
  const f = fixture({ initial: { App }, errors: { error: { pattern: '/_error', client: '/_prnext/assets/error.js', css: [] } },
    routes: [{ pattern: '/broken', client: '/_prnext/assets/broken.js' }],
    importModule: async url => ({ Page: url.endsWith('error.js') ? CustomError : Broken, App }),
    onCommit(view, controller) { if (view.Page === Broken) errorRender = controller.reportRenderError(new Error('render failure'), view); } });
  try {
    await f.controller.navigate('/broken?from=nav');
    assert.equal(await errorRender, true);
    assert.equal(contexts[0].pathname, '/');
    assert.equal(contexts[0].asPath, '/');
    assert.equal(contexts[0].err.message, 'render failure');
    assert.equal(f.commits.at(-1).props.statusCode, undefined);
    assert.equal(f.controller.snapshot().pathname, '/broken');
    assert.equal(f.commits.at(-1).Page, CustomError);
    await f.controller.reportRenderError(new Error('custom error also broke'), f.commits.at(-1));
    assert.equal(f.commits.at(-1).Page, DefaultError);
    assert.equal(f.commits.at(-1).App, undefined);
    assert.equal(contexts.length, 1);
  } finally { f.controller.dispose(); }
});

test('a new navigation cancels an unresolved error data hook without changing the next page', async () => {
  let seen, pending;
  const started = new Promise(resolve => { seen = resolve; });
  const CustomError = Object.assign(() => null, { getInitialProps() { seen(); return new Promise(() => {}); } });
  const f = fixture({ errors: { error: { pattern: '/_error', client: '/_prnext/assets/error.js', css: [] } },
    routes: [{ pattern: '/fine', client: '/_prnext/assets/fine.js' }],
    importModule: async url => ({ Page: url.endsWith('error.js') ? CustomError : () => null }) });
  try {
    await f.controller.navigate('/fine');
    pending = f.controller.reportRenderError(new Error('late failure'), f.commits.at(-1));
    await started;
    await f.controller.navigate('/');
    assert.equal(await pending, false);
    assert.equal(f.controller.snapshot().pathname, '/');
    assert.notEqual(f.commits.at(-1).Page, CustomError);
  } finally { f.controller.dispose(); }
});

test('CDN authorization requires the configured origin and asset directory boundary', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  for (const manifestUrl of ['https://other.test/site/_prnext/assets/manifest.json', 'https://cdn.test/site/_prnext/assets-other/manifest.json']) {
    const f = fixture({ basePath: '/docs', assetBase: 'https://cdn.test/site/_prnext/assets', manifestUrl });
    try { await f.controller.prefetch('/'); assert.deepEqual(f.assets, []); }
    finally { f.controller.dispose(); }
  }
  if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
});

test('Pages matching decodes parameters and respects exact routes against App catch-alls', () => {
  assert.deepEqual({ ...matchPagePattern('/docs/[[...parts]]', '/docs').params }, {});
  assert.deepEqual({ ...matchPagePattern('/docs/[[...parts]]', '/docs/a/caf%C3%A9').params }, { parts: ['a', 'café'] });
  assert.equal(matchPagePattern('/docs/[...parts]', '/docs'), null);
  assert.equal(matchPagePattern('/docs/[part]', '/docs/%invalid'), null);
  for (const part of ['%2f', '%5c', '%00', '%2e', '%2e%2e']) assert.equal(matchPagePattern('/docs/[part]', `/docs/${part}`), null);
  const map = { routes: [{ pattern: '/account' }, { pattern: '/[slug]' }], nonPagesRoutes: [{ pattern: '/api/[...path]' }, { pattern: '/[...path]' }] };
  assert.equal(resolvePageRoute(map, '/account').route.pattern, '/account');
  assert.equal(resolvePageRoute(map, '/account').pages, true);
  assert.equal(resolvePageRoute(map, '/api/hello').pages, false);
});

test('href patterns use as path parameters but never its query, including prefetch', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const f = fixture({ routes: [{ pattern: '/posts/[id]', client: '/_prnext/assets/posts.js', ssg: true }] });
  try {
    await f.controller.prefetch('/posts/[id]?hidden=href', '/posts/book?visible=as');
    assert.equal(f.dataCalls[0].url, 'http://example.test/posts/book?hidden=href');
    await f.controller.navigate('/posts/[id]?hidden=href', '/posts/book?visible=as');
    assert.equal(f.dataCalls.length, 1);
    assert.deepEqual(f.controller.snapshot().query, { hidden: 'href', id: 'book' });
    assert.equal(f.controller.snapshot().asPath, '/posts/book?visible=as');
    assert.equal(f.commits[0].clientSnapshot, true);
    await f.controller.navigate({ pathname: '/posts/[id]', query: { id: 'object', hidden: 'kept' } }, '/posts/object?visible=ignored');
    assert.deepEqual(f.controller.snapshot().query, { hidden: 'kept', id: 'object' });
    assert.equal(f.controller.snapshot().asPath, '/posts/object?visible=ignored');
  } finally { f.controller.dispose(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('initial fallback retains App when an obsolete build data 404 cannot use the new error manifest', async () => {
  const Page = () => null, App = () => null;
  const f = fixture({ initial: { buildId: 'obsolete', Page, App, router: { pathname: '/', query: {}, asPath: '/', isFallback: true } },
    readData: async () => ({ data: { notFound: true } }), importModule: () => { throw new Error('Should use the loaded entry'); } });
  try {
    assert.equal(await f.controller.refreshFallback(), true);
    assert.equal(f.dataCalls.length, 1);
    assert.equal(f.assets.length, 1);
    assert.notEqual(f.commits[0].Page, Page);
    assert.equal(f.commits[0].props.statusCode, 404);
    assert.equal(f.commits[0].App, App);
    assert.equal(f.commits[0].notFound, true);
    assert.equal(f.controller.snapshot().isFallback, false);
  } finally { f.controller.dispose(); }
});

test('abortable operations detach cancellation even when a module promise never settles', async () => {
  const abort = new AbortController();
  const result = abortable(new Promise(() => {}), abort.signal);
  abort.abort(new Error('cancelled import'));
  await assert.rejects(result, /cancelled import/);
});

test('superseding an unresolved module returns false before the new route commits', async () => {
  let imported;
  const seen = new Promise(resolve => { imported = resolve; });
  const f = fixture({ routes: [{ pattern: '/slow', client: '/_prnext/assets/slow.js' }, { pattern: '/fast', client: '/_prnext/assets/fast.js' }],
    importModule: async url => { if (url.endsWith('slow.js')) { imported(); return new Promise(() => {}); } return { Page: () => null }; } });
  try {
    const old = f.controller.navigate('/slow'); await seen;
    assert.equal(await f.controller.navigate('/fast'), true);
    assert.equal(await old, false);
    assert.deepEqual(f.commits.map(state => state.router.pathname), ['/fast']);
    assert.deepEqual(f.events.map(event => event[0]), ['routeChangeStart', 'routeChangeError', 'routeChangeStart', 'beforeHistoryChange', 'routeChangeComplete']);
    assert.equal(f.events[1][1].cancelled, true);
  } finally { f.controller.dispose(); }
});

test('shallow affects only the same route while event options retain the requested flag', async () => {
  const f = fixture({ routes: [{ pattern: '/other', client: '/_prnext/assets/other.js' }] });
  try {
    await f.controller.navigate('/?a=one', undefined, { shallow: true });
    assert.equal(f.dataCalls.length, 0);
    assert.equal(f.controller.snapshot().query.a, 'one');
    await f.controller.navigate('/other', undefined, { shallow: true });
    assert.equal(f.dataCalls.length, 1);
    assert.equal(f.events.at(-1)[2].shallow, true);
  } finally { f.controller.dispose(); }
});

test('pure Pages without server routing never request JSON and pop callbacks use relative URLs', async () => {
  const f = fixture({ needsServerRouting: false, routes: [{ pattern: '/docs/[id]', client: '/_prnext/assets/docs.js', ssg: false, ssp: false }] });
  try {
    await f.controller.navigate('/docs/caf%C3%A9?tag=one&tag=two');
    assert.equal(f.dataCalls.length, 0);
    assert.deepEqual(f.controller.snapshot().query, { id: 'café', tag: ['one', 'two'] });
    let state;
    f.controller.beforePopState(value => { state = value; return false; });
    f.listeners.get('popstate')({ state: { __prnextPages: { url: '/', as: '/', options: {} } } });
    assert.equal(state.as, '/');
    assert.equal(f.controller.snapshot().pathname, '/docs/[id]');
  } finally { f.controller.dispose(); }
});

test('prefetch stores at most eight MiB and never stores private data or runs GSSP', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const routes = Array.from({ length: 6 }, (_, i) => ({ pattern: `/static${i}`, client: `/_prnext/assets/static${i}.js`, ssg: true }));
  routes.push({ pattern: '/server', client: '/_prnext/assets/server.js', ssp: true });
  const f = fixture({ routes, readData: async (url, _, options) => ({
    data: { pageProps: {}, __PRNEXT_ROUTER__: { pathname: url.pathname, query: {} } }, bytes: 2 * 1024 * 1024,
    cacheable: url.pathname !== '/static5',
  }) });
  try {
    for (let i = 0; i < 6; i++) await f.controller.prefetch(`/static${i}`);
    await f.controller.prefetch('/server');
    assert.equal(f.dataCalls.filter(call => call.url.endsWith('/server')).length, 0);
    await f.controller.navigate('/static4');
    assert.equal(f.dataCalls.filter(call => call.url.endsWith('/static4')).length, 1, 'recent public data stays prefetched');
    await f.controller.navigate('/static0');
    assert.equal(f.dataCalls.filter(call => call.url.endsWith('/static0')).length, 2, 'old data evicted by byte budget');
    await f.controller.navigate('/static5');
    assert.equal(f.dataCalls.filter(call => call.url.endsWith('/static5')).length, 2, 'private data fetched again');
  } finally { f.controller.dispose(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('speculative JSON cancels oversized bodies and marks private or rewritten responses uncacheable', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(readPageDataResponse(new Response(stream, { headers: { 'content-type': 'application/json' } }), 'https://example.test/', { maxBytes: 100 }), /limit/);
  assert.equal(cancelled, true);
  const privateResult = await readPageDataResponse(Response.json({ pageProps: {} }, { headers: { 'cache-control': 'private, no-store' } }), 'https://example.test/', { includeBytes: true });
  assert.equal(privateResult.cacheable, false);
  const rewritten = await readPageDataResponse(Response.json({ pageProps: {} }, { headers: { 'x-prnext-rewrite': encodeURIComponent(JSON.stringify({ url: '/target', params: {} })) } }), 'https://example.test/', { includeBytes: true });
  assert.equal(rewritten.cacheable, false);
});

test('Page initial props run only on navigation and receive logical target query with public asPath', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const contexts = [];
  const Page = Object.assign(() => null, { getInitialProps(context) { contexts.push(context); return { slug: context.query.slug }; } });
  const f = fixture({ basePath: '/docs', needsServerRouting: false,
    routes: [{ pattern: '/legacy/[slug]', client: '/docs/_prnext/assets/legacy.js', gip: true }], importModule: async () => ({ Page }) });
  try {
    assert.equal(contexts.length, 0, 'initial hydration uses its existing props');
    await f.controller.prefetch('/legacy/one?from=href');
    assert.equal(contexts.length, 0, 'prefetch fetches assets without evaluating hooks');
    await f.controller.navigate('/legacy/[slug]?from=href', '/legacy/one?visible=as');
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].pathname, '/legacy/[slug]');
    assert.equal(contexts[0].asPath, '/docs/legacy/one?visible=as');
    assert.deepEqual(contexts[0].query, { slug: 'one', from: 'href' });
    assert.equal(contexts[0].req, undefined); assert.equal(contexts[0].res, undefined);
    assert.equal(typeof contexts[0].AppTree, 'function');
    assert.deepEqual(f.commits.at(-1).props, { slug: 'one' });
    await f.controller.navigate('/legacy/two', undefined, { shallow: true });
    assert.equal(contexts.length, 1);
    assert.equal(f.controller.snapshot().query.slug, 'two');
    assert.equal(f.dataCalls.length, 0);
  } finally { f.controller.dispose(); if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('App initial props decide Page delegation and retain additional App props', async () => {
  const calls = [];
  const Page = Object.assign(() => null, { getInitialProps(context) { calls.push(['page', context.pathname]); return { marker: 'page' }; } });
  const App = Object.assign(() => null, { async getInitialProps(context) {
    calls.push(['app', context.ctx.pathname, context.router.pathname, context.AppTree === context.ctx.AppTree]);
    return context.ctx.query.skip ? { pageProps: { marker: 'skipped' }, theme: 'dark' }
      : { ...await DefaultApp.getInitialProps(context), theme: 'light' };
  } });
  const f = fixture({ initial: { App }, needsServerRouting: false,
    routes: [{ pattern: '/legacy', client: '/_prnext/assets/legacy.js', gip: true, appGip: true }], importModule: async () => ({ Page, App }) });
  try {
    await f.controller.navigate('/legacy');
    assert.deepEqual(calls, [['app', '/legacy', '/', true], ['page', '/legacy']]);
    assert.deepEqual(f.commits.at(-1).props, { marker: 'page' });
    assert.deepEqual(f.commits.at(-1).appProps, { theme: 'light' });
    await f.controller.navigate('/legacy?skip=1');
    assert.deepEqual(calls.at(-1), ['app', '/legacy', '/legacy', true]);
    assert.equal(calls.filter(call => call[0] === 'page').length, 1);
    assert.deepEqual(f.commits.at(-1).props, { marker: 'skipped' });
    assert.deepEqual(f.commits.at(-1).appProps, { theme: 'dark' });
  } finally { f.controller.dispose(); }
});

test('SSG and GSSP use server App props without executing client hooks', async () => {
  const hook = () => { throw new Error('Unexpected client hook'); };
  const Page = Object.assign(() => null, { getInitialProps: hook }), App = Object.assign(() => null, { getInitialProps: hook });
  const f = fixture({ routes: [{ pattern: '/ssg', client: '/_prnext/assets/ssg.js', ssg: true, appGip: true },
    { pattern: '/ssp', client: '/_prnext/assets/ssp.js', ssp: true, appGip: true }], importModule: async () => ({ Page, App }),
    readData: async url => ({ data: { pageProps: { source: url.pathname }, theme: 'from-server', __N_SSP: url.pathname === '/ssp',
      __N_SSG: url.pathname === '/ssg', __PRNEXT_ROUTER__: { pathname: url.pathname, query: {} } } }) });
  try {
    for (const route of ['/ssg', '/ssp']) {
      await f.controller.navigate(route);
      assert.deepEqual(f.commits.at(-1).props, { source: route });
      assert.deepEqual(f.commits.at(-1).appProps, { theme: 'from-server' });
    }
  } finally { f.controller.dispose(); }
});

test('routing-only replies select the rewritten Page before its client initial props execute', async () => {
  const contexts = [];
  const Page = Object.assign(() => null, { getInitialProps(context) { contexts.push(context); return { source: 'client' }; } });
  const f = fixture({ routes: [{ pattern: '/legacy/[slug]', client: '/_prnext/assets/legacy.js', gip: true }], importModule: async () => ({ Page }),
    readData: async () => ({ data: { pageProps: {}, __PRNEXT_ROUTER__: { pathname: '/legacy/[slug]', query: { slug: 'rewritten', from: 'destination' } } },
      rewrite: { url: '/legacy/rewritten?from=destination', params: { slug: 'rewritten' } } }) });
  try {
    await f.controller.navigate('/alias?visible=visitor');
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].pathname, '/legacy/[slug]');
    assert.equal(contexts[0].asPath, '/alias?visible=visitor');
    assert.deepEqual(contexts[0].query, { slug: 'rewritten', from: 'destination' });
    assert.equal(f.controller.snapshot().asPath, '/alias?visible=visitor');
  } finally { f.controller.dispose(); }
});

test('legacy middleware probes resolve hooks from the final route while preserving the visible URL', async () => {
  const contexts = [];
  const Page = Object.assign(() => null, { getInitialProps(context) { contexts.push(context); return { source: 'client' }; } });
  const f = fixture({ basePath: '/docs', routes: [{ pattern: '/legacy/[slug]', client: '/docs/_prnext/assets/legacy.js', gip: true }],
    importModule: async () => ({ Page }), readData: async url => ({ legacy: true, data: null,
      ...(url.pathname.includes('/alias') ? { rewrite: { url: '/legacy/rewritten?from=destination', params: { slug: 'rewritten' } } } : {}) }) });
  try {
    assert.equal(await f.controller.navigate('/alias?visible=visitor'), true);
    assert.deepEqual(contexts[0].query, { visible: 'visitor', from: 'destination', slug: 'rewritten' });
    assert.equal(contexts[0].asPath, '/docs/alias?visible=visitor');
    assert.equal(await f.controller.navigate('/legacy/original?mode=redirect'), true);
    assert.deepEqual(contexts[1].query, { slug: 'original', mode: 'redirect' });
    assert.equal(f.win.location.pathname, '/docs/legacy/original');
    assert.equal(f.commits.at(-1).props.source, 'client');
  } finally { f.controller.dispose(); }
});

test('legacy probes without a final alias rewrite fall back to the original document and reject SSG/SSP targets', async () => {
  for (const route of [undefined, { ssg: true, appGip: true }, { ssp: true, appGip: true }, {}]) {
    const f = fixture({ routes: route ? [{ pattern: '/probe', client: '/_prnext/assets/probe.js', ...route }] : [],
      readData: async () => ({ legacy: true, data: null }),
      importModule: async () => assert.fail('must not load an incompatible legacy route') });
    try {
      assert.equal(await f.controller.navigate('/probe?original=one'), false);
      assert.deepEqual(f.documents, [{ target: 'http://example.test/probe?original=one', replace: false }]);
      assert.equal(f.commits.length, 0);
    } finally { f.controller.dispose(); }
  }
});

test('a superseded user hook resolves false promptly and cannot publish its later props', async () => {
  let started, finish;
  const seen = new Promise(resolve => { started = resolve; });
  const Slow = Object.assign(() => null, { getInitialProps() { started(); return new Promise(resolve => { finish = resolve; }); } });
  const f = fixture({ needsServerRouting: false, routes: [{ pattern: '/slow', client: '/_prnext/assets/slow.js', gip: true },
    { pattern: '/fast', client: '/_prnext/assets/fast.js' }], importModule: async url => ({ Page: url.endsWith('slow.js') ? Slow : () => null }) });
  try {
    const old = f.controller.navigate('/slow'); await seen;
    await f.controller.navigate('/fast');
    assert.equal(await old, false);
    finish({ stale: true }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(f.commits.map(view => view.router.pathname), ['/fast']);
    assert.equal(f.commits[0].props.stale, undefined);
  } finally { f.controller.dispose(); }
});

test('a client data-hook error initializes _error in both Next contexts and rejects after rendering', async () => {
  const calls = [], error = new Error('Page initial props failed');
  const Broken = Object.assign(() => null, { getInitialProps() { throw error; } });
  const ErrorPage = Object.assign(() => null, { getInitialProps(context) { return { context: { ...context, AppTree: undefined } }; } });
  const App = Object.assign(() => null, { async getInitialProps(context) {
    calls.push({ error: context.ctx.err, pathname: context.ctx.pathname, query: context.ctx.query,
      asPath: context.ctx.asPath, routerPathname: context.router.pathname });
    return { ...await DefaultApp.getInitialProps(context), outside: 'app-prop' };
  } });
  const f = fixture({ basePath: '/docs', needsServerRouting: false, initial: { App },
    routes: [{ pattern: '/broken/[id]', client: '/docs/_prnext/assets/broken.js', gip: true, appGip: true }],
    errors: { error: { pattern: '/_error', client: '/docs/_prnext/assets/error.js', css: [] } },
    importModule: async url => ({ Page: url.endsWith('error.js') ? ErrorPage : Broken, App }) });
  try {
    await assert.rejects(f.controller.navigate('/broken/one?from=target'), failure => failure === error);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1], { error, pathname: '/broken/[id]', query: { id: 'one', from: 'target' }, asPath: undefined, routerPathname: '/' });
    assert.deepEqual(calls[2], { error, pathname: '/', query: {}, asPath: '/', routerPathname: '/broken/[id]' });
    assert.equal(f.commits.at(-1).App, App);
    assert.equal(f.commits.at(-1).Page, ErrorPage);
    assert.equal(f.commits.at(-1).appProps.outside, 'app-prop');
    assert.equal(f.controller.snapshot().asPath, '/broken/one?from=target');
    assert.deepEqual(f.events.map(event => event[0]), ['routeChangeStart', 'beforeHistoryChange', 'routeChangeError']);
    assert.equal(f.events.at(-1)[2], '/broken/one?from=target');
  } finally { f.controller.dispose(); }
});

test('an App-supplied err prop avoids the second error initialization', async () => {
  let errorCalls = 0;
  const Broken = Object.assign(() => null, { getInitialProps() { throw new Error('failed'); } });
  const ErrorPage = Object.assign(() => null, { getInitialProps() { errorCalls++; return { statusCode: 500 }; } });
  const App = Object.assign(() => null, { async getInitialProps(context) {
    return { ...await DefaultApp.getInitialProps(context), ...(context.ctx.err ? { err: context.ctx.err } : {}) };
  } });
  const f = fixture({ initial: { App }, needsServerRouting: false,
    routes: [{ pattern: '/broken', client: '/_prnext/assets/broken.js', gip: true }],
    errors: { error: { pattern: '/_error', client: '/_prnext/assets/error.js', css: [] } },
    importModule: async url => ({ Page: url.endsWith('error.js') ? ErrorPage : Broken, App }) });
  try { await assert.rejects(f.controller.navigate('/broken'), /failed/); assert.equal(errorCalls, 1); }
  finally { f.controller.dispose(); }
});
