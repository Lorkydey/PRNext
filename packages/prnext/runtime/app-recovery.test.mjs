import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { getEventListeners } from 'node:events';
import { renderAppRecoveryShell } from './app-recovery.mjs';

const h = React.createElement;
function emptyBody(html) {
  assert.match(html, /^<!DOCTYPE html><html id="__prnext_error__"><head>/);
  assert.match(html, /<\/head><body><\/body><\/html>$/);
  assert.doesNotMatch(html, /<script|stylesheet|<style|data-dgst|\$RX/);
}

test('recovery without metadata is a bounded empty document with default head and noindex', async () => {
  const html = await renderAppRecoveryShell(undefined);
  emptyBody(html);
  assert.equal((html.match(/charset=/gi) || []).length, 1);
  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /name="robots" content="noindex"/);
});

test('recovery preserves decoded title and metadata without duplicating charset or viewport', async () => {
  const html = await renderAppRecoveryShell(h(React.Fragment, null,
    h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=800' }),
    h('title', null, 'Route title <escaped>'), h('meta', { name: 'description', content: `name='viewport' is text` }),
    h('meta', { name: 'robots', content: 'index, follow' }), h('link', { rel: 'canonical', href: '/route' })));
  emptyBody(html);
  assert.equal((html.match(/charset=/gi) || []).length, 1);
  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /name="viewport" content="width=800"/);
  assert.match(html, /<title>Route title &lt;escaped&gt;<\/title>/);
  assert.match(html, /rel="canonical" href="\/route"/);
  assert.equal((html.match(/name="robots"/g) || []).length, 1);
  assert.doesNotMatch(html, /index, follow/);
});

test('recovery awaits lazy metadata once and preserves React head hoisting', async () => {
  let loads = 0, renders = 0;
  const Metadata = React.lazy(async () => {
    loads++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { default() { renders++; return h(React.Fragment, null, h('title', null, 'Async title'), h('meta', { name: 'description', content: 'Async metadata' })); } };
  });
  const html = await renderAppRecoveryShell(h(React.Suspense, { fallback: null }, h(Metadata)));
  emptyBody(html);
  assert.match(html, /<title>Async title<\/title>/); assert.match(html, /content="Async metadata"/);
  assert.equal(loads, 1); assert.equal(renders, 1);
});

test('metadata failure discards partial metadata without retrying the rejected component', async () => {
  let loads = 0;
  const Broken = React.lazy(async () => { loads++; throw new Error('PRIVATE_METADATA_ERROR'); });
  const html = await renderAppRecoveryShell(h(React.Fragment, null, h('title', null, 'Partial title'), h(Broken)));
  emptyBody(html);
  assert.equal(loads, 1);
  assert.doesNotMatch(html, /PRIVATE_METADATA_ERROR|Partial title/);
  assert.match(html, /name="robots" content="noindex"/);
});

test('metadata deadlines reject with 504 and parent cancellation preserves its reason and listeners', async () => {
  const Pending = React.lazy(() => new Promise(() => {}));
  await assert.rejects(renderAppRecoveryShell(h(Pending), { timeoutMs: 10 }), error => error.statusCode === 504);
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  const reason = new Error('client left');
  const render = renderAppRecoveryShell(h(Pending), { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(reason);
  await assert.rejects(render, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  await assert.rejects(renderAppRecoveryShell(undefined, { signal: controller.signal }), error => error === reason);
});

test('recovery enforces the HTML byte bound instead of returning an oversized metadata document', async () => {
  await assert.rejects(renderAppRecoveryShell(h('meta', { name: 'description', content: 'x'.repeat(16 * 1024 * 1024) })), /16 MiB/);
});
