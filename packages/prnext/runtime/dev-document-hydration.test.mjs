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

function observedDocument(attributes = {}) {
  const doc = document(attributes), observers = [];
  doc.defaultView = { MutationObserver: class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  } };
  return Object.assign(doc, { observers, flush() { for (const observer of observers) if (observer.active) observer.callback(); } });
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

test('normalizes late and repeated extension writes until commit, then stops observing', () => {
  const doc = observedDocument({ 'data-app': 'browser-value' });
  const restore = prepareDevDocumentHydration(tree({ 'data-app': 'server-value' }), doc);
  for (let injection = 0; injection < 3; injection++) {
    doc.body.setAttribute(marker, 'true'); doc.flush();
    assert.equal(doc.body.getAttribute(marker), null);
    assert.equal(doc.body.getAttribute('data-app'), 'browser-value');
  }
  restore();
  assert.equal(doc.body.getAttribute(marker), 'true');
  doc.body.removeAttribute(marker); restore();
  assert.equal(doc.body.getAttribute(marker), null);
  doc.body.setAttribute(marker, 'true'); doc.flush();
  assert.equal(doc.body.getAttribute(marker), 'true');
  assert.equal(doc.observers[0].active, false);
});

test('observation does not invent a marker, rewrite other values or observe application-owned props', () => {
  for (const attributes of [{}, { [marker]: 'false' }]) {
    const doc = observedDocument(attributes);
    const restore = prepareDevDocumentHydration(tree({}), doc);
    doc.flush(); restore();
    assert.deepEqual(Object.fromEntries(doc.values), attributes);
    assert.equal(doc.observers[0].active, false);
  }
  const owned = observedDocument({ [marker]: 'true' });
  assert.equal(prepareDevDocumentHydration(tree({ [marker]: 'true' }), owned), undefined);
  assert.equal(owned.observers.length, 0);
});

test('a continuously fighting observer cannot cause an unbounded normalization loop', () => {
  const doc = observedDocument(), restore = prepareDevDocumentHydration(tree({}), doc);
  for (let attempt = 0; attempt < 64; attempt++) {
    doc.body.setAttribute(marker, 'true'); doc.flush();
  }
  assert.equal(doc.observers[0].active, false);
  assert.equal(doc.body.getAttribute(marker), 'true');
  restore();
  assert.equal(doc.body.getAttribute(marker), 'true');
});
