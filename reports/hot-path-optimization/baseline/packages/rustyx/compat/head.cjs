'use strict';
const React = require('react');
const HeadContext = React.createContext(null);

function flatten(children, result = []) {
  React.Children.forEach(children, child => {
    if (!React.isValidElement(child)) return;
    if (child.type === React.Fragment) flatten(child.props.children, result);
    else if (typeof child.type === 'string') result.push(child);
  });
  return result;
}

function headKey(element) {
  if (element.type === 'title' || element.type === 'base') return element.type;
  if (element.key && !String(element.key).startsWith('.')) return `key:${element.key}`;
  if (element.type === 'meta') {
    for (const key of ['charSet', 'name', 'httpEquiv', 'property', 'itemProp']) {
      if (element.props[key] !== undefined) return key === 'charSet' ? 'meta:charSet' : `meta:${key}:${element.props[key]}`;
    }
  }
  return null;
}

function dedupeHead(elements) {
  const keys = new Set();
  const tags = new Set();
  const categories = new Map();
  return elements.slice().reverse().filter(element => {
    if (!React.isValidElement(element)) return false;
    let key = element.key;
    if (typeof key === 'string' && key.startsWith('.')) key = key.includes('$') ? key.slice(key.indexOf('$') + 1) : null;
    const hasKey = key != null;
    let unique = true;
    if (hasKey) {
      if (keys.has(key)) unique = false;
      else keys.add(key);
    }
    if (element.type === 'title' || element.type === 'base') {
      if (tags.has(element.type)) unique = false;
      else tags.add(element.type);
    } else if (element.type === 'meta') {
      // Next treats explicit keys and metadata categories independently. In
      // particular, a keyed viewport replaces the unkeyed default, while
      // distinct keyed name tags and repeated Open Graph properties survive.
      for (const name of ['name', 'httpEquiv', 'charSet', 'itemProp']) {
        if (!Object.hasOwn(element.props, name)) continue;
        const value = name === 'charSet' ? '' : element.props[name];
        let seen = categories.get(name);
        if (!seen) categories.set(name, seen = new Set());
        if ((name !== 'name' || !hasKey) && seen.has(value)) unique = false;
        else seen.add(value);
      }
    }
    return unique;
  }).reverse();
}

function defaultHead() {
  return [React.createElement('meta', { charSet: 'utf-8' }),
    React.createElement('meta', { name: 'viewport', content: 'width=device-width' })];
}

function executableScript(node) {
  return node.tagName === 'SCRIPT' && node.getAttribute('type')?.toLowerCase() !== 'application/ld+json';
}

function headNode(element) {
  const jsonLd = element.type === 'script' && String(element.props.type).toLowerCase() === 'application/ld+json';
  if (element.type === 'script' && !jsonLd) {
    console.warn('Rustyx Head does not apply executable script updates in the browser. Server-rendered scripts are preserved.');
    return null;
  }
  if (!jsonLd && !['title', 'meta', 'link', 'base', 'style'].includes(element.type)) return null;
  const node = document.createElement(element.type);
  for (const [key, value] of Object.entries(element.props)) {
    if (['children', 'dangerouslySetInnerHTML'].includes(key) || key.startsWith('on') || value == null || value === false) continue;
    const attribute = ({ charSet: 'charset', httpEquiv: 'http-equiv', className: 'class', crossOrigin: 'crossorigin' })[key] || key;
    node.setAttribute(attribute, value === true ? '' : String(value));
  }
  if (typeof element.props.children === 'string' || typeof element.props.children === 'number') node.textContent = String(element.props.children);
  else if ((element.type === 'style' || jsonLd) && element.props.dangerouslySetInnerHTML?.__html !== undefined) node.textContent = element.props.dangerouslySetInnerHTML.__html;
  node.setAttribute('data-rustyx-head', '');
  return node;
}

function pageHeadManager() {
  const mounted = new Map();
  let anchor;
  let active = true;
  function reconcile() {
    if (!active) return;
    const existing = [...document.head.querySelectorAll('[data-rustyx-head]')].filter(node => !executableScript(node));
    if (!anchor) {
      anchor = document.createComment('rustyx-head');
      document.head.insertBefore(anchor, existing[0] || document.head.firstChild);
    }
    const entries = dedupeHead([...defaultHead(), ...[...mounted.values()].flat()]);
    const wanted = entries.map(headNode).filter(Boolean).map(node => {
      const index = existing.findIndex(old => old.isEqualNode(node));
      return index < 0 ? node : existing.splice(index, 1)[0];
    });
    for (const node of existing) node.remove();
    // Keep managed page tags before the Document's unmanaged children. Moving
    // them to the end changes which of two title tags the browser observes.
    let cursor = anchor;
    for (let index = wanted.length - 1; index >= 0; index--) {
      const node = wanted[index];
      if (node.nextSibling !== cursor) document.head.insertBefore(node, cursor);
      cursor = node;
    }
  }
  return {
    set(owner, entries) { mounted.set(owner, entries); reconcile(); },
    delete(owner) { mounted.delete(owner); reconcile(); },
    activate() { active = true; reconcile(); },
    dispose() { active = false; mounted.clear(); anchor?.remove(); anchor = undefined; },
  };
}

function HeadProvider({ collector, restoreDefaults = false, children }) {
  const owned = React.useRef([]);
  const manager = React.useRef(null);
  if (restoreDefaults && !manager.current) manager.current = pageHeadManager();
  const value = React.useMemo(() => ({ collector: collector || owned.current, manager: restoreDefaults ? manager.current : null }), [collector, restoreDefaults]);
  React.useEffect(() => {
    if (!restoreDefaults) return;
    manager.current.activate();
    return () => manager.current.dispose();
  }, [restoreDefaults]);
  return React.createElement(HeadContext.Provider, { value }, children);
}

function Head({ children }) {
  const value = React.useContext(HeadContext);
  const collector = Array.isArray(value) ? value : value?.collector;
  const manager = value?.manager;
  const owner = React.useId();
  const entries = flatten(children).map(element => React.cloneElement(element, { 'data-rustyx-head-owner': owner }));
  if (typeof document === 'undefined') {
    if (!collector) throw new Error('Head must be used inside the Rustyx head provider');
    collector.push(...entries);
  }
  React.useEffect(() => {
    if (manager) {
      manager.set(owner, entries);
      return () => manager.delete(owner);
    }
    // Hydration starts with the server head. Apply component updates without executing scripts.
    const installed = [];
    for (const existing of document.head.querySelectorAll('[data-rustyx-head-owner]')) {
      if (existing.getAttribute('data-rustyx-head-owner') !== owner) continue;
      // Executable scripts emitted by SSR already ran. Leave them in place;
      // reinserting them during hydration would run application code twice.
      if (executableScript(existing)) continue;
      existing.remove();
    }
    for (const element of dedupeHead(entries)) {
      const node = headNode(element);
      if (!node) continue;
      const identity = headKey(element);
      if (identity) {
        for (const existing of document.head.querySelectorAll('[data-rustyx-head]')) {
          if (element.type === 'title' && existing.tagName === 'TITLE') existing.remove();
          else if (element.type === 'meta' && existing.tagName === 'META' && ['name', 'property', 'http-equiv', 'charset', 'itemprop'].some(attribute => node.hasAttribute(attribute) && existing.getAttribute(attribute) === node.getAttribute(attribute))) existing.remove();
        }
      }
      document.head.appendChild(node);
      installed.push(node);
    }
    return () => { for (const node of installed) node.remove(); };
  }, [children, owner, manager]);
  return null;
}

module.exports = Head;
module.exports.default = Head;
module.exports.HeadProvider = HeadProvider;
module.exports.HeadContext = HeadContext;
module.exports.dedupeHead = dedupeHead;
