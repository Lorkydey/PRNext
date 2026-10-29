import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAppStyleGraph, appStyleScopes, planAppStyles } from './app-styles.mjs';

test('App style reachability joins client graphs, preserves import order and owns CSS dependencies once', () => {
  const root = path.resolve('fixture'), graph = createAppStyleGraph(root);
  graph.record({ inputs: {
    'app/layout.jsx': { imports: [{ path: 'app/base.css' }, { path: 'app/client.jsx' }] },
    'app/client.jsx': { imports: [{ path: 'prnext-css-mapping:' + path.join(root, 'app/client.module.css') }] },
    'app/a/page.jsx': { imports: [{ path: 'app/client.jsx' }, { path: 'app/a.css' }] },
    'app/b/page.jsx': { imports: [{ path: 'app/b.css' }] },
    'app/base.css': { imports: [{ path: 'app/reset.css', kind: 'import-rule' }] },
  } });
  // RSC normally records only the boundary reference; the real browser graph
  // supplies the imports without erasing the first graph's dependency order.
  graph.record({ inputs: { 'app/client.jsx': { imports: [{ path: 'app/browser.css' }] } } });
  const route = { segments: [{ layout: path.join(root, 'app/layout.jsx') }], file: path.join(root, 'app/a/page.jsx') };
  assert.deepEqual(planAppStyles(route, graph), [
    ['app/base.css', 'app/client.module.css', 'app/browser.css'].map(file => path.join(root, file)),
    [path.join(root, 'app/a.css')],
  ]);
  assert.ok(!graph.collect([route.file]).some(file => file.endsWith('b.css')));
  assert.ok(!graph.collect([route.segments[0].layout]).some(file => file.endsWith('reset.css')), '@imports remain compiled inside their owning sheet');
});

test('App style plans handle cycles, canonical aliases and separate root page/layout scopes', () => {
  const root = path.resolve('fixture'), graph = createAppStyleGraph(root);
  graph.record({ inputs: { 'real/layout.jsx': { imports: [{ path: 'real/layout.css' }, { path: 'real/layout.jsx' }] } } });
  graph.alias(path.join(root, 'app/layout.jsx'), path.join(root, 'real/layout.jsx'));
  assert.deepEqual(graph.collect([path.join(root, 'app/layout.jsx')]), [path.join(root, 'real/layout.css')]);
  const route = { routing: { files: { layout: '/layout.jsx', page: '/page.jsx' }, children: [], slots: {
    z: { files: { default: '/z.jsx' } }, a: { files: { error: '/error.jsx', page: '/a.jsx' } },
  } } };
  assert.deepEqual(appStyleScopes(route), [['/layout.jsx'], ['/page.jsx'], ['/error.jsx'], ['/a.jsx'], ['/z.jsx']]);
});

test('App CSS discovery supports deep dependency chains without exhausting the JavaScript stack', () => {
  const root=path.resolve('fixture'),graph=createAppStyleGraph(root),inputs={};
  for(let index=0;index<12000;index++)inputs[`module-${index}.js`]={imports:[{path:index===11999?'deep.css':`module-${index+1}.js`}]};
  graph.record({inputs});assert.deepEqual(graph.collect(['module-0.js']),[path.join(root,'deep.css')]);
});

test('webpack CSS metadata resolves relative framework namespaces and preserves native absolute paths', () => {
  const root=path.resolve('fixture'),graph=createAppStyleGraph(root);
  // These are the identify(record) values emitted by the real webpack bridge,
  // including CSS mappings whose path is relative rather than drive-qualified.
  const sources=[
    ['prnext-css-mapping:components/counter.module.css','components/counter.module.css'],
    ['prnext-compiled-css:components/lazy.module.css','components/lazy.module.css'],
    ['prnext-app-empty:app/global.css','app/global.css'],
    ['prnext-edge-empty:app/edge.css','app/edge.css'],
    ['prnext-css-mapping:'+path.join(root,'absolute.module.css'),path.join(root,'absolute.module.css')],
    ['prnext-css-mapping:/posix/source.module.css','/posix/source.module.css'],
    ['prnext-css-mapping:C:\\project\\windows.module.css','C:\\project\\windows.module.css'],
  ];
  graph.record({inputs:{'components/Counter.jsx':{imports:sources.map(([path])=>({path}))}}});
  assert.deepEqual(graph.collect(['components/Counter.jsx']),sources.map(([,source])=>path.resolve(root,source)));
  assert.deepEqual(graph.collect([path.join(root,'plain.module.css')]),[path.join(root,'plain.module.css')]);
});
