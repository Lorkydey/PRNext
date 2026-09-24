import React from 'react';
import { instantEnabled } from '../compat/instant.cjs';
import { Metadata } from './app-metadata.mjs';
import { removeBasePath } from '../compat/paths.cjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentRequest, runRequestContext } from '../compat/headers.cjs';
import { staticParams } from '../compat/static-generation.cjs';

export function matchAppPattern(pattern, pathname, prefix = false) {
  const expected = pattern.split('/').filter(Boolean), raw = pathname.split('/').filter(Boolean);
  let parts;
  try { parts = raw.map(decodeURIComponent); } catch { return null; }
  const params = {};
  for (let index = 0; index < expected.length; index++) {
    const segment = expected[index];
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (optional || catchAll) {
      if (catchAll && index >= parts.length) return null;
      if (index < parts.length) params[(optional || catchAll)[1]] = parts.slice(index);
      return params;
    }
    const dynamic = /^\[([^\]]+)\]$/.exec(segment);
    if (index >= parts.length) return null;
    if (dynamic) params[dynamic[1]] = parts[index];
    else if (segment !== parts[index]) return null;
  }
  return prefix || expected.length === parts.length ? params : null;
}

export function readRouterState(request) {
  if (!Object.entries(request.headers || {}).some(([name, value]) => name.toLowerCase() === 'rsc' && value === '1')) return null;
  const value = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'x-rustyx-router-state')?.[1];
  if (typeof value !== 'string' || value.length > 24 * 1024) return null;
  try {
    const state = JSON.parse(value.startsWith('{') ? value : decodeURIComponent(value));
    const localURL = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(value) && value.length <= 4096;
    if (!state || typeof state !== 'object' || !localURL(state.source) || !state.slots || typeof state.slots !== 'object' || Array.isArray(state.slots) || Object.keys(state.slots).length > 256) return null;
    const slots = {};
    for (const [key, slot] of Object.entries(state.slots)) {
      if (key.length > 4096 || !slot || typeof slot.branch !== 'string' || slot.branch.length > 4096 || !localURL(slot.url)) return null;
      if (slot.source !== undefined && !localURL(slot.source)) return null;
      if (slot.accessUrl !== undefined && !localURL(slot.accessUrl)) return null;
      slots[key] = { branch: slot.branch, url: slot.url, ...(slot.source ? { source: slot.source } : {}), ...(slot.accessUrl ? { accessUrl: slot.accessUrl } : {}) };
    }
    return { source: removeBasePath(new URL(state.source, 'http://rustyx.local').pathname, request.basePath), slots, restore: state.restore === true, refresh: state.refresh === true };
  } catch { return null; }
}

/** Resolve saved URLs only through the trusted build manifest, never to user-provided module paths. */
export function advancedRoutingSources(request, routes) {
  const state = readRouterState(request);
  if (!state) return [];
  const modules = new Set();
  for (const saved of Object.values(state.slots)) {
    const pathname = new URL(saved.url, 'http://rustyx.local').pathname;
    const route = routes.filter(item => item.router === 'app' && item.kind === 'page' && !item.internal && matchAppPattern(item.pattern, pathname))
      .sort((a, b) => score(b.pattern) - score(a.pattern))[0];
    if (route) modules.add(route.module);
  }
  return [...modules];
}

export async function loadAdvancedRouting(entry, request) {
  if (!entry.routing || !request.routingSources?.length) return entry;
  function merge(current, extra) {
    if (!extra) return current;
    if (!current) return extra;
    const children = new Map(current.children.map(child => [child.path, child]));
    for (const child of extra.children) children.set(child.path, merge(children.get(child.path), child));
    const slots = { ...current.slots };
    for (const [name, child] of Object.entries(extra.slots)) slots[name] = merge(slots[name], child);
    return { ...current, files: { ...extra.files, ...current.files }, children: [...children.values()], slots };
  }
  let routing = entry.routing;
  const metadataFiles = new Map((entry.metadataFiles || []).map(file => [JSON.stringify([file.path, file.pattern]), file]));
  for (const module of request.routingSources) {
    const extra = await import(pathToFileURL(path.join(request.distDir, module)).href);
    if (extra.routing) routing = merge(routing, extra.routing);
    for (const file of extra.metadataFiles || []) metadataFiles.set(JSON.stringify([file.path, file.pattern]), file);
  }
  return { ...entry, routing, metadataFiles: [...metadataFiles.values()] };
}

function component(module, label) {
  if (!module?.default) throw new Error(`App Router ${label} must export a default component`);
  return module.default;
}
function score(pattern) {
  return pattern.split('/').filter(Boolean).reduce((sum, value) => sum + (value.startsWith('[[...') ? 0 : value.startsWith('[...') ? 1 : value.startsWith('[') ? 3 : 6), 0);
}
function selectedSegments(chain, params) {
  return chain.map(node => {
    const value = node.segment.replace(/^(?:\(\.\.\.\)|\(\.\)|(?:\(\.\.\))+)/, '');
    if (!value || value.startsWith('@')) return null;
    const name = /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(value)?.[1];
    if (name) return Array.isArray(params[name]) ? params[name].join('/') : params[name] ?? null;
    return value;
  }).filter(value => value !== null);
}

/** Parallel slots retain their original Flight children on soft navigation. */
export function createAdvancedTree(entry, request, searchParams) {
  const pathname = removeBasePath(new URL(request.url).pathname, request.basePath || '');
  const old = readRouterState(request), slots = {}, activeParams = { ...request.params };
  const rebuild = !!old && (old.refresh || old.restore || request.method === 'POST');
  let invalid = false;
  const root = entry.routing;
  let metadataHead;
  const keyScopes = new Map();
  const instantTrees = [];
  function registerKey(key, node, prefix, suffix = '', liveProps, values = scopedParams(node), segments) {
    if (request.partialParams?.length) keyScopes.set(key, { key, prefix, suffix, names: Object.keys(values), pattern: node.pattern, ...(liveProps ? { liveProps } : {}), ...(segments ? { segments } : {}) });
    return key;
  }
  const rootLayouts = new Set();
  const metadataSelections = new Map();
  let missing = entry.interceptionOnly && !old, rootPage;
  const all = [];
  function walk(node, chain = []) {
    const next = [...chain, node];
    if (node.files.layout && !chain.some(parent => parent.files.layout)) rootLayouts.add(node.path);
    if (node.files.page) all.push({ node, chain: next, params: matchAppPattern(node.pattern, pathname) });
    for (const child of node.children) walk(child, next);
    for (const child of Object.values(node.slots)) walk(child, next);
  }
  walk(root);
  let activeInterceptions;
  function canIntercept(candidate) {
    if (!candidate.node.interception || !old) return false;
    for (let parent = candidate.node.interception.parent; parent; parent = parent.parent) {
      const prefix = parent.anchor ? `${parent.anchor}/${parent.marker}` : parent.marker;
      if (!Object.values(old.slots).some(slot => slot.branch.startsWith(prefix))) return false;
    }
    const { source, anchor } = candidate.node.interception;
    return (!activeInterceptions || activeInterceptions.has(candidate.node.path)) && (!!matchAppPattern(source, old.source, true) || Object.entries(old.slots).some(([key, value]) => key.startsWith(`${anchor}::`) && matchAppPattern(source, new URL(value.source || value.url, request.url).pathname, true)));
  }
  const eligibleInterceptions = all.filter(candidate => candidate.params && canIntercept(candidate));
  const priority = candidate => candidate.node.interception.source.split('/').filter(Boolean).length * 1000 + candidate.node.interception.anchor.split('/').filter(Boolean).length;
  const mostSpecific = Math.max(-1, ...eligibleInterceptions.map(priority));
  const interceptions = eligibleInterceptions.filter(candidate => priority(candidate) === mostSpecific);
  activeInterceptions = new Set(interceptions.map(candidate => candidate.node.path));
  const interceptOwners = new Set(interceptions.map(candidate => {
    const parts = candidate.node.interception.anchor.split('/');
    const index = parts.findLastIndex(part => part.startsWith('@'));
    return index < 0 ? null : parts.slice(0, index).join('/');
  }).filter(value => value !== null));
  function candidates(node, chain = []) {
    const result = [], next = [...chain, node];
    if (node.files.page) {
      const params = matchAppPattern(node.pattern, pathname);
      if (params && (!node.interception || canIntercept({ node }))) result.push({ node, chain: next, params });
    }
    for (const child of node.children) result.push(...candidates(child, next));
    return result.sort((left, right) => Number(!!right.node.interception) - Number(!!left.node.interception) || score(right.node.pattern) - score(left.node.pattern));
  }
  function scopedParams(node) {
    const current = matchAppPattern(node.pattern, pathname, true) || (old && matchAppPattern(node.pattern, old.source, true));
    if (current) return current;
    for (const [key, value] of Object.entries(old?.slots || {})) {
      if (!key.startsWith(`${node.path}::`)) continue;
      const saved = matchAppPattern(node.pattern, new URL(value.source || value.url, request.url).pathname, true);
      if (saved) return saved;
    }
    return {};
  }
  function scope(node) {
    return registerKey(`${node.path}::${JSON.stringify(scopedParams(node))}`, node, `${node.path}::`);
  }
  function sourceURL(node, previous) {
    return matchAppPattern(node.pattern, pathname, true) ? pathname + new URL(request.url).search : previous?.source || previous?.url || old?.source || pathname;
  }
  function accessURL(url, previous) {
    if (previous?.url === url && previous.accessUrl) return previous.accessUrl;
    const current = new URL(request.url), visible = new URL(request.originalUrl || request.url);
    const access = removeBasePath(visible.pathname, request.basePath) + visible.search;
    if (url === pathname + current.search && access !== url) return access;
  }
  function savedBranch(node, saved, chain = []) {
    const next = [...chain, node];
    const fallback = saved.branch.endsWith('#default');
    const target = fallback ? saved.branch.slice(0, -8) : saved.branch;
    if (node.path === target && node.files[fallback ? 'default' : 'page']) {
      const url = new URL(saved.url, request.url);
      const params = matchAppPattern(node.pattern, url.pathname, fallback);
      if (!params) return;
      const query = {};
      for (const [name, value] of url.searchParams) {
        if (name === '_rsc') continue;
        Object.defineProperty(query, name, { value: Object.hasOwn(query, name) ? [...(Array.isArray(query[name]) ? query[name] : [query[name]]), value] : value, enumerable: true, configurable: true });
      }
      return { node, chain: next, params, default: fallback, url: saved.url, accessUrl: saved.accessUrl, searchParams: Promise.resolve(query) };
    }
    for (const child of node.children) {
      const selected = savedBranch(child, saved, next);
      if (selected) return selected;
    }
  }
  function slot(node, owner, name) {
    const key = registerKey(`${scope(owner)}::${name}`, owner, `${owner.path}::`, `::${name}`, ['id']);
    const previous = old?.slots[key];
    let choices = candidates(node);
    let selected = rebuild && previous ? savedBranch(node, previous) : choices[0];
    if (rebuild && previous && !selected) { invalid = true; return { tree: null, segments: [] }; }
    if (!rebuild) {
      for (const candidate of interceptions) {
        const start = candidate.chain.indexOf(node);
        const slotIndex = candidate.chain.findIndex((item, index) => index > start && item.segment.startsWith('@'));
        if (start < 0 || slotIndex < 0) continue;
        const owner = candidate.chain[slotIndex - 1];
        selected = { node: owner, chain: candidate.chain.slice(start, slotIndex), params: candidate.params,
          default: !!owner.files.default, preserve: !owner.files.default, scaffold: true };
        break;
      }
    }
    if (!selected) {
      for (const candidate of all) {
        if (!candidate.params || candidate.node.interception) continue;
        const start = candidate.chain.indexOf(node);
        if (start < 0) continue;
        const slotIndex = candidate.chain.findIndex((item, index) => index > start && item.segment.startsWith('@'));
        if (slotIndex < 0) continue;
        const owner = candidate.chain[slotIndex - 1];
        selected = { node: owner, chain: candidate.chain.slice(start, slotIndex), params: candidate.params,
          default: !!owner.files.default, preserve: !owner.files.default, scaffold: true };
        break;
      }
    }
    const preserve = !!previous && !rebuild && (!selected || (name === 'children' && interceptOwners.has(owner.path)));
    if (preserve) {
      slots[key] = previous;
      const saved = savedBranch(node, previous);
      if (saved) {
        metadataSelections.set(saved.node.path, saved);
        if (name === 'children' && owner === root) rootPage = saved;
      }
      return { tree: React.createElement(entry.LayoutSlot, { key, id: key, preserve: true }), segments: null };
    }
    if (!selected) {
      // Find the nearest default whose route prefix contains the destination.
      const defaults = [];
      function findDefault(value, chain = []) {
        if (!matchAppPattern(value.pattern, pathname, true) || (value.interception && !old)) return;
        const next = [...chain, value];
        if (value.files.default) defaults.push({ node: value, chain: next, params: matchAppPattern(value.pattern, pathname, true), default: true });
        for (const child of value.children) findDefault(child, next);
      }
      findDefault(node);
      selected = defaults.sort((a, b) => b.chain.length - a.chain.length)[0];
    }
    if (!selected) { missing = true; return { tree: null, segments: [] }; }
    if (selected.scaffold) selected.url = previous?.url || sourceURL(selected.node, previous);
    Object.assign(activeParams, selected.params);
    metadataSelections.set(selected.node.path, selected);
    const selectedURL = selected.url || pathname + new URL(request.url).search;
    slots[key] = { branch: selected.node.path + (selected.default ? '#default' : ''), url: selectedURL, source: sourceURL(owner, previous), accessUrl: selected.accessUrl || accessURL(selectedURL, previous) };
    if (name === 'children' && owner === root) rootPage = selected;
    let selectedTree = renderPath(selected.chain, selected, 0, name === 'children' && owner === node);
    const context = request.routingContexts?.get(selectedURL);
    if (context && request.renderRoutingBranch) selectedTree = request.renderRoutingBranch(selectedTree, context);
    const instant=selected.node.config?.page?.instant ?? [...selected.chain].reverse().find(item=>item.config?.layout?.instant!==undefined)?.config.layout.instant;
    if(request.instantValidation && name!=='children' && instantEnabled(instant,request.production)){
      instantTrees.push({path:(owner.path || '/')+' @'+name,tree:selectedTree});
    }
    return { tree: React.createElement(entry.LayoutSlot, { key, id: key, preserve: false }, selectedTree), segments: selected.default ? [] : selectedSegments(selected.chain.slice(node === owner ? 1 : 0), selected.params) };
  }
  function renderPath(chain, selection, index, skipOwner) {
    const node = chain[index];
    const key = scope(node, selection.params);
    const props = { params: staticParams(selection.params, currentRequest()), searchParams: selection.searchParams || searchParams };
    let children;
    if (index + 1 < chain.length) children = renderPath(chain, selection, index + 1, false);
    else if (!selection.preserve) {
      const Page = component(node.files[selection.default ? 'default' : 'page'], selection.default ? 'default' : 'page');
      children = entry.ClientPageRoot && Page.$$typeof === Symbol.for('react.client.reference')
        ? React.createElement(entry.ClientPageRoot, { Component: Page, ...props, key: registerKey(`${node.path}:${JSON.stringify(selection.params)}`, node, `${node.path}:`, '', undefined, selection.params) })
        : React.createElement(Page, { ...props, key: registerKey(`${node.path}:${JSON.stringify(selection.params)}`, node, `${node.path}:`, '', undefined, selection.params) });
    } else children = null;
    if (skipOwner) return children;
    const childKey = registerKey(`${key}::children`, node, `${node.path}::`, '::children', ['id']);
    const previousChild = old?.slots[childKey];
    const preserveChild = !!previousChild && !rebuild && (interceptOwners.has(node.path) || (selection.scaffold && index === chain.length - 1));
    if (rebuild && previousChild && previousChild.branch !== selection.node.path + (selection.default ? '#default' : '')) {
      const saved = savedBranch(node, previousChild);
      if (!saved) invalid = true;
      else {
        metadataSelections.set(saved.node.path, saved);
        children = renderPath(saved.chain, saved, 0, true);
      }
    }
    if (selection.preserve && index === chain.length - 1 && !preserveChild) missing = true;
    const childURL = selection.url || pathname + new URL(request.url).search;
    slots[childKey] = preserveChild || (rebuild && previousChild) ? previousChild : { branch: selection.node.path + (selection.default ? '#default' : ''), url: childURL, source: sourceURL(node, previousChild), accessUrl: selection.accessUrl || accessURL(childURL, previousChild) };
    if (preserveChild) {
      const saved = savedBranch(node, previousChild);
      if (saved) metadataSelections.set(saved.node.path, saved);
    }
    children = React.createElement(entry.LayoutSlot, { key: childKey, id: childKey, preserve: preserveChild }, preserveChild ? null : children);
    const selected = { children: selection.default ? [] : selectedSegments(chain.slice(index + 1), selection.params) };
    if (preserveChild) selected.children = null;
    const parallel = {};
    for (const [name, child] of Object.entries(node.slots)) {
      const rendered = slot(child, node, name);
      parallel[name] = rendered.tree; selected[name] = rendered.segments;
    }
    if (request.instantValidation && node.files.layout) {
      const nextConfig = chain.slice(index + 1).find(item => item.config?.layout?.instant !== undefined)?.config.layout.instant ?? selection.node.config?.page?.instant;
      if (instantEnabled(nextConfig, request.production)) instantTrees.push({ path: node.path || '/', tree: node.files.loading ? React.createElement(React.Suspense, { fallback: React.createElement(component(node.files.loading, 'loading')) }, children) : children });
    }
    return wrap(node, children, parallel, selected, key, selection.params, chain.slice(index + 1).map(item => item.segment), selection.node);
  }
  function wrap(node, children, parallel, selected, key, params, templateSegments, selectionNode) {
    if (node.files.loading) children = React.createElement(React.Suspense, { fallback: React.createElement(component(node.files.loading, 'loading')) }, children);
    if (node.files.error) children = React.createElement(entry.ErrorBoundary, { key: registerKey(`error:${key}`, node, `error:${node.path}::`), errorComponent: component(node.files.error, 'error'), resetKey: request.renderKey }, children);
    if (node.files.notFound || node === root) children = React.createElement(entry.NavigationBoundary, { key: registerKey(`navigation:${key}`, node, `navigation:${node.path}::`), resetKey: request.renderKey,
      notFound: node.files.notFound ? React.createElement(component(node.files.notFound, 'not-found')) : React.createElement('h1', null, '404: This page could not be found.') }, children);
    if (node.files.template) children = React.createElement(component(node.files.template, 'template'), { key: registerKey(selected.children?.join('/') || key, selectionNode || node, `${node.path}::`, '', undefined, scopedParams(node), templateSegments) }, children);
    if (node.files.layout) {
      const scoped = scopedParams(node);
      Object.assign(activeParams, scoped);
      if (rootLayouts.has(node.path) && request.cacheComponents) children = React.createElement(React.Fragment, null, metadataHead, children);
      children = React.createElement(component(node.files.layout, 'layout'), { params: staticParams(scoped, currentRequest()), key, ...parallel }, children);
      children = React.createElement(entry.LayoutProvider, { key: registerKey(`layout:${key}`, node, `layout:${node.path}::`, '', ['id', 'segments']), id: key, segments: selected }, children);
    }
    return children;
  }
  async function RouteMetadata() {
    const layouts = new Map(), pages = new Map();
    for (const selection of metadataSelections.values()) {
      const source = new URL(selection.url || pathname, request.url).pathname;
      for (const node of selection.chain) if (!layouts.has(node.path)) layouts.set(node.path, { node, params: matchAppPattern(node.pattern, source, true) || scopedParams(node), context: node === root ? undefined : request.routingContexts?.get(selection.url) });
      if (!selection.preserve) pages.set(selection.node.path, selection);
    }
    const metadataItems = [];
    function visit(node) {
      const layout = layouts.get(node.path), page = pages.get(node.path);
      if (layout) metadataItems.push({ module: node.files.layout, params: staticParams(layout.params, currentRequest()), filePath: page ? undefined : node.path, context: layout.context });
      // Next orders paths containing named slots before ordinary children,
      // with slot names in locale order (compareAppPaths in its app loader).
      for (const [, child] of Object.entries(node.slots).sort(([a], [b]) => a.localeCompare(b))) visit(child);
      if (page) metadataItems.push({ module: node.files[page.default ? 'default' : 'page'], params: staticParams(page.params, currentRequest()), searchParams: page.searchParams || searchParams, filePath: node.path, context: request.routingContexts?.get(page.url) });
      for (const child of node.children) visit(child);
    }
    visit(root);
    const metadataEntry = { ...entry, metadataItems };
    return runRequestContext({ ...currentRequest(), metadataRendering: true }, () => Metadata({ entry: metadataEntry, params: staticParams(rootPage?.params || request.params || {}, currentRequest()), searchParams,
      pathname, notFoundIndex: missing ? 0 : -1 }));
  }
  const metadata = React.createElement(RouteMetadata, { key: 'metadata' });
  const head = request.cacheComponents ? React.createElement(React.Suspense, { fallback: null, key: 'metadata-boundary' }, metadata) : metadata;
  metadataHead = head;
  const main = slot(root, root, 'children');
  const parallel = {}, selected = { children: main.segments };
  for (const [name, child] of Object.entries(root.slots)) {
    const result = slot(child, root, name);
    parallel[name] = result.tree; selected[name] = result.segments;
  }
  if (invalid) { request.responseStatus = 400; return { tree: null, head: null, routingInvalid: true }; }
  const rootLayoutNode = rootPage?.chain.find(node => node.files.layout) || (root.files.layout ? root : undefined);
  if (request.instantValidation && root.files.layout && instantEnabled(rootPage?.chain.slice(1).find(item => item.config?.layout?.instant !== undefined)?.config.layout.instant ?? rootPage?.node.config?.page?.instant, request.production)) {
    const content = React.createElement(React.Fragment, null, main.tree, ...Object.values(parallel));
    instantTrees.push({ path: root.path || '/', tree: root.files.loading ? React.createElement(React.Suspense, { fallback: React.createElement(component(root.files.loading, 'loading')) }, content) : content });
  }
  const instantDisabled = all.flatMap(item => item.chain).some(node => Object.values(node.config || {}).some(config => config.instant && typeof config.instant === 'object' && (config.instant.unstable_disableValidation || (request.production ? config.instant.unstable_disableBuildValidation : config.instant.unstable_disableDevValidation))));
  let tree = wrap(root, main.tree, parallel, selected, scope(root), {}, rootPage?.chain.slice(1).map(item => item.segment), rootPage?.node);
  if (missing) {
    request.responseStatus = 404;
    const notFound = rootLayoutNode?.files.notFound || root.files.notFound;
    const missingPage = notFound ? React.createElement(component(notFound, 'not-found')) : React.createElement('h1', null, '404: This page could not be found.');
    tree = rootLayoutNode ? React.createElement(component(rootLayoutNode.files.layout, 'layout'), { params: staticParams(scopedParams(rootLayoutNode), currentRequest()), ...Object.fromEntries(Object.keys(rootLayoutNode.slots).map(name => [name, null])) }, request.cacheComponents ? React.createElement(React.Fragment, null, head, missingPage) : missingPage) : missingPage;
  }
  return { tree: request.cacheComponents && rootLayoutNode ? tree : React.createElement(React.Fragment, null, head, tree), head,
    ...(request.instantValidation && !instantDisabled ? { instantTrees } : {}), ...(keyScopes.size ? { keyScopes: [...keyScopes.values()] } : {}), rootLayout: rootLayoutNode?.layoutId || entry.rootLayout, routing: { source: pathname, slots, params: activeParams } };
}
