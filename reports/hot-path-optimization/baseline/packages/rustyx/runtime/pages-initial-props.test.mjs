import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useRouter } from '../compat/router.cjs';
import { createInitialPropsRunner, loadPageInitialProps } from './pages-initial-props.mjs';

test('unfinished hooks occupy a bounded slot even if their caller stops awaiting', async () => {
  const run = createInitialPropsRunner({ limit: 2 });
  const finishes = [];
  const Page = Object.assign(() => null, { getInitialProps() { return new Promise(resolve => finishes.push(resolve)); } });
  const options = { Page, context: { pathname: '/pending', query: {}, asPath: '/pending' }, routerSnapshot: { pathname: '/', query: {}, asPath: '/' } };
  const first = run(options), second = run(options);
  await assert.rejects(run(options), /Too many unfinished/);
  assert.equal(finishes.length, 2);
  assert.deepEqual(await run({ ...options, Page: () => null }), { props: {}, appProps: {} }, 'ordinary pages remain usable at the hook limit');
  finishes[0]({ sequence: 1 });
  assert.deepEqual(await first, { props: { sequence: 1 }, appProps: {} });
  const third = run(options);
  assert.equal(finishes.length, 3);
  finishes[1]({ sequence: 2 }); finishes[2]({ sequence: 3 });
  await Promise.all([second, third]);
});

test('client AppTree renders the initial entry with the router from before navigation', async () => {
  function InitialPage({ label }) { return React.createElement('p', null, `${label}:${useRouter().pathname}`); }
  const Target = Object.assign(() => null, { getInitialProps(context) {
    return { tree: renderToStaticMarkup(React.createElement(context.AppTree, { pageProps: { label: 'initial' } })) };
  } });
  const result = await loadPageInitialProps({ Page: Target, appTreePage: InitialPage,
    context: { pathname: '/target', query: {}, asPath: '/target' },
    routerSnapshot: { pathname: '/previous', query: {}, asPath: '/previous' } });
  assert.equal(result.props.tree, '<p>initial:/previous</p>');
});
