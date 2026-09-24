import React from 'react';

const ignored = new Set(['strategy', 'onLoad', 'onReady', 'onError', 'stylesheets', 'children', 'dangerouslySetInnerHTML']);
export function scriptJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[char]);
}

export function scriptNonce(headers = {}) {
  const get = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const policy = get('content-security-policy') || get('content-security-policy-report-only');
  if (typeof policy !== 'string') return undefined;
  const directives = policy.split(';').map(value => value.trim());
  const selected = directives.find(value => value.startsWith('script-src')) || directives.find(value => value.startsWith('default-src'));
  for (const value of selected?.split(/\s+/).slice(1) || []) {
    const match = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/.exec(value);
    if (match) return match[1];
  }
}

function scriptElement(props, { nonce, crossOrigin, worker = false } = {}) {
  const attributes = Object.fromEntries(Object.entries(props).filter(([key, value]) => !ignored.has(key) && typeof value !== 'function'));
  const source = props.dangerouslySetInnerHTML ? props.dangerouslySetInnerHTML.__html || ''
    : typeof props.children === 'string' ? props.children : Array.isArray(props.children) ? props.children.join('') : '';
  return React.createElement('script', { ...attributes,
    ...(props.src ? { defer: worker ? undefined : props.defer ?? true } : { dangerouslySetInnerHTML: { __html: source } }),
    nonce: worker || !props.src ? nonce : props.nonce || nonce, crossOrigin,
    ...(worker ? { type: 'text/partytown' } : {}), 'data-nscript': worker ? 'worker' : 'beforeInteractive',
  });
}

/** Finalize after one Document render so scripts below NextScript are included. */
export function completePageScripts(markup, { pageScripts, documentScripts, worker, nonce, crossOrigin }, render) {
  const all = [...pageScripts, ...documentScripts];
  const before = all.filter(props => props.strategy === 'beforeInteractive');
  const inline = before.filter(props => !props.src);
  const external = before.filter(props => props.src);
  const elements = [];
  for (const props of external) elements.push(React.createElement('link', { rel: 'preload', as: 'script', href: props.src,
    nonce, crossOrigin }));
  elements.push(...inline.map(props => scriptElement(props, { nonce, crossOrigin })));
  if (worker) {
    if (!/\bdata-partytown-config(?:[\s=>])/i.test(markup)) elements.push(React.createElement('script', { nonce, 'data-partytown-config': '',
      dangerouslySetInnerHTML: { __html: `partytown={lib:${scriptJSON(worker.lib)}};` } }));
    elements.push(React.createElement('script', { nonce, 'data-partytown': '', dangerouslySetInnerHTML: { __html: worker.snippet } }));
    elements.push(...pageScripts.filter(props => props.strategy === 'worker').map(props => scriptElement(props, { nonce, crossOrigin, worker: true })));
  }
  elements.push(...external.map(props => scriptElement(props, { nonce, crossOrigin })));
  const html = elements.length ? render(React.createElement(React.Fragment, null, ...elements)) : '';
  const target = '<rustyx-document-script-target></rustyx-document-script-target>';
  // Head's children must run first: <base> affects relative script URLs, and a
  // user Partytown configuration must be set before its bootstrap executes.
  markup = markup.includes(target) ? markup.replace(target, () => html).replaceAll(target, '')
    : markup.replace(/<\/head>/i, closing => html + closing);
  const items = documentScripts.filter(props => props.strategy !== 'beforeInteractive');
  if (items.length) {
    const payload = render(React.createElement('script', { id: '__RUSTYX_SCRIPT_LOADER__', type: 'application/json', nonce,
      dangerouslySetInnerHTML: { __html: scriptJSON(items) } }));
    markup = markup.replace(/<\/body>/i, closing => payload + closing);
  }
  return markup;
}
