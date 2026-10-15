import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { appRoutePlan } from './app-route-plan.mjs';
import { createAdvancedTree } from './app-routing.mjs';
import { createAppMatcher, matchAppPattern } from './app-routing-state.mjs';
import { runRequestContext } from '../compat/headers.cjs';

const Page = () => null, Layout = ({ children }) => children;
const module = { default: Page };
function node(path = '', pattern = '/', files = {}, children = [], slots = {}) {
  return { path, pattern, segment: path.split('/').at(-1), files, children, slots, config: {}, interception: null };
}
function freeze(root) {
  for (const child of [...root.children, ...Object.values(root.slots)]) freeze(child);
  Object.freeze(root.children); Object.freeze(root.slots); Object.freeze(root.files);
  return Object.freeze(root);
}
function entry(routing) {
  return { routing, LayoutSlot: 'slot', LayoutProvider: 'layout-provider', NavigationBoundary: 'navigation', ErrorBoundary: 'error', page: module };
}
function render(routing, pathname, state, extra = {}) {
  const request = { url: `http://localhost${pathname}`, params: {}, production: true,
    headers: state ? { rsc: '1', 'x-prnext-router-state': JSON.stringify(state) } : {}, ...extra };
  return runRequestContext({ ...request, phase: 'render' }, () => createAdvancedTree(entry(routing), request, Promise.resolve({})));
}
function treeNodes(tree, values = []) {
  if (Array.isArray(tree)) { for (const value of tree) treeNodes(value, values); }
  else if (React.isValidElement(tree)) {
    values.push(tree);
    for (const value of Object.values(tree.props)) if (React.isValidElement(value) || Array.isArray(value)) treeNodes(value, values);
  }
  return values;
}

test('compiled plans retain only immutable scaffold and keep mutable modules/config live', () => {
  const page = node('[id]', '/[id]', { page: module });
  const root = freeze(node('', '/', { layout: { default: Layout } }, [page]));
  const plan = appRoutePlan(root);
  assert.ok(plan);
  assert.equal(appRoutePlan(root), plan);
  assert.equal(plan.pages[0].node, page);
  assert.deepEqual(plan.pages[0].chain, [root, page]);
  assert.deepEqual([...plan.rootLayouts], ['']);
  const replacement = () => null;
  const original = module.default;
  try {
    module.default = replacement;
    assert.ok(treeNodes(render(root, '/alice').tree).some(element => element.type === replacement));
    page.config.page = { instant: { unstable_disableValidation: true } };
    assert.equal(render(root, '/alice', null, { instantValidation: true }).instantTrees, undefined);
  } finally { module.default = original; }
});

test('mutable development trees and frozen trees with mutable children/accessors are not cached', () => {
  const child = node('a', '/a', { page: module });
  const root = node('', '/', { layout: { default: Layout } }, [child]);
  assert.equal(appRoutePlan(root), null);
  assert.equal(render(root, '/a').routing.slots['::{}::children'].branch, 'a');
  child.path = 'b'; child.pattern = '/b'; child.segment = 'b';
  assert.equal(render(root, '/b').routing.slots['::{}::children'].branch, 'b');
  Object.freeze(root.children); Object.freeze(root.slots); Object.freeze(root.files); Object.freeze(root);
  assert.equal(appRoutePlan(root), null);
  let reads = 0;
  const accessor = node();
  Object.defineProperty(accessor, 'children', { enumerable: true, get() { reads++; return []; } });
  Object.freeze(accessor);
  assert.equal(appRoutePlan(accessor), null);
  assert.equal(reads, 0, 'validation must not invoke accessors');
  const inherited = node();
  inherited.files = Object.freeze(Object.create({ get page() { reads++; return module; } }));
  Object.freeze(inherited.children); Object.freeze(inherited.slots); Object.freeze(inherited);
  assert.equal(appRoutePlan(inherited), null);
  assert.equal(reads, 0, 'inherited accessors are not an immutable scaffold');
  const customIterator = node();
  Object.defineProperty(customIterator.children, Symbol.iterator, { value: function* () { reads++; yield node('live', '/live', { page: module }); } });
  Object.freeze(customIterator.children); Object.freeze(customIterator.slots); Object.freeze(customIterator.files); Object.freeze(customIterator);
  assert.equal(appRoutePlan(customIterator), null);
  assert.equal(reads, 0, 'a frozen array can still have a closure-backed custom iterator');
});

test('compiled route selection preserves specificity, equal-score order and slot boundaries', () => {
  const first = node('[first]', '/[first]', { page: module });
  const second = node('[second]', '/[second]', { page: module });
  const catchall = node('[...rest]', '/[...rest]', { page: module });
  const literal = node('fixed', '/fixed', { page: module });
  const parallel = node('@team', '/', { default: module }, [node('@team/[member]', '/[member]', { page: module })]);
  const root = freeze(node('', '/', { layout: { default: Layout } }, [first, second, catchall, literal], { team: parallel }));
  for (const [url, expected] of [['/fixed', 'fixed'], ['/alice', '[first]'], ['/a/b', '[...rest]']]) {
    const result = render(root, url);
    assert.equal(result.routing.slots['::{}::children'].branch, expected);
  }
  const alice = render(root, '/alice'), bob = render(root, '/bob');
  assert.equal(alice.routing.slots['::{}::team'].branch, '@team/[member]');
  assert.equal(alice.routing.params.first, 'alice');
  assert.equal(bob.routing.params.first, 'bob');
  alice.routing.params.first = 'mutated';
  assert.equal(render(root, '/alice').routing.params.first, 'alice');
});

test('compiled routes preserve defaults, soft navigation and refresh validation', () => {
  const root = freeze(node('', '/', { layout: { default: Layout }, page: module }, [node('next', '/next', { page: module })], {
    team: node('@team', '/', { default: module }, [node('@team/next', '/next', { page: module })]),
  }));
  const initial = render(root, '/');
  assert.equal(initial.routing.slots['::{}::team'].branch, '@team#default');
  const moved = render(root, '/next', initial.routing);
  assert.equal(moved.routing.slots['::{}::team'].branch, '@team/next');
  const restored = render(root, '/next', { ...initial.routing, refresh: true });
  assert.equal(restored.routing.slots['::{}::children'].branch, '');
  const invalid = structuredClone(initial.routing);
  invalid.refresh = true; invalid.slots['::{}::children'].branch = 'unknown';
  assert.equal(render(root, '/next', invalid).routingInvalid, true);
});

test('oversized or cyclic frozen scaffold declines cached plan', () => {
  let deep = node('page', '/', { page: module });
  for (let index = 0; index < 65; index++) deep = node(String(index), '/', {}, [deep]);
  assert.equal(appRoutePlan(freeze(deep)), null);
  const cycle = node(); cycle.children.push(cycle);
  Object.freeze(cycle.children); Object.freeze(cycle.slots); Object.freeze(cycle.files); Object.freeze(cycle);
  assert.equal(appRoutePlan(cycle), null);
});

test('request matcher preserves encoded paths, invalid escapes, prefix and fresh catchall params', () => {
  for (const pathname of ['/', '/a/b', '/%61/%E2%82%AC', '/%2f', '/%broken', '/a//b/']) {
    const match = createAppMatcher(pathname);
    for (const pattern of ['/', '/a', '/[id]', '/[...all]', '/[[...all]]', '/a/[id]', '/a/[...all]']) {
      for (const prefix of [false, true]) assert.deepEqual(match(pattern, prefix), matchAppPattern(pattern, pathname, prefix));
    }
  }
  const match = createAppMatcher('/a/b');
  const first = match('/[...all]'); first.all.push('mutated');
  assert.deepEqual(match('/[...all]'), { all: ['a', 'b'] });
});
