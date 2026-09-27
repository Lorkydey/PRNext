import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeTrailingSlash } from '../compat/paths.cjs';
import { RouterContext } from '../compat/router.cjs';
import { AppRouterContext } from '../compat/app-context.cjs';
import Link from '../compat/link.cjs';
import { publicNavigationURL } from './client-navigation.mjs';

test('client slash normalization preserves query/hash and absolute destinations', () => {
  for (const [input, expected] of [['/a?x=1#part','/a/?x=1#part'],['/file.png/?x=1','/file.png?x=1'],['/','/'],['/nested.name/child','/nested.name/child/'],['https://other.test/a','https://other.test/a'],['//other.test/a','//other.test/a']]) {
    assert.equal(normalizeTrailingSlash(input, { trailingSlash: true }), expected);
  }
  assert.equal(normalizeTrailingSlash('/a/?q=1'), '/a?q=1');
  assert.equal(normalizeTrailingSlash('/a/', { skipTrailingSlashRedirect: true }), '/a/');
  assert.equal(publicNavigationURL('/path?x=1#part', 'https://app.test/docs/', '/docs', { trailingSlash: true }).href, 'https://app.test/docs/path/?x=1#part');
  assert.equal(publicNavigationURL('/', 'https://app.test/docs/page', '/docs', { trailingSlash: true }).pathname, '/docs/');
  assert.equal(publicNavigationURL('/', 'https://app.test/docs/page', '/docs').pathname, '/docs');
  assert.equal(publicNavigationURL('/path/', 'https://app.test/docs/page', '/docs', { skipTrailingSlashRedirect: true }).pathname, '/docs/path/');
  assert.equal(publicNavigationURL('https://other.test/x', 'https://app.test/docs/', '/docs', { trailingSlash: true }).href, 'https://other.test/x');
});

test('both router Link providers render canonical hrefs before hydration', () => {
  for (const Context of [RouterContext, AppRouterContext]) {
    const render = (href, policy) => renderToStaticMarkup(React.createElement(Context.Provider, {value:{basePath:'/docs', ...policy}}, React.createElement(Link, {href, prefetch:false}, 'Link')));
    assert.match(render('/target?q=1#hash', {trailingSlash:true}), /href="\/docs\/target\/\?q=1#hash"/);
    assert.match(render('/', {trailingSlash:true}), /href="\/docs\/"/);
    assert.match(render('/file.txt/', {trailingSlash:true}), /href="\/docs\/file.txt"/);
    assert.match(render('/target/', {skipTrailingSlashRedirect:true}), /href="\/docs\/target\/"/);
  }
});


test('NextURL clone preserves the incoming slash preference when replacing its pathname', async () => {
  const { NextRequest } = await import('../compat/server.cjs');
  for (const trailingSlash of [false, true]) {
    for (const slash of ['', '/']) {
      const request = new NextRequest('https://site.test/docs/source' + slash, {nextConfig:{basePath:'/docs',trailingSlash}});
      const clone = request.nextUrl.clone();
      clone.pathname = '/target';
      assert.equal(clone.href, 'https://site.test/docs/target' + slash);
      assert.equal(String(clone), clone.href);
      assert.equal(clone.pathname, '/target');
    }
  }
});
