import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import Script from '../compat/script.cjs';
import { ScriptContext } from '../compat/script-context.cjs';
import { loadScript, loadLazyScript, isScriptLoaded, handleClientScriptLoad, initScriptLoader, loadBeforeInteractive } from '../compat/script-loader.cjs';

function browser(t, { readyState = 'loading' } = {}) {
  const saved = new Map(['window', 'document', 'self'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const nodes = [], events = new Map(), idle = [];
  const window = { setTimeout, trace: [], requestIdleCallback(callback) { idle.push(callback); },
    addEventListener(name, callback, options) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push({ callback, once: options?.once });
    } };
  const document = { readyState, createElement(tag) {
    const attributes = new Map(), listeners = new Map();
    const element = { tagName: tag.toUpperCase(), innerHTML: '', textContent: '',
      setAttribute(name, value) { attributes.set(name.toLowerCase(), String(value)); },
      getAttribute(name) { return attributes.get(name.toLowerCase()) ?? null; },
      removeAttribute(name) { attributes.delete(name.toLowerCase()); },
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
      dispatch(name) {
        const event = { type: name, target: element };
        for (const callback of listeners.get(name) || []) callback.call(element, event);
        element[`on${name}`]?.call(element, event);
        return event;
      },
    };
    for (const name of ['id', 'src', 'href', 'rel', 'type']) Object.defineProperty(element, name, {
      get: () => element.getAttribute(name) || '', set: value => element.setAttribute(name, value),
    });
    for (const name of ['async', 'defer', 'noModule']) Object.defineProperty(element, name, {
      get: () => element.getAttribute(name) !== null,
      set: value => value ? element.setAttribute(name, '') : element.removeAttribute(name),
    });
    return element;
  }, querySelectorAll() { return nodes.filter(node => ['beforeInteractive', 'beforePageRender'].includes(node.getAttribute('data-nscript'))); } };
  for (const name of ['head', 'body']) document[name] = { appendChild(element) {
    nodes.push(element); element.parent = name;
    if (element.tagName === 'SCRIPT' && !element.src && element.type !== 'text/partytown') {
      vm.runInNewContext(String(element.innerHTML || element.textContent), { window, self: window });
    }
    return element;
  } };
  Object.assign(globalThis, { window, document, self: window });
  t.after(() => { for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  return { window, document, nodes, runIdle() { for (const callback of idle.splice(0)) callback(); },
    load() { document.readyState = 'complete'; for (const event of [...events.get('load') || []]) {
      event.callback(); if (event.once) events.set('load', events.get('load').filter(value => value !== event));
    } },
  };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

// Run the component's effects with persistent refs to model StrictMode's effect
// replay separately from a real remount. Actual DOM lifecycle is also covered by
// the integration browser suite; this keeps callback ordering deterministic.
function component(context = {}) {
  const require = createRequire(new URL('../compat/script.cjs', import.meta.url));
  let index = 0, effects = [];
  const refs = [];
  const hooks = { ...React, useContext: () => context, useRef(value) { return refs[index++] ||= { current: value }; }, useEffect(callback) { effects.push(callback); } };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../compat/script.cjs', import.meta.url), 'utf8'), {
    module, exports: module.exports, window: globalThis.window,
    require: name => name === 'react' ? hooks : require(name),
  });
  return { render(props) { index = 0; effects = []; return module.exports(props); },
    effects() { for (const effect of effects) effect(); } };
}

test('external scripts share one source and preserve the distinct load/ready callback order', async t => {
  const env = browser(t), calls = [];
  const props = id => ({ id, src: '/remote.js', onLoad(event) { calls.push([id, 'load', this?.tagName, event?.type]); },
    onReady() { calls.push([id, 'ready']); } });
  loadScript(props('one')); loadScript(props('two'));
  assert.equal(env.nodes.length, 1);
  env.window.trace.push('remote executed'); env.nodes[0].dispatch('load');
  await tick();
  assert.deepEqual(calls, [['one', 'load', 'SCRIPT', 'load'], ['one', 'ready'], ['two', 'load', undefined, undefined]]);
  assert.equal(isScriptLoaded('one'), true); assert.equal(isScriptLoaded('two'), true);
  loadScript({ ...props('one'), src: '/another.js' });
  assert.equal(env.nodes.length, 1, 'an already loaded id also suppresses a different src');
});

test('inline onReady runs before execution without synthesizing onLoad and ids prevent reruns', t => {
  const env = browser(t), calls = [];
  const props = { id: 'inline', children: ['window.inline=', '42'], onReady() { calls.push(env.window.inline); },
    onLoad() { assert.fail('inline scripts do not emit a synthetic load'); } };
  loadScript(props); loadScript(props);
  assert.deepEqual(calls, [undefined]); assert.equal(env.window.inline, 42); assert.equal(env.nodes.length, 1);
  loadScript({ id: 'html', dangerouslySetInnerHTML: { __html: 'window.html=84' } });
  assert.equal(env.window.html, 84);
});

test('failed sources retain their settled promise without retrying the network on remount', async t => {
  const env = browser(t), calls = [];
  const props = { id: 'failed', src: '/404.js', onError: event => calls.push(['error', event.type]),
    onLoad: event => calls.push(['load', event?.type]), onReady: () => calls.push(['ready']) };
  const first = component(); first.render(props); first.effects();
  env.nodes[0].dispatch('error'); await tick();
  assert.deepEqual(calls, [['error', 'error']]);
  const second = component(); second.render(props); second.effects(); await tick();
  assert.deepEqual(calls, [['error', 'error'], ['load', undefined]]);
  assert.equal(env.nodes.length, 1);
  const third = component(); third.render(props); third.effects();
  assert.deepEqual(calls.at(-1), ['ready']);
});

test('effect replay does not duplicate callbacks while a fresh mount invokes onReady for loaded scripts', t => {
  const env = browser(t), calls = [];
  const props = { id: 'strict', src: '/strict.js', onLoad: () => calls.push('load'), onReady: () => calls.push('ready') };
  const first = component(); first.render(props); first.effects(); first.effects();
  assert.equal(env.nodes.length, 1);
  env.nodes[0].dispatch('load');
  assert.deepEqual(calls, ['load', 'ready']);
  first.render(props); first.effects();
  assert.deepEqual(calls, ['load', 'ready']);
  const remount = component(); remount.render(props); remount.effects(); remount.effects();
  assert.deepEqual(calls, ['load', 'ready', 'ready']);
  assert.equal(env.nodes.length, 1);
});

test('script attributes preserve booleans, nonce, integrity and worker type without leaking options', t => {
  const env = browser(t);
  loadScript({ src: '/attrs.js', id: 'attrs', async: false, defer: true, noModule: true, nonce: 'nonce-value',
    crossOrigin: 'anonymous', referrerPolicy: 'no-referrer', integrity: 'sha384-example', fetchPriority: 'low',
    'data-custom': 'value', 'data-false': false, omitted: undefined, strategy: 'worker', onReady() {} });
  const script = env.nodes[0];
  assert.equal(script.async, false); assert.equal(script.defer, true); assert.equal(script.noModule, true);
  for (const [key, value] of Object.entries({ nonce: 'nonce-value', crossorigin: 'anonymous', referrerpolicy: 'no-referrer',
    integrity: 'sha384-example', fetchpriority: 'low', 'data-custom': 'value', 'data-nscript': 'worker', type: 'text/partytown' })) {
    assert.equal(script.getAttribute(key), value);
  }
  for (const key of ['data-false', 'omitted', 'strategy', 'onready', 'children', 'stylesheets']) assert.equal(script.getAttribute(key), null);
});

test('associated styles are initialized before appending the script', t => {
  const env = browser(t), calls = [], preinit = ReactDOM.preinit;
  ReactDOM.preinit = (href, options) => calls.push([href, options, env.nodes.length]);
  try {
    loadScript({ id: 'styled', src: '/styled.js', stylesheets: ['/first.css', '/second.css'] });
    assert.deepEqual(calls, [['/first.css', { as: 'style' }, 0], ['/second.css', { as: 'style' }, 0]]);
    assert.equal(env.nodes.length, 1);
  } finally { ReactDOM.preinit = preinit; }
});

test('lazy scripts wait for window load and idle, or just idle after the document is complete', t => {
  const env = browser(t);
  loadLazyScript({ id: 'lazy', children: 'window.trace.push("lazy")' });
  env.runIdle(); assert.deepEqual(env.window.trace, []);
  env.load(); assert.deepEqual(env.window.trace, []);
  env.runIdle(); assert.deepEqual(env.window.trace, ['lazy']);
  loadLazyScript({ id: 'late', children: 'window.trace.push("late")' });
  env.runIdle(); assert.deepEqual(env.window.trace, ['lazy', 'late']);
  handleClientScriptLoad({ id: 'queued', strategy: 'lazyOnload', children: 'window.trace.push("queued")' });
  env.runIdle(); assert.deepEqual(env.window.trace, ['lazy', 'late'], 'Document loader items retain Next load-event scheduling');
});

test('Pages beforeInteractive tags seed readiness without executing or loading again', t => {
  const env = browser(t), calls = [];
  const tag = env.document.createElement('script'); tag.id = 'before'; tag.src = '/before.js'; tag.setAttribute('data-nscript', 'beforeInteractive');
  env.document.head.appendChild(tag);
  initScriptLoader([]);
  const script = component({ ssr: true });
  script.render({ id: 'before', src: '/before.js', strategy: 'beforeInteractive', onReady: () => calls.push('ready'), onLoad: () => calls.push('load') });
  script.effects(); script.effects();
  assert.deepEqual(calls, ['ready']); assert.equal(env.nodes.length, 1);
});

test('initial Pages worker hydration marks its server tag loaded before the client render', t => {
  const env = browser(t), context = { ssr: true };
  const tag = env.document.createElement('script'); tag.id = 'worker'; tag.src = '/worker.js';
  tag.setAttribute('data-nscript', 'worker'); tag.type = 'text/partytown'; env.document.body.appendChild(tag);
  assert.equal(isScriptLoaded('worker'), false);
  let ready = 0;
  const script = component(context), props = { id: 'worker', src: '/worker.js', strategy: 'worker', onReady: () => ready++ };
  script.render(props); script.effects();
  assert.equal(isScriptLoaded('worker'), true); assert.equal(ready, 1);
  context.ssr = false;
  script.render(props); script.effects();
  assert.equal(env.nodes.length, 1, 'the client rerender must not insert a second Partytown tag');
  assert.equal(ready, 1);
});

test('App beforeInteractive queue is sequential, executes in head and does not invent readiness callbacks', async t => {
  const env = browser(t);
  const promise = loadBeforeInteractive([[0, { id: 'one', children: 'window.trace.push("inline-one")' }],
    ['/blocking.js', { id: 'remote', nonce: 'explicit' }], [0, { children: 'window.trace.push("inline-two")' }]]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(env.window.trace, ['inline-one']); assert.equal(env.nodes.length, 2);
  assert.ok(env.nodes.every(node => node.parent === 'head'));
  env.window.trace.push('external'); env.nodes[1].dispatch('load');
  await promise;
  assert.deepEqual(env.window.trace, ['inline-one', 'external', 'inline-two']);
  assert.equal(env.nodes[1].getAttribute('nonce'), 'explicit');
  assert.equal(isScriptLoaded('remote'), false);
  const before = component({ appDir: true });
  let ready = 0;
  before.render({ id: 'remote', src: '/blocking.js', strategy: 'beforeInteractive', onReady: () => ready++ }); before.effects();
  assert.equal(ready, 0);
  assert.equal(loadBeforeInteractive([]), promise, 'a repeated bootstrap shares its completed queue');
});

test('a failed blocking queue logs once, skips later scripts and still allows hydration', async t => {
  const env = browser(t), errors = [], original = console.error;
  console.error = error => errors.push(error);
  try {
    const promise = loadBeforeInteractive([['/broken.js', {}], [0, { children: 'window.trace.push("must not run")' }]]);
    await tick(); env.nodes[0].dispatch('error'); await promise;
    assert.equal(errors.length, 1); assert.equal(env.nodes.length, 1); assert.deepEqual(env.window.trace, []);
  } finally { console.error = original; }
});

test('Pages SSR collects only blocking/worker scripts while Document collects every strategy', () => {
  for (const document of [false, true]) {
    const collected = [];
    const html = renderToStaticMarkup(React.createElement(ScriptContext.Provider, { value: { ssr: true, document, nonce: 'inherited', collect: props => collected.push(props) } },
      ['beforeInteractive', 'worker', 'afterInteractive', 'lazyOnload'].map(strategy => React.createElement(Script, { key: strategy, id: strategy, src: `/${strategy}.js`, strategy }))));
    assert.equal(html, '');
    assert.deepEqual(collected.map(props => props.strategy), document ? ['beforeInteractive', 'worker', 'afterInteractive', 'lazyOnload'] : ['beforeInteractive', 'worker']);
    assert.ok(collected.every(props => props.nonce === 'inherited'));
  }
});

test('App SSR escapes inline queues, preloads external scripts and hoists associated styles', () => {
  const source = 'window.payload="</script><img src=x onerror=evil>&\u2028\u2029"';
  const html = renderToStaticMarkup(React.createElement(ScriptContext.Provider, { value: { appDir: true, ssr: true, nonce: 'inherited' } },
    React.createElement(React.Fragment, null,
      React.createElement(Script, { id: 'inline', strategy: 'beforeInteractive', dangerouslySetInnerHTML: { __html: source } }),
      React.createElement(Script, { id: 'external', strategy: 'beforeInteractive', src: '/before.js', nonce: 'explicit', integrity: 'sha384-test', crossOrigin: 'anonymous', stylesheets: ['/script.css'] }),
      React.createElement(Script, { strategy: 'afterInteractive', src: '/after.js', stylesheets: ['/script.css'] }))));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /nonce="inherited"/); assert.match(html, /nonce="explicit"/);
  assert.match(html, /href="\/before.js"/); assert.match(html, /href="\/after.js"/);
  assert.equal((html.match(/href="\/script.css"/g) || []).length, 1);
  const self = {};
  for (const [, body] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) vm.runInNewContext(body, { self });
  assert.equal(self.__PRNEXT_SCRIPTS__[0][1].children, source);
  assert.equal(self.__PRNEXT_SCRIPTS__[0][1].nonce, undefined);
  assert.equal(self.__PRNEXT_SCRIPTS__[1][0], '/before.js');
  assert.equal(self.__PRNEXT_SCRIPTS__[1][1].nonce, 'explicit');
});
