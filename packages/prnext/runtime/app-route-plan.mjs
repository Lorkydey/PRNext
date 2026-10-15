// Cache only the compiler-owned, immutable routing scaffold. Component modules,
// configuration, request parameters and rendered trees are never memoized here.
const plans = new WeakMap();
const liveTrees = new WeakSet();
const ownValue = (object, name) => Object.getOwnPropertyDescriptor(object, name)?.value;
function frozenRecord(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  if (Array.isArray(value) && Object.hasOwn(value, Symbol.iterator)) return false;
  return Reflect.ownKeys(value).every(key => 'value' in Object.getOwnPropertyDescriptor(value, key));
}

/** Mutable development/custom trees continue through the live traversal. */
export function appRoutePlan(root) {
  if (!root || !Object.isFrozen(root)) return null;
  const existing = plans.get(root);
  if (existing) return existing;
  if (liveTrees.has(root)) return null;
  const pages = [], nodes = new Map(), rootLayouts = new Set();
  let sequence = 0;
  function visit(node, chain, branch, hasLayout) {
    if (!frozenRecord(node)) return false;
    const children = ownValue(node, 'children'), slots = ownValue(node, 'slots'), files = ownValue(node, 'files');
    if (!Array.isArray(children) || !frozenRecord(children) || !frozenRecord(slots) || !frozenRecord(files)
      || typeof ownValue(node, 'path') !== 'string' || typeof ownValue(node, 'pattern') !== 'string'
      || typeof ownValue(node, 'segment') !== 'string' || nodes.has(node)) return false;
    // Bound retained chains even for hand-written frozen manifests.
    if (sequence >= 4096 || chain.length >= 64) return false;
    const next = [...chain, node], start = sequence++;
    const info = { start, end: start, depth: chain.length, branch, slots: Object.entries(slots), metadataSlots: Object.entries(slots).sort(([a], [b]) => a.localeCompare(b)) };
    nodes.set(node, info);
    if (files.layout && !hasLayout) rootLayouts.add(node.path);
    if (files.page) pages.push({ node, chain: next, start, branch,
      score: node.pattern.split('/').filter(Boolean).reduce((sum, value) => sum + (value.startsWith('[[...') ? 0 : value.startsWith('[...') ? 1 : value.startsWith('[') ? 3 : 6), 0) });
    for (const child of children) if (!visit(child, next, branch, hasLayout || !!files.layout)) return false;
    for (const child of Object.values(slots)) if (!visit(child, next, child, hasLayout || !!files.layout)) return false;
    info.end = sequence;
    return true;
  }
  if (!visit(root, [], root, false)) { liveTrees.add(root); return null; }
  const plan = { pages, nodes, rootLayouts };
  plans.set(root, plan);
  return plan;
}
