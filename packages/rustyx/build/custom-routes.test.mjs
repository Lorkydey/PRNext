import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCustomRoutes } from './custom-routes.mjs';

const redirects = routes => compileCustomRoutes({ redirects: async () => routes });
const rewrites = routes => compileCustomRoutes({ rewrites: async () => routes });
const redirect = (source, destination, extra = {}) => ({ source, destination, permanent: false, ...extra });
const capture = (route, pathname) => {
  const match = new RegExp(route.regex, 'i').exec(pathname);
  if (!match) return null;
  return Object.fromEntries(route.keys.flatMap((key, index) => key.name && match[index + 1] !== undefined
    ? [[key.name, key.repeat ? match[index + 1].split(key.separator) : match[index + 1]]] : []));
};

test('custom route callbacks keep ordered phases and serialize without executable matchers', async () => {
  const calls = [];
  const result = await compileCustomRoutes({
    headers: async () => { calls.push('headers'); return [{ source: '/:path*', headers: [{ key: 'X-One', value: 'first' }, { key: 'x-one', value: 'last' }] }]; },
    redirects: async () => { calls.push('redirects'); return [redirect('/old', '/new'), redirect('/moved', '/new', { permanent: true })]; },
    rewrites: async () => { calls.push('rewrites'); return { beforeFiles: [{ source: '/first', destination: '/second' }], afterFiles: [{ source: '/second', destination: '/third' }], fallback: [{ source: '/missing', destination: 'https://example.test/help' }] }; },
  });
  assert.deepEqual(calls, ['headers', 'redirects', 'rewrites']);
  assert.deepEqual(result.redirects.map(route => route.statusCode), [307, 308]);
  assert.equal(result.headers[0].headers.length, 2);
  assert.equal(result.rewrites.beforeFiles[0].source, '/first');
  assert.equal(result.rewrites.afterFiles[0].source, '/second');
  assert.equal(result.rewrites.fallback[0].destination.external, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal((await rewrites([{ source: '/from', destination: '/to' }])).rewrites.afterFiles.length, 1);
  assert.deepEqual(await compileCustomRoutes(), { version: 1, headers: [], redirects: [], rewrites: { beforeFiles: [], afterFiles: [], fallback: [] } });
});

test('source matching supports optional and repeated parameters, regex, escaped literals and lookahead', async () => {
  const result = await redirects([
    redirect('/post/:id(\\d+)', '/article/:id'),
    redirect('/docs/:rest*', '/guide/:rest*'),
    redirect('/file/:name.:extension?', '/download/:name'),
    redirect('/literal/\\:value\\(one\\)', '/done'),
    redirect('/:path((?!api(?:/|$)|_next(?:/|$)).*)', '/site/:path'),
    redirect('/anonymous/(.*)', '/done'),
  ]);
  assert.deepEqual(capture(result.redirects[0], '/POST/123/'), { id: '123' });
  assert.equal(capture(result.redirects[0], '/post/nope'), null);
  assert.equal(capture(result.redirects[0], '/post/123?secret=yes'), null);
  assert.deepEqual(capture(result.redirects[1], '/docs'), {});
  assert.deepEqual(capture(result.redirects[1], '/docs/a/b%2Fc'), { rest: ['a', 'b%2Fc'] });
  assert.deepEqual(capture(result.redirects[2], '/file/report'), { name: 'report' });
  assert.deepEqual(capture(result.redirects[2], '/file/report.pdf'), { name: 'report', extension: 'pdf' });
  assert.deepEqual(capture(result.redirects[3], '/literal/:value(one)'), {});
  assert.deepEqual(capture(result.redirects[4], '/catalog/one'), { path: 'catalog/one' });
  assert.equal(capture(result.redirects[4], '/api/secret'), null);
  assert.equal(capture(result.redirects[4], '/_next/static/file'), null);
  assert.deepEqual(capture(result.redirects[5], '/anonymous/hello/world'), {});
});

test('has and missing conditions compile presence and indexed named captures without exposing missing params', async () => {
  const result = await redirects([redirect('/source/:id', '/:tenant/:id?auth=:xauth', {
    has: [
      { type: 'header', key: 'X-Auth' },
      { type: 'cookie', key: 'session', value: '(ignored)-(?<tenant>[a-z]+)' },
      { type: 'query', key: 'mode', value: '(?:preview|live)' },
    ],
    missing: [{ type: 'header', key: 'x-disabled' }],
  })]);
  const route = result.redirects[0];
  assert.equal(route.has[0].key, 'x-auth');
  assert.equal(route.has[0].capture, 'xauth');
  assert.deepEqual(route.has[1].captures, [{ name: 'tenant', index: 2 }]);
  assert.equal(new RegExp(route.has[2].regex).test('preview-bad'), false);
  assert.equal(new RegExp(route.has[2].regex).test('live'), true);
  assert.equal(route.missing[0].capture, 'xdisabled');
  await assert.rejects(redirects([redirect('/x', '/:xdisabled', { missing: [{ type: 'header', key: 'x-disabled' }] })]), /unknown destination parameter/);
  const host = (await redirects([redirect('/x', '/:host', { has: [{ type: 'host', value: 'example\\.test' }] })])).redirects[0];
  assert.equal(host.has[0].capture, 'host');
});

test('destination templates retain URL parts, repeated query values and Next query-forwarding rule', async () => {
  const result = await rewrites([
    { source: '/old/:path*', destination: 'https://example.test:8443/new/:path*?fixed=one&fixed=two#section' },
    { source: '/old/:id/:extra', destination: '/target?picked=:id' },
    { source: '/old/:id/:extra', destination: '/target/:id' },
    { source: '/tenant/:sub/:id', destination: 'https://:sub.example.test/post/:id' },
    { source: '/x/:id', destination: 'http://[::1]:3000/:id' },
  ]);
  const [external, query, path, host, ipv6] = result.rewrites.afterFiles.map(route => route.destination);
  assert.equal(external.protocol, 'https'); assert.equal(external.port, '8443');
  assert.deepEqual(external.hostname, ['example.test']);
  assert.deepEqual(external.pathname, ['/new', { param: 'path', prefix: '/', suffix: '', modifier: '*' }]);
  assert.deepEqual(external.query, [{ key: 'fixed', value: ['one'] }, { key: 'fixed', value: ['two'] }]);
  assert.deepEqual(external.hash, ['section']);
  assert.equal(external.appendParamsToQuery, false);
  assert.equal(query.appendParamsToQuery, true);
  assert.equal(path.appendParamsToQuery, false);
  assert.equal(host.hostname[0].param, 'sub');
  assert.deepEqual(ipv6.hostname, ['[::1]']);
  assert.equal((await redirects([redirect('/x/:id', '/target')])).redirects[0].destination.appendParamsToQuery, false);
});

test('response header interpolation preserves colons, duplicate precedence and case', async () => {
  const result = await compileCustomRoutes({ headers: () => [{ source: '/:slug', headers: [
    { key: 'X-Route-:slug', value: 'page=:slug; https://example.test:8443; 09:30' },
    { key: 'Content-Security-Policy', value: "default-src 'self'; report-uri https://example.test/reports" },
  ] }] });
  const headers = result.headers[0].headers;
  assert.deepEqual(headers[0].key, ['X-Route-', { param: 'slug', prefix: '', suffix: '', modifier: '' }]);
  assert.deepEqual(headers[0].value, ['page=', { param: 'slug', prefix: '', suffix: '', modifier: '' }, '; https://example.test:8443; 09:30']);
  assert.deepEqual(headers[1].value, ["default-src 'self'; report-uri https://example.test/reports"]);
});

test('repeated non-path substitutions retain Next leading and embedded joining semantics', async () => {
  const { rewrites: { afterFiles: [route] } } = await rewrites([
    { source: '/:parts*', destination: '/target?first=:parts*&embedded=prefix-:parts*&slash=prefix/:parts*&dot=prefix.:parts*' },
  ]);
  assert.deepEqual(route.destination.query.map(({ value }) => value.find(token => typeof token !== 'string').join), ['/', '', '/', '.']);
  const render = value => value.map(token => typeof token === 'string' ? token : ['a', 'b'].join(token.join)).join('');
  assert.deepEqual(route.destination.query.map(({ value }) => render(value)), ['a/b', 'prefix-ab', 'prefix/a/b', 'prefix.a.b']);
});

test('query presence captures permit repeated destination placeholders without assuming scalar values', async () => {
  const route = (await redirects([redirect('/query-presence', '/target/:tag*?joined=:tag*', {
    has: [{ type: 'query', key: 'tag' }],
  })])).redirects[0];
  assert.deepEqual(route.has, [{ type: 'query', key: 'tag', captures: [], capture: 'tag' }]);
  assert.deepEqual(route.destination.pathname, ['/target', { param: 'tag', prefix: '/', suffix: '', modifier: '*' }]);
  assert.deepEqual(route.destination.query, [{ key: 'joined', value: [{ param: 'tag', prefix: '', suffix: '', modifier: '*', join: '/' }] }]);
});

test('invalid custom routes fail at build rather than becoming ambiguous native rules', async () => {
  const invalid = [
    [redirect('bad', '/ok'), /source must start/],
    [redirect('/x/:id/:id', '/:id'), /duplicate parameter/],
    [redirect('/x/:items*', '/:items'), /requires \* or \+/],
    [redirect('/x', '/:unknown'), /unknown destination parameter/],
    [redirect('/x', '/ok?value=:unknown'), /unknown destination parameter/],
    [redirect('/x/(.*)', '/:0'), /unknown destination parameter/],
    [redirect('/x', '//evil.test'), /destination must start/],
    [redirect('/x', 'javascript:alert(1)'), /destination must start/],
    [redirect('/x', 'https://user:pass@example.test'), /credentials/],
    [redirect('/x', '/ok\r\nBad: value'), /control characters/],
    [redirect('/x', '/ok', { permanent: undefined, statusCode: 304 }), /statusCode must/],
    [redirect('/x', '/ok', { statusCode: 301 }), /mutually exclusive/],
    [redirect('/x', '/ok', { permanent: undefined }), /requires permanent/],
    [redirect('/x', '/ok', { locale: true }), /locale only accepts/],
    [redirect('/x', '/ok', { basePath: '/base' }), /basePath only accepts/],
    [redirect('/x', '/ok', { unsupported: true }), /unsupported fields/],
    [redirect('/x', '/ok', { has: [{ type: 'host' }] }), /host conditions require/],
    [redirect('/x', '/ok', { has: [{ type: 'header', key: 'x\nsecret' }] }), /control characters/],
    [redirect('/x', '/ok', { has: [{ type: 'query', key: 'x', value: '(' }] }), /invalid condition regex/],
    [redirect('/x', '/ok', { has: [{ type: 'cookie', key: 'x' }], missing: [{ type: 'cookie', key: 'x' }] }), /required and missing/],
    [redirect('/x/:id', '/ok', { has: [{ type: 'query', key: 'id' }] }), /duplicate parameter/],
  ];
  for (const [route, message] of invalid) await assert.rejects(redirects([route]), message);
  for (const result of [null, undefined, {}, 'bad']) await assert.rejects(compileCustomRoutes({ redirects: () => result }), /callback must return an array/);
  await assert.rejects(compileCustomRoutes({ rewrites: [] }), /configuration must be a function/);
  await assert.rejects(rewrites({ badPhase: [] }), /unsupported fields/);
  await assert.rejects(rewrites({ afterFiles: null }), /callback must return an array/);
  for (const [key, value] of [['bad key', 'ok'], ['X-Valid', 'bad\nvalue']]) {
    await assert.rejects(compileCustomRoutes({ headers: () => [{ source: '/x', headers: [{ key, value }] }] }), /invalid header name|control characters/);
  }
});

test('custom route memory bounds cover count, regex growth, conditions, header size and total output', async () => {
  await assert.rejects(redirects(Array.from({ length: 1001 }, () => redirect('/x', '/y'))), /at most 1000/);
  await assert.rejects(redirects([redirect(`/${'a'.repeat(4096)}`, '/y')]), /4096 bytes/);
  await assert.rejects(redirects([redirect('/x', '/y', { has: Array.from({ length: 17 }, (_, i) => ({ type: 'query', key: `key${i}` })) })]), /at most 16 conditions/);
  await assert.rejects(compileCustomRoutes({ headers: () => [{ source: '/x', headers: [{ key: 'X-Long', value: 'a'.repeat(4097) }] }] }), /4096 bytes/);
  await assert.rejects(compileCustomRoutes({ headers: () => Array.from({ length: 600 }, (_, i) => ({ source: `/x${i}`, headers: [{ key: 'X-Large', value: 'a'.repeat(4000) }] })) }), /exceed 2 MiB/);
});

test('native matcher escape and case-folding limits fail at build with specific diagnostics', async () => {
  for (const kind of ['p', 'P', 'a', 'A', 'z', 'Z', 'G', 'K', 'h', 'H', 'R', 'N', 'e', 'c', 'q', 'U']) {
    await assert.rejects(redirects([redirect(`/x/:value(\\${kind}+)`, '/ok')]), /unsupported ECMAScript escape/);
    await assert.rejects(redirects([redirect('/x', '/ok', { has: [{ type: 'query', key: 'q', value: `\\${kind}+` }] })]), /unsupported ECMAScript escape/);
  }
  for (const pattern of ['[é]', '[\\xE9]', '[\\u00E9]', '[A-Ω]']) {
    await assert.rejects(redirects([redirect(`/x/:value(${pattern}+)`, '/ok')]), /case-insensitive Unicode character classes/);
    // Conditions are case-sensitive and preserve their Unicode classes.
    const condition = (await redirects([redirect('/x', '/ok', { has: [{ type: 'query', key: 'q', value: pattern }] })])).redirects[0].has[0];
    assert.equal(condition.regex, `^(?:${pattern})$`);
  }
  for (const pattern of ['\\xZ1', '\\u12', '\\u{61}', '\\uD800', '\\uD83D\\uDE00']) {
    await assert.rejects(redirects([redirect(`/x/:value(${pattern})`, '/ok')]), /unsupported.*escape|surrogate regex escapes/);
    await assert.rejects(redirects([redirect('/x', '/ok', { missing: [{ type: 'query', key: 'q', value: pattern }] })]), /unsupported.*escape|surrogate regex escapes/);
  }
  for (const pattern of ['[\\x61]', '[\\u0061]', '\\d+', '[\\w-]+', '\\s+', '\\bword\\b', 'é+', '\\u00E9+', '(?!api).*']) {
    const route = (await redirects([redirect(`/x/:value(${pattern})`, '/ok')])).redirects[0];
    assert.ok(route.regex);
  }
  // A literal escaped backslash must not accidentally become a forbidden \p.
  const literal = (await redirects([redirect('/x', '/ok', { has: [{ type: 'query', key: 'q', value: '\\\\p' }] })])).redirects[0];
  assert.equal(new RegExp(literal.has[0].regex).test('\\p'), true);
});
