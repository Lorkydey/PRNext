'use strict';

const ReactDOM = require('react-dom');
const registries = new WeakMap();
const ignored = new Set(['onLoad', 'onReady', 'onError', 'children', 'dangerouslySetInnerHTML', 'strategy', 'stylesheets']);
const attributeNames = { acceptCharset: 'accept-charset', className: 'class', htmlFor: 'for', httpEquiv: 'http-equiv', noModule: 'noModule' };

function registry() {
  let value = registries.get(document);
  if (!value) registries.set(document, value = { scripts: new Map(), loaded: new Set(), before: null });
  return value;
}

function setAttributes(element, props) {
  for (const [name, value] of Object.entries(props)) {
    if (ignored.has(name) || value === undefined) continue;
    const attribute = attributeNames[name] || name.toLowerCase();
    const boolean = element.tagName === 'SCRIPT' && ['async', 'defer', 'noModule'].includes(attribute);
    if (boolean) element[attribute] = !!value;
    else element.setAttribute(attribute, String(value));
    // Setting then removing is significant: it overrides force-async for a
    // dynamically created script even when async={false} is requested.
    if (value === false || (boolean && (!value || value === 'false'))) {
      element.setAttribute(attribute, '');
      element.removeAttribute(attribute);
    }
  }
}

function insertStylesheets(stylesheets) {
  if (ReactDOM.preinit) {
    for (const href of stylesheets) ReactDOM.preinit(href, { as: 'style' });
  } else {
    for (const href of stylesheets) {
      const link = document.createElement('link');
      link.type = 'text/css'; link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
    }
  }
}

function isScriptLoaded(key) { return !!key && registry().loaded.has(key); }
function markScriptLoaded(key) { registry().loaded.add(key); }

function loadScript(props) {
  const { src, id, onLoad = () => {}, onReady = null, onError, children = '', dangerouslySetInnerHTML,
    strategy = 'afterInteractive', stylesheets } = props;
  const { scripts, loaded } = registry();
  const key = id || src;
  if (key && loaded.has(key)) return;
  if (scripts.has(src)) {
    loaded.add(key);
    scripts.get(src).then(onLoad, onError);
    return;
  }
  const afterLoad = () => { if (onReady) onReady(); loaded.add(key); };
  const element = document.createElement('script');
  const promise = new Promise((resolve, reject) => {
    element.addEventListener('load', function (event) {
      resolve();
      if (onLoad) onLoad.call(this, event);
      afterLoad();
    });
    element.addEventListener('error', reject);
  }).catch(error => { if (onError) onError(error); });
  if (dangerouslySetInnerHTML) {
    element.innerHTML = dangerouslySetInnerHTML.__html || '';
    afterLoad();
  } else if (children) {
    element.textContent = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : '';
    afterLoad();
  } else if (src) {
    element.src = src;
    scripts.set(src, promise);
  }
  setAttributes(element, props);
  if (strategy === 'worker') element.setAttribute('type', 'text/partytown');
  element.setAttribute('data-nscript', strategy);
  if (stylesheets) insertStylesheets(stylesheets);
  document.body.appendChild(element);
}

function idle(callback) {
  if (window.requestIdleCallback) window.requestIdleCallback(callback);
  else window.setTimeout(callback, 1);
}

function loadLazyScript(props) {
  if (document.readyState === 'complete') idle(() => loadScript(props));
  else window.addEventListener('load', () => idle(() => loadScript(props)), { once: true });
}

function handleClientScriptLoad(props) {
  if (props.strategy === 'lazyOnload') {
    window.addEventListener('load', () => idle(() => loadScript(props)), { once: true });
  } else loadScript(props);
}

function markBeforeInteractive() {
  const { loaded } = registry();
  for (const script of document.querySelectorAll('[data-nscript="beforeInteractive"], [data-nscript="beforePageRender"]')) {
    loaded.add(script.id || script.getAttribute('src'));
  }
}

function initScriptLoader(items = []) {
  items.forEach(handleClientScriptLoad);
  markBeforeInteractive();
}

function loadBeforeInteractive(queue = globalThis.__PRNEXT_SCRIPTS__) {
  const state = registry();
  if (state.before) return state.before;
  state.before = (queue || []).reduce((previous, [src, props]) => previous.then(() => new Promise((resolve, reject) => {
    const element = document.createElement('script');
    if (props) setAttributes(element, props);
    if (src) {
      element.src = src;
      element.onload = () => resolve();
      element.onerror = reject;
    } else if (props) {
      element.innerHTML = props.children;
      window.setTimeout(resolve, 0);
    } else { resolve(); return; }
    document.head.appendChild(element);
  })), Promise.resolve()).catch(error => {
    // As in Next, one failed blocking script stops the remaining queue but
    // must not prevent the application itself from hydrating.
    console.error(error);
  });
  return state.before;
}

module.exports = { loadScript, loadLazyScript, isScriptLoaded, markScriptLoaded, setAttributes, insertStylesheets,
  handleClientScriptLoad, initScriptLoader, markBeforeInteractive, loadBeforeInteractive };
