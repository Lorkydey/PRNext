import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeAppConfig } from './app-config.mjs';

const group = part => /^\([^()]+\)$/.test(part);
const signature = pattern => pattern.replace(/\[\[\.\.\.[^\]]+\]\]/g, '[[...]]').replace(/\[\.\.\.[^\]]+\]/g, '[...]').replace(/\[[^\]]+\]/g, '[]');
export const rootLayoutId = file => file ? createHash('sha256').update(file).digest('hex').slice(0, 20) : undefined;
export function appRouteParts(parts) {
  let url = [], interception;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.startsWith('@') || group(part)) continue;
    const marker = /^(\(\.\.\.\)|\(\.\)|(?:\(\.\.\))+)(.+)$/.exec(part);
    if (marker) {
      const source = '/' + url.join('/');
      const levels = marker[1] === '(...)' ? url.length : marker[1] === '(.)' ? 0 : marker[1].length / 4;
      if (levels > url.length) throw new Error(`Intercepting route ${parts.join('/')} traverses above the app root.`);
      url = [...url.slice(0, url.length - levels), marker[2]];
      interception = { source, anchor: parts.slice(0, index).join('/'), marker: marker[1], ...(interception ? { parent: interception } : {}) };
    } else url.push(part.replace(/^%5f/i, '_'));
  }
  return { url, interception };
}

function compatible(left, right, prefix = false) {
  const a = left.split('/').filter(Boolean), b = right.split('/').filter(Boolean);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index].startsWith('[...') || a[index].startsWith('[[...') || b[index].startsWith('[...') || b[index].startsWith('[[...')) return true;
    if (!a[index].startsWith('[') && !b[index].startsWith('[') && a[index] !== b[index]) return false;
  }
  return prefix ? a.length <= b.length : a.length === b.length || a.at(-1)?.startsWith('[[...') || b.at(-1)?.startsWith('[[...');
}

/** Build one public route for all slots sharing a pathname, with a pruned component tree. */
export function scanAdvancedAppRoutes({ root, appRoot, directories, configs, routes, patterns, validatePattern }) {
  const nodes = new Map();
  function node(directory) {
    if (nodes.has(directory)) return nodes.get(directory);
    const parts = directory ? directory.split('/') : [];
    const info = appRouteParts(parts);
    const files = directories.get(directory)?.files || {};
    const value = { path: directory, segment: parts.at(-1) || '', pattern: '/' + info.url.join('/'), files,
      layoutId: rootLayoutId(files.layout),
      config: Object.fromEntries(['layout', 'page'].filter(name => files[name]).map(name => [name, configs.get(files[name]) || {}])), children: [], slots: {},
      ...(info.interception ? { interception: info.interception } : {}) };
    nodes.set(directory, value);
    if (parts.length) {
      const parent = node(parts.slice(0, -1).join('/'));
      if (value.segment.startsWith('@')) {
        const name = value.segment.slice(1);
        if (!name || name === 'children' || !/^[A-Za-z_$][\w$-]*$/.test(name)) throw new Error(`Invalid parallel route slot ${value.segment} in ${directory}.`);
        parent.slots[name] = value;
      } else parent.children.push(value);
    }
    return value;
  }
  node('');
  for (const directory of directories.keys()) node(directory);
  const leaves = [];
  for (const value of nodes.values()) {
    if (!value.files.page && !value.files.route) continue;
    if (value.files.page && value.files.route) throw new Error(`App page and Route Handler conflict in ${value.path}.`);
    const file = value.files.page || value.files.route;
    value.pattern = validatePattern(appRouteParts(value.path.split('/').filter(Boolean)).url, path.relative(root, file));
    if (value.files.route) {
      if (value.interception) throw new Error(`Route Handlers cannot be intercepted: ${file}.`);
      const key = signature(value.pattern);
      if (patterns.has(key)) throw new Error(`Conflicting routes: ${patterns.get(key)} and ${file}.`);
      patterns.set(key, file);
      routes.push({ id: `app-api-${createHash('sha256').update(value.pattern).digest('hex').slice(0, 12)}`, pattern: value.pattern, kind: 'api', router: 'app', file,
        cacheConfig: mergeAppConfig([configs.get(file) || {}]), handlerConfig: configs.get(file) || {} });
    } else leaves.push(value);
  }
  const publicPatterns = new Map();
  for (const leaf of leaves) {
    const key = signature(leaf.pattern);
    if (!publicPatterns.has(key)) publicPatterns.set(key, { pattern: leaf.pattern, leaves: [] });
    const collection = publicPatterns.get(key).leaves;
    const channel = leaf.path.split('/').map((part, index, parts) => part.startsWith('@') ? parts.slice(0, index + 1).join('/') : '').filter(Boolean).join('|');
    if (!leaf.interception && collection.some(other => !other.interception && other.channel === channel)) throw new Error(`Conflicting App routes ${leaf.files.page} and another page in ${channel || 'children'}.`);
    leaf.channel = channel;
    collection.push(leaf);
  }
  function chain(leaf) {
    const parts = leaf.path ? leaf.path.split('/') : [];
    return Array.from({ length: parts.length + 1 }, (_, index) => nodes.get(parts.slice(0, index).join('/'))).filter(Boolean);
  }
  function prune(value, pattern) {
    const children = value.children.map(child => prune(child, pattern)).filter(Boolean);
    const slots = Object.fromEntries(Object.entries(value.slots).map(([name, child]) => [name, prune(child, pattern) || { path: child.path, segment: child.segment, pattern: child.pattern, files: {}, children: [], slots: {} }]));
    const page = value.files.page && compatible(value.pattern, pattern) ? value.files.page : undefined;
    const defaultFile = value.files.default && compatible(value.pattern, pattern, true) ? value.files.default : undefined;
    if (value.path && !page && !defaultFile && !children.length && !Object.keys(slots).length && !value.segment.startsWith('@') && !compatible(value.pattern, pattern, true)) return null;
    const { route, page: ignoredPage, default: ignoredDefault, ...files } = value.files;
    return { ...value, files: { ...files, ...(page ? { page } : {}), ...(defaultFile ? { default: defaultFile } : {}) }, children, slots };
  }
  for (const [key, item] of publicPatterns) {
    if (patterns.has(key)) throw new Error(`Conflicting routes: ${patterns.get(key)} and ${item.pattern} (App Router).`);
    patterns.set(key, item.leaves[0].files.page);
    const primary = leaves.find(leaf => !leaf.channel && !leaf.interception && leaf.pattern === item.pattern)
      || leaves.find(leaf => !leaf.channel && !leaf.interception && compatible(leaf.pattern, item.pattern))
      || item.leaves.find(leaf => !leaf.interception) || item.leaves[0];
    // Native matching uses one name per public URL. Keep each slot's own names
    // in its component tree, but choose the canonical children names publicly.
    if (signature(primary.pattern) === key) item.pattern = primary.pattern;
    const parents = chain(primary);
    const segments = parents.filter(value => !value.segment.startsWith('@') && !value.interception).map(value => {
      const { page, route, default: defaultFile, ...files } = value.files;
      return { segment: value.segment, path: value.path, ...files, ...(files.layout ? { staticConfig: configs.get(files.layout) || {} } : {}) };
    });
    if (!segments.some(segment => segment.layout)) throw new Error(`App route ${item.pattern} needs a root layout.`);
    const activeLeaves = leaves.filter(leaf => !leaf.interception && compatible(leaf.pattern, item.pattern));
    const configuration = [...new Set(activeLeaves.flatMap(leaf => [...chain(leaf).map(parent => parent.files.layout).filter(Boolean), leaf.files.page]))];
    routes.push({ id: `app-page-${createHash('sha256').update(item.pattern).digest('hex').slice(0, 12)}`, pattern: item.pattern, kind: 'page', router: 'app', file: primary.files.page,
      segments, pageConfig: configs.get(primary.files.page) || {}, cacheConfig: mergeAppConfig(configuration.map(file => configs.get(file) || {})),
      routing: prune(nodes.get(''), item.pattern), parallel: true, interception: item.leaves.some(leaf => !!leaf.interception),
      interceptionOnly: activeLeaves.length === 0 });
  }
}
