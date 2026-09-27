import { localePath, withLocale } from '../compat/locale.cjs';
function validSegment(value, name = 'route') {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`getStaticPaths parameter ${name} must be a nonempty string without path separators, traversal, or control characters.`);
  }
  return value;
}

const parameter = /^\[(\[)?(\.\.\.)?([^\]]+)\]\]?$/;

export function staticPath(pattern, value) {
  const patternSegments = pattern === '/' ? [] : pattern.split('/').slice(1);
  if (typeof value === 'string') {
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#')) {
      throw new Error(`getStaticPaths returned an invalid pathname: ${value}`);
    }
    const normalized = value === '/' ? '/' : value.replace(/\/+$/, '');
    const pathSegments = normalized === '/' ? [] : normalized.split('/').slice(1).map(part => validSegment(decodeURIComponent(part)));
    const params = {};
    let cursor = 0;
    for (const segment of patternSegments) {
      const match = parameter.exec(segment);
      if (!match) {
        if (segment !== pathSegments[cursor++]) throw new Error(`getStaticPaths pathname ${value} does not match ${pattern}.`);
      } else {
        let supplied;
        if (match[2]) {
          supplied = pathSegments.slice(cursor);
          if (!supplied.length && !match[1]) throw new Error(`getStaticPaths pathname ${value} needs at least one ${match[3]} segment.`);
          cursor = pathSegments.length;
        } else {
          if (cursor >= pathSegments.length) throw new Error(`getStaticPaths pathname ${value} is missing parameter ${match[3]}.`);
          supplied = pathSegments[cursor++];
        }
        Object.defineProperty(params, match[3], { value: supplied, enumerable: true, configurable: true, writable: true });
      }
    }
    if (cursor !== pathSegments.length) throw new Error(`getStaticPaths pathname ${value} does not match ${pattern}.`);
    return { path: '/' + pathSegments.map(encodeURIComponent).join('/'), params };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.params ||
      typeof value.params !== 'object' || Array.isArray(value.params) || value.locale) {
    throw new Error('getStaticPaths entries must be path strings or {params:{...}} objects. Locales are not supported yet.');
  }
  const params = value.params;
  const segments = patternSegments.flatMap(segment => {
    const match = parameter.exec(segment);
    if (!match) return [encodeURIComponent(validSegment(segment))];
    const supplied = Object.hasOwn(params, match[3]) ? params[match[3]] : undefined;
    if (match[2]) {
      if (match[1] && (supplied === undefined || supplied === null || supplied === false)) return [];
      if (!Array.isArray(supplied) || (!supplied.length && !match[1])) {
        throw new Error(`getStaticPaths parameter ${match[3]} must be ${match[1] ? 'an array of strings' : 'a nonempty array of strings'}.`);
      }
      return Array.from(supplied, value => encodeURIComponent(validSegment(value, match[3])));
    }
    return [encodeURIComponent(validSegment(supplied, match[3]))];
  });
  return { path: '/' + segments.join('/'), params };
}

export function validateStaticPaths(pattern, result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.paths) || ![false, true, 'blocking'].includes(result.fallback)) {
    throw new Error(`getStaticPaths for ${pattern} must return {paths: [...], fallback: false | true | 'blocking'}.`);
  }
  return { paths: result.paths.map(value => staticPath(pattern, value)), fallback: result.fallback };
}

export function localizedStaticPaths(route, result, i18n) {
  if(!route.locale) return validateStaticPaths(route.pattern,result);
  if(!result||!Array.isArray(result.paths)) return validateStaticPaths(route.originalPattern,result);
  const paths=[];
  for(const value of result.paths){
    const parsed=typeof value==='string'?localePath(value,i18n):{locale:value?.locale||i18n.defaultLocale};
    if(!i18n.locales.includes(parsed.locale))throw new Error(`getStaticPaths returned unknown locale ${parsed.locale}`);
    if(parsed.locale===route.locale)paths.push(typeof value==='string'?parsed.pathname:{params:value.params});
  }
  const validated=validateStaticPaths(route.originalPattern,{...result,paths});
  return {...validated,paths:validated.paths.map(entry=>({...entry,path:withLocale(entry.path,route.locale,i18n.defaultLocale)}))};
}
