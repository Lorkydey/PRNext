import test from 'node:test';
import assert from 'node:assert/strict';
import { advancedRoutingSources, matchAppPattern } from './app-routing-state.mjs';

const page = (pattern, module = pattern) => ({ pattern, module, router: 'app', kind: 'page' });
const navigation = urls => ({ headers: { rsc: '1', 'x-prnext-router-state': JSON.stringify({
  source: '/', slots: Object.fromEntries(urls.map((url,index) => [`slot-${index}`, { branch: '/', url }])) }) } });

test('compiled App patterns preserve static, dynamic, catch-all, optional and prefix matching', () => {
  const cases = [
    ['/', '/', false, {}], ['/', '/more', false, null], ['/', '/more', true, {}],
    ['/docs', '/docs/', false, {}], ['/docs', '/docs/more', false, null], ['/docs', '/docs/more', true, {}],
    ['/docs/[id]', '/docs/123', false, { id: '123' }], ['/docs/[id]', '/docs', true, null],
    ['/docs/[...slug]', '/docs', false, null], ['/docs/[...slug]', '/docs/a/b', false, { slug: ['a','b'] }],
    ['/docs/[[...slug]]', '/docs', false, {}], ['/docs/[[...slug]]', '/docs/a', false, { slug: ['a'] }],
    ['/x/[id]/[id]', '/x/a/b', false, { id: 'b' }],
    ['/x/[...slug]/trailing', '/x/a', false, { slug: ['a'] }],
    ['//docs///[id]/', '//docs//one///', false, { id: 'one' }],
    ['/literal/[]', '/literal/[]', false, {}], ['/literal/[[]', '/literal/[[]', false, { '[': '[[]' }],
    ['/x/[...]', '/x/a', false, { '...': 'a' }],
  ];
  for (const [pattern, pathname, prefix, expected] of cases) {
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(matchAppPattern(pattern, pathname, prefix), expected, `${pattern}: ${pathname}`);
  }
});

test('App matching decodes path segments once without treating an escaped slash as a separator', () => {
  assert.deepEqual(matchAppPattern('/[id]', '/one%2Ftwo'), { id: 'one/two' });
  assert.deepEqual(matchAppPattern('/[...slug]', '/one%2Ftwo/%252F/caf%C3%A9'), { slug: ['one/two', '%2F', 'café'] });
  assert.deepEqual(matchAppPattern('/café', '/caf%C3%A9'), {});
  assert.equal(matchAppPattern('/caf%C3%A9', '/caf%C3%A9'), null, 'route literals are not URL-decoded');
  for (const pathname of ['/%', '/%ZZ', '/%C3%28', '/%ED%A0%80']) assert.equal(matchAppPattern('/[...slug]', pathname), null);
});

test('a cached pattern never shares parameters or catch-all arrays between callers', () => {
  const first = matchAppPattern('/[id]/[...slug]', '/alice/a/b');
  first.id = 'changed'; first.slug.push('private');
  assert.deepEqual(matchAppPattern('/[id]/[...slug]', '/bob/c'), { id: 'bob', slug: ['c'] });
  assert.deepEqual(matchAppPattern('/[id]/[...slug]', '/alice/a/b'), { id: 'alice', slug: ['a','b'] });
  const missing = matchAppPattern('/[[...slug]]', '/');
  assert.equal(Object.hasOwn(missing, 'slug'), false);
});

test('saved routing selects the highest original score, retains first ties and excludes untrusted entries', () => {
  const routes = [page('/[[...slug]]','optional'), page('/[...slug]','catch-all'), page('/docs/[id]','dynamic-first'),
    page('/docs/[other]','dynamic-second'), page('/docs/static','static'),
    { ...page('/docs/[id]/extra','hidden'), internal: true },
    { ...page('/docs/api','api'), kind: 'route' }, { ...page('/docs/pages','legacy'), router: 'pages' }];
  assert.deepEqual(advancedRoutingSources(navigation(['/docs/static','/docs/hello','/other/path','/','/docs/static']), routes),
    ['static', 'dynamic-first', 'catch-all', 'optional']);
  assert.deepEqual(advancedRoutingSources(navigation(['/docs/hello/extra']), routes), ['catch-all']);
  assert.deepEqual(advancedRoutingSources(navigation(['/docs/api','/docs/pages']), routes), ['dynamic-first']);
  assert.deepEqual(advancedRoutingSources(navigation(['/%ZZ']), routes), []);
});

test('saved routing observes route changes, reordered ties and module updates in the same manifest array', () => {
  const routes = [page('/[name]', 'first'), page('/[id]', 'second')];
  const request = navigation(['/hello']);
  assert.deepEqual(advancedRoutingSources(request, routes), ['first']);
  routes.reverse();
  assert.deepEqual(advancedRoutingSources(request, routes), ['second']);
  routes[0].pattern = '/another';
  assert.deepEqual(advancedRoutingSources(request, routes), ['first']);
  routes[1].module = 'updated';
  assert.deepEqual(advancedRoutingSources(request, routes), ['updated']);
  routes.push(page('/hello', 'static'));
  assert.deepEqual(advancedRoutingSources(request, routes), ['static']);
  delete routes[2];
  assert.deepEqual(advancedRoutingSources(request, routes), ['updated']);
});

test('saved routing does not resolve modules from caller input or accept invalid state', () => {
  assert.deepEqual(advancedRoutingSources({ headers: {} }, [page('/x')]), []);
  const request = navigation(['/etc/private']);
  assert.deepEqual(advancedRoutingSources(request, [page('/safe', 'safe.mjs')]), []);
  const state = JSON.parse(request.headers['x-prnext-router-state']);
  state.slots['slot-0'].module = '/etc/private';
  state.slots['slot-0'].url = '//example.com/evil';
  request.headers['x-prnext-router-state'] = JSON.stringify(state);
  assert.deepEqual(advancedRoutingSources(request, [page('/[...all]', 'safe.mjs')]), []);
});

test('pattern churn and uncached long routes preserve matching correctness', () => {
  for (let index = 0; index < 1500; index++) {
    assert.deepEqual(matchAppPattern(`/r${index}/[id]`, `/r${index}/value-${index}`), { id: `value-${index}` });
  }
  assert.deepEqual(matchAppPattern('/r0/[id]', '/r0/fresh'), { id: 'fresh' });
  const long = 'a'.repeat(2100);
  assert.deepEqual(matchAppPattern(`/${long}/[id]`, `/${long}/value`), { id: 'value' });
  const deep = '/x'.repeat(70);
  assert.deepEqual(matchAppPattern(`${deep}/[id]`, `${deep}/value`), { id: 'value' });
});
