import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, Fragment } from 'react';
import { prepareDevDocumentHydration } from './dev-document-hydration.mjs';

const marker = 'cz-shortcut-listen';
const tree = props => [h('meta', { name: 'viewport' }), h(Fragment, null, h('html', { lang: 'en' }, h('body', props, h('main', null, 'PRNext'))))];
function document(attributes = {}) {
  const values = new Map(Object.entries(attributes));
  const body = {
    getAttribute: name => values.get(name) ?? null,
    hasAttribute: name => values.has(name),
    removeAttribute: name => values.delete(name),
    setAttribute: (name, value) => values.set(name, value),
  };
  return { body, values };
}

test('temporarily removes only the injected ColorZilla marker and restores it once', () => {
  const doc = document({ [marker]: 'true', class: 'browser-value', 'data-app': 'unchanged' });
  const restore = prepareDevDocumentHydration(tree({ className: 'server-value' }), doc);
  assert.equal(doc.body.getAttribute(marker), null);
  assert.equal(doc.body.getAttribute('class'), 'browser-value');
  assert.equal(doc.body.getAttribute('data-app'), 'unchanged');
  restore();
  assert.equal(doc.body.getAttribute(marker), 'true');
  doc.body.removeAttribute(marker); restore();
  assert.equal(doc.body.getAttribute(marker), null);
});

test('preserves a marker explicitly owned by the server-rendered application', () => {
  for (const value of ['true', 'false', undefined]) {
    const doc = document({ [marker]: 'true' });
    assert.equal(prepareDevDocumentHydration(tree({ [marker]: value }), doc), undefined);
    assert.equal(doc.body.getAttribute(marker), 'true');
  }
});

test('does nothing without the exact known marker or a resolved server body', () => {
  for (const attributes of [{}, { [marker]: 'false' }, { 'data-other-extension': 'true' }]) {
    const doc = document(attributes);
    assert.equal(prepareDevDocumentHydration(tree({}), doc), undefined);
    assert.deepEqual(Object.fromEntries(doc.values), attributes);
  }
  const doc = document({ [marker]: 'true' });
  const UnknownLayout = () => { throw Error('Client components must not be executed'); };
  for (const value of [null, h(UnknownLayout), { then() { throw Error('Do not resolve arbitrary thenables'); } }]) {
    assert.equal(prepareDevDocumentHydration(value, doc), undefined);
    assert.equal(doc.body.getAttribute(marker), 'true');
  }
  assert.equal(prepareDevDocumentHydration(tree({}), undefined), undefined);
});

test('restoration does not overwrite a new attribute or mutate a replaced body', () => {
  const doc = document({ [marker]: 'true' });
  const restore = prepareDevDocumentHydration(tree({}), doc);
  doc.body.setAttribute(marker, 'application-updated'); restore();
  assert.equal(doc.body.getAttribute(marker), 'application-updated');
  const replaced = document({ [marker]: 'true' }), original = replaced.body;
  const restoreOld = prepareDevDocumentHydration(tree({}), replaced);
  replaced.body = document().body; restoreOld();
  assert.equal(original.getAttribute(marker), null);
  assert.equal(replaced.body.getAttribute(marker), null);
});

test('bounds traversal and does not change a cyclic or unresolved document tree', () => {
  const cycle = []; cycle.push(cycle);
  let deep = h('body'); for (let index = 0; index < 100; index++) deep = h(Fragment, null, deep);
  for (const value of [cycle, deep, Array.from({ length: 200 }, () => h('meta'))]) {
    const doc = document({ [marker]: 'true' });
    assert.equal(prepareDevDocumentHydration(value, doc), undefined);
    assert.equal(doc.body.getAttribute(marker), 'true');
  }
});
