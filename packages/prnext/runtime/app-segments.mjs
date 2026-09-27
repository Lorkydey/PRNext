/** Each layout sees only dynamic parameters declared at or above its segment. */
export function paramsBySegment(segments, params = {}) {
  const result = new Map();
  const ancestors = Object.create(null);
  for (const segment of segments) {
    const match = /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(segment.segment || '');
    if (match && Object.hasOwn(params, match[1])) ancestors[match[1]] = params[match[1]];
    result.set(segment, { ...ancestors });
  }
  return result;
}

export function selectedLayoutSegments(segments, params = {}) {
  return segments.flatMap(segment => {
    const value = segment.segment || '';
    if (!value || value.startsWith('@')) return [];
    const match = /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(value);
    if (!match) return [value];
    const parameter = params[match[1]];
    return parameter === undefined ? [] : [Array.isArray(parameter) ? parameter.join('/') : parameter];
  });
}
