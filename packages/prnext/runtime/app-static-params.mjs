import { currentRequest } from '../compat/headers.cjs';

const MAX_PATHS = 10_000;
const MAX_PARAMS_BYTES = 4 * 1024 * 1024;
const objectConstructor = Function.prototype.toString.call(Object);
function plainParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  // An Edge realm has its own Object.prototype. Accept its ordinary objects,
  // while still rejecting application class instances and custom prototypes.
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return Object.getPrototypeOf(prototype) === null && typeof constructor === 'function' && Function.prototype.toString.call(constructor) === objectConstructor;
}

function names(pattern) {
  return new Set([...String(pattern || '').matchAll(/\[(?:\[)?(?:\.\.\.)?([^\]]+)\]\]?/g)].map(match => match[1]));
}

function publicParams(row, branchPattern, routePattern) {
  const source = branchPattern.split('/').filter(Boolean), target = routePattern.split('/').filter(Boolean);
  const result = {};
  const name = part => /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(part)?.[1];
  for (let index = 0; index < target.length; index++) {
    const targetName = name(target[index]);
    if (!targetName) continue;
    const sourceName = name(source[index] || '');
    if (sourceName && Object.hasOwn(row, sourceName)) result[targetName] = row[sourceName];
    else if (!sourceName && source[index]) result[targetName] = source[index];
  }
  return result;
}

export function validateRuntimeStaticConfig(entry) {
  const fields = ['dynamic', 'dynamicParams', 'instant', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'experimental_ppr'];
  const modules = (entry.segments || []).filter(segment => segment.staticConfig !== undefined)
    .map(segment => [segment.layout, segment.staticConfig]);
  if (entry.pageConfig !== undefined) modules.push([entry.page, entry.pageConfig]);
  for (const [module, config] of modules) {
    if (!module || module.default?.$$typeof === Symbol.for('react.client.reference')) continue;
    for (const field of fields) {
      if (module[field] !== undefined && (!Object.hasOwn(config, field) || JSON.stringify(module[field]) !== JSON.stringify(config[field]))) {
        throw new Error(`Statically analyzable route config required: ${field} cannot be hidden behind wildcard re-exports`);
      }
    }
  }
}

export async function collectStaticParams(entry, routePattern, memo = new Map()) {
  validateRuntimeStaticConfig(entry);
  if (entry.routing) {
    const branches = [];
    function visit(node, parents = []) {
      if (node.interception) return;
      const segments = [...parents, { layout: node.files.layout, staticConfig: node.config?.layout || {}, path: node.pattern }];
      if (node.files.page) branches.push({ page: node.files.page, pageConfig: node.config?.page || {}, segments, pattern: node.pattern });
      for (const child of [...node.children, ...Object.values(node.slots)]) visit(child, segments);
    }
    visit(entry.routing);
    const params = new Map();
    let generated = false, bytes = 0;
    for (const branch of branches) {
      const result = await collectStaticParams(branch, branch.pattern, memo);
      generated ||= result.generated;
      for (const branchRow of result.params) {
        const row = publicParams(branchRow, branch.pattern, routePattern);
        const key = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
        if (params.has(key)) continue;
        bytes += Buffer.byteLength(key);
        if (params.size >= MAX_PATHS || bytes > MAX_PARAMS_BYTES) throw new Error('generateStaticParams exceeds the PRNext path generation limit');
        params.set(key, row);
      }
    }
    return { params: [...params.values()], generated };
  }
  let params = [{}];
  let generated = false;
  const generators = (entry.segments || []).map(segment => ({ module: segment.layout, scope: segment.path || segment.segment || '' }));
  generators.push({ module: entry.page, scope: routePattern });
  for (const { module, scope } of generators) {
    if (module?.generateStaticParams === undefined) continue;
    if (typeof module.generateStaticParams !== 'function') throw new Error('generateStaticParams must export a function');
    generated = true;
    const allowed = names(scope);
    const expanded = [];
    let bytes = 0;
    for (const parent of params) {
      let results = memo.get(module.generateStaticParams);
      if (!results) memo.set(module.generateStaticParams, results = new Map());
      const parentKey = JSON.stringify(parent);
      if (!results.has(parentKey)) results.set(parentKey, Promise.resolve().then(() => module.generateStaticParams({ params: { ...parent } })));
      const rows = await results.get(parentKey);
      if (!Array.isArray(rows)) throw new Error('generateStaticParams must return an array of parameter objects');
      let cacheComponents = false;
      try { cacheComponents = currentRequest().cacheComponents === true; } catch { /* Direct inspection outside a request. */ }
      if (cacheComponents && rows.length === 0) throw new Error(`generateStaticParams for ${scope || '/'} must return at least one parameter object when cacheComponents is enabled.`);
      for (const row of rows) {
        if (!plainParams(row)) {
          throw new Error('generateStaticParams must return plain parameter objects');
        }
        for (const [key, value] of Object.entries(row)) {
          if (!allowed.has(key)) throw new Error(`generateStaticParams cannot generate child or unknown parameter ${key} from segment ${scope || '/'}`);
          const absentOptional = String(scope).includes(`[[...${key}]]`) && (value === undefined || value === null || value === false);
          if (!absentOptional && typeof value !== 'string' && (!Array.isArray(value) || Array.from(value).some(part => typeof part !== 'string'))) {
            throw new Error(`generateStaticParams parameter ${key} must be a string or array of strings`);
          }
          if (Object.hasOwn(parent, key) && JSON.stringify(parent[key]) !== JSON.stringify(value)) {
            throw new Error(`generateStaticParams cannot overwrite parent parameter ${key}`);
          }
        }
        const combined = { ...parent, ...row };
        bytes += Buffer.byteLength(JSON.stringify(combined));
        if (expanded.length >= MAX_PATHS || bytes > MAX_PARAMS_BYTES) throw new Error('generateStaticParams exceeds the PRNext path generation limit');
        expanded.push(combined);
      }
    }
    params = expanded;
  }
  return { params, generated };
}
