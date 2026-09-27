import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { runRequestContext, currentRequest, headers, cookies } from '../compat/headers.cjs';
import { NextRequest, NextResponse, connection } from '../compat/server.cjs';
import { unstable_cache } from '../compat/cache.cjs';
import { navigationResponse } from './navigation.mjs';
import { redirect as serverRedirect } from '../compat/navigation-server.cjs';

test('request headers and cookies stay isolated across concurrent async work', async () => {
  const values = await Promise.all(['first', 'second'].map((value, index) => runRequestContext({ headers: { 'x-test': value, cookie: `session=${value}; greeting=hello%20world` } }, async () => {
    await setTimeout(index ? 1 : 5);
    const h = await headers();
    assert.throws(() => h.set('x-test', 'mutated'), /read-only/);
    assert.throws(() => h.forEach((_value, _name, sameHeaders) => sameHeaders.delete('x-test')), /read-only/);
    const c = await cookies();
    assert.equal(c.get('greeting').value, 'hello world');
    assert.throws(() => c.set('session', 'mutated'), /Route Handler/);
    return [h.get('x-test'), c.get('session').value];
  })));
  assert.deepEqual(values, [['first', 'first'], ['second', 'second']]);
  await assert.rejects(headers(), /while handling/);
});

test('connection opts out of prerendering without disabling explicitly cached data', async () => {
  await assert.rejects(connection(), /while handling/);
  await runRequestContext({ phase: 'render', staticGeneration: { mode: 'auto' } }, async () => {
    await assert.rejects(connection(), { code: 'PRNEXT_DYNAMIC_SERVER_USAGE' });
    assert.equal(currentRequest().staticState.error.dynamicReason, 'connection()');
  });
  await runRequestContext({ phase: 'render', cacheConfig: { dynamic: 'force-static' }, staticGeneration: { mode: 'force-static' } }, async () => {
    await connection(); assert.equal(currentRequest().staticState.error, null);
  });
  await runRequestContext({ phase: 'render' }, async () => {
    await connection(); assert.equal(Boolean(currentRequest().cacheState.noStore), false);
    await assert.rejects(unstable_cache(async () => connection())(), /inside unstable_cache/);
  });
  await runRequestContext({ operation: 'static-params' }, async () => {
    await assert.rejects(connection(), /generateStaticParams/);
  });
});

test('route handler cookies collect mutations and reject header injection', async () => {
  await runRequestContext({ headers: {}, mutableCookies: true }, async () => {
    const store = await cookies();
    store.set('session', 'a b', { httpOnly: true, sameSite: 'lax', secure: true });
    store.set('second', '2');
    store.delete('second');
    const outgoing = [...currentRequest().outgoingCookies.values()];
    assert.equal(outgoing.length, 2);
    assert.match(outgoing[0], /session=a%20b; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    assert.match(outgoing[1], /Max-Age=0/);
    assert.throws(() => store.set('bad\r\nname', 'x'), /Invalid cookie/);
    assert.throws(() => store.set('good', 'x', { path: '/\r\nSet-Cookie:evil' }), /Invalid cookie/);
  });
});

test('NextRequest extends Request and NextResponse preserves cookies, binary and redirects', async () => {
  const request = new NextRequest('https://example.test/items?a=1', { headers: { cookie: 'session=hello' } });
  assert.equal(request.nextUrl.searchParams.get('a'), '1');
  assert.equal(request.nextUrl.clone().href, request.url);
  request.cookies.set('session', 'changed');
  assert.equal(request.headers.get('cookie'), 'session=changed');
  const response = NextResponse.json({ ok: true }, { status: 201 });
  response.cookies.set('one', '1', { httpOnly: true });
  response.cookies.set('two', '2');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.deepEqual(await response.json(), { ok: true });
  const redirect = NextResponse.redirect(new URL('/next', request.url));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), 'https://example.test/next');
});

test('navigation control preserves semicolon URLs and distinguishes ordinary errors', () => {
  const redirect = navigationResponse({ digest: 'NEXT_REDIRECT;replace;/items;a=1;307;' });
  assert.equal(redirect.headers.location, '/items;a=1');
  assert.equal(redirect.status, 307);
  assert.equal(navigationResponse({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }).status, 404);
  assert.equal(navigationResponse(new Error('ordinary')), null);
  assert.equal(navigationResponse({ digest: 'NEXT_REDIRECT;replace;javascript:alert(1);307;' }), null);
  assert.equal(navigationResponse({ digest: 'NEXT_REDIRECT;replace;http://[;307;' }), null);
});

test('redirect defaults to pushing history in a Server Action and replacing during render', () => {
  for (const [input, expected] of [[{ action: { id: 'action' } }, 'push'], [{}, 'replace']]) {
    runRequestContext(input, () => {
      assert.throws(() => serverRedirect('/destination'), error => error.digest === `NEXT_REDIRECT;${expected};/destination;307;`);
      assert.throws(() => serverRedirect('/destination', 'replace'), error => error.digest === 'NEXT_REDIRECT;replace;/destination;307;');
    });
  }
});

test('response cookies read existing headers and replace or expire a cookie without duplicating it', () => {
  const response = new NextResponse(null, { headers: [
    ['set-cookie', 'session=hello%20world; Path=/private; HttpOnly; SameSite=Lax'],
    ['set-cookie', 'other=keep; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure'],
  ] });
  assert.deepEqual(response.cookies.get('session'), { name: 'session', value: 'hello world', path: '/private', httpOnly: true, sameSite: 'lax' });
  assert.equal(response.cookies.get('other').expires.toISOString(), '2037-10-21T07:28:00.000Z');
  response.cookies.set('session', 'updated', { path: '/private', httpOnly: true });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /^session=updated; Path=\/private; HttpOnly$/);
  response.cookies.delete({ name: 'session', path: '/private' });
  assert.equal(response.cookies.get('session').value, '');
  assert.equal(response.cookies.get('session').expires.getTime(), 0);
  assert.equal(response.cookies.get('other').value, 'keep');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /Expires=Thu, 01 Jan 1970/);
});
