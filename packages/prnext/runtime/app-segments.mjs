// Weak ownership follows the manifest. Mutable development segment names are
// re-read, and no request parameter or selected segment value is retained.
const syntax = new WeakMap();
function segmentSyntax(segment) {
  const value = segment.segment || '';
  const existing = syntax.get(segment);
  if (existing?.value === value) return existing;
  const parsed = { value, name: /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(value)?.[1] };
  if ((typeof segment === 'object' && segment !== null) || typeof segment === 'function') syntax.set(segment, parsed);
  return parsed;
}

/** Each layout sees only dynamic parameters declared at or above its segment. */
export function paramsBySegment(segments, params = {}) {
  const result = new Map();
  const ancestors = Object.create(null);
  for (const segment of segments) {
    const { name } = segmentSyntax(segment);
    if (name && Object.hasOwn(params, name)) ancestors[name] = params[name];
    result.set(segment, { ...ancestors });
  }
  return result;
}

export function selectedLayoutSegments(segments, params = {}, start = 0) {
  const selected = [];
  for (let index = start, length = segments.length; index < length; index++) {
    if (!(index in segments)) continue;
    const { value, name } = segmentSyntax(segments[index]);
    if (!value || value.startsWith('@')) continue;
    if (!name) { selected.push(value); continue; }
    const parameter = params[name];
    if (parameter !== undefined) selected.push(Array.isArray(parameter) ? parameter.join('/') : parameter);
  }
  return selected;
}
