import { parse, tokensToRegexp } from 'path-to-regexp';
import { withLocale } from '../compat/locale.cjs';

const MAX_ROUTES = 1000;
const MAX_STRING = 4096;
const MAX_CONDITIONS = 16;
const MAX_PARAMS = 64;
const MAX_HEADERS = 64;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STATUS = new Set([301, 302, 303, 307, 308]);

function fail(where, message) { throw new Error(`Invalid custom route ${where}: ${message}`); }
function record(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(where, 'expected an object');
}
function keys(value, allowed, where) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(where, `unsupported fields: ${unknown.join(', ')}`);
}
function string(value, where, { empty = false, max = MAX_STRING, header = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value) > max) {
    fail(where, `expected ${empty ? 'a' : 'a nonempty'} string of at most ${max} bytes`);
  }
  if ((header ? /[\u0000-\u0008\u000a-\u001f\u007f]/ : CONTROL).test(value)) fail(where, 'control characters are forbidden');
  return value;
}
function parseTokens(value, where, delimiter = '/') {
  try { return parse(value, { delimiter }); }
  catch (error) { fail(where, `invalid path pattern (${error.message})`); }
}
function addParam(params, name, where, info = {}) {
  if (params.has(name)) fail(where, `duplicate parameter ${JSON.stringify(name)}`);
  if (params.size >= MAX_PARAMS) fail(where, `at most ${MAX_PARAMS} parameters are supported`);
  params.set(name, info);
}

// Keep these checks aligned with custom_routes.rs::js_regex. JavaScript accepts
// identity escapes which have different meanings in Rust, and the native
// matcher deliberately limits insensitive character classes to ASCII rather
// than silently applying Rust's broader Unicode case folding.
function validateNativeRegex(pattern, insensitive, where) {
  let inClass = false;
  let classText = '';
  const escapedLetters = new Set('dDwWsSbBnrtvfxuk');
  for (let index = 0; index < pattern.length; index++) {
    let value = pattern[index];
    if (value === '\\') {
      const kind = pattern[++index];
      if (kind === undefined) fail(where, 'trailing regular-expression escape');
      if (/[A-Za-z]/.test(kind) && !escapedLetters.has(kind)) {
        fail(where, `unsupported ECMAScript escape \\${kind} in the native custom-route matcher`);
      }
      if (kind === 'x' || kind === 'u') {
        const length = kind === 'x' ? 2 : 4;
        const digits = pattern.slice(index + 1, index + length + 1);
        if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) fail(where, 'unsupported ECMAScript hex/Unicode escape; use \\xHH or \\uHHHH');
        const code = Number.parseInt(digits, 16);
        if (code >= 0xd800 && code <= 0xdfff) fail(where, 'UTF-16 surrogate regex escapes are unsupported by the native matcher');
        value = String.fromCharCode(code);
        index += length;
      } else value = `\\${kind}`;
      if (inClass) classText += value;
      continue;
    }
    if (!inClass && value === '[') { inClass = true; classText = ''; }
    else if (inClass && value === ']') {
      if (insensitive && (/[^\x00-\x7f]/.test(classText) || classText.includes('\\u'))) {
        fail(where, 'case-insensitive Unicode character classes are unsupported; use Unicode literals or a case-sensitive has/missing condition');
      }
      inClass = false;
    } else if (inClass) classText += value;
  }
}

function compileSource(source, params, where) {
  string(source, `${where}.source`);
  if (!source.startsWith('/') || source.startsWith('//')) fail(where, 'source must start with a single /');
  const tokens = parseTokens(source, `${where}.source`);
  const captures = [];
  let regex;
  try {
    regex = tokensToRegexp(tokens, captures, { strict: true, sensitive: false, delimiter: '/' }).source;
  } catch (error) { fail(where, `invalid source (${error.message})`); }
  // Match Next's optional final slash without allowing query/hash delimiters.
  regex = regex.replace(/\$$/, '(?:/)?$').replace(/\\\//g, '/');
  if (Buffer.byteLength(regex) > MAX_STRING) fail(where, 'compiled source exceeds 4096 bytes');
  validateNativeRegex(regex, true, `${where}.source`);
  const compiledKeys = captures.map(token => {
    const repeat = token.modifier === '*' || token.modifier === '+';
    const name = typeof token.name === 'number' ? null : token.name;
    if (name !== null) addParam(params, name, where, { repeat, optional: token.modifier === '?' || token.modifier === '*' });
    return { name, repeat, separator: `${token.prefix}${token.suffix}` };
  });
  if (captures.length > MAX_PARAMS) fail(where, `at most ${MAX_PARAMS} captures are supported`);
  return { source, regex, keys: compiledKeys };
}

function regexCaptures(pattern, where) {
  try { new RegExp(pattern); }
  catch (error) { fail(where, `invalid condition regex (${error.message})`); }
  const captures = [];
  let count = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') { index++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '(' && !inClass) {
      if (pattern[index + 1] !== '?') count++;
      else if (pattern[index + 2] === '<' && !['=', '!'].includes(pattern[index + 3])) {
        const end = pattern.indexOf('>', index + 3);
        const name = pattern.slice(index + 3, end);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(where, 'named captures must use ASCII identifier names');
        captures.push({ name, index: ++count });
      }
    }
  }
  if (count > MAX_PARAMS) fail(where, `at most ${MAX_PARAMS} regex captures are supported`);
  return captures;
}

function conditions(value, params, where, expose) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONDITIONS) fail(where, `expected at most ${MAX_CONDITIONS} conditions`);
  const seen = new Set();
  return value.map((item, index) => {
    const location = `${where}[${index}]`;
    record(item, location); keys(item, ['type', 'key', 'value'], location);
    if (!['header', 'cookie', 'query', 'host'].includes(item.type)) fail(location, 'unknown condition type');
    const result = { type: item.type, captures: [] };
    if (item.type === 'host') {
      if (item.key !== undefined) fail(location, 'host conditions do not accept key');
      if (!item.value) fail(location, 'host conditions require a nonempty value');
    } else {
      string(item.key, `${location}.key`, { max: 256 });
      if ((item.type === 'header' || item.type === 'cookie') && !HEADER_NAME.test(item.key)) fail(location, 'invalid header/cookie key');
      result.key = item.type === 'header' ? item.key.toLowerCase() : item.key;
    }
    if (item.value !== undefined) {
      string(item.value, `${location}.value`, { empty: true, max: 1024 });
      if (item.value) {
        // A noncapturing wrapper keeps alternations anchored as a whole.
        result.regex = `^(?:${item.value})$`;
        result.captures = regexCaptures(result.regex, location);
        validateNativeRegex(result.regex, false, `${location}.value`);
        if (item.type === 'host' && !result.captures.length) result.capture = 'host';
      }
    }
    if (!result.regex && result.key) {
      const name = result.key.replace(/[^A-Za-z]/g, '');
      if (name) result.capture = name;
    }
    const identity = JSON.stringify(result);
    if (seen.has(identity)) fail(where, 'duplicate condition');
    seen.add(identity);
    if (expose) {
      for (const capture of result.captures) addParam(params, capture.name, location);
      if (result.capture) addParam(params, result.capture, location);
    }
    return result;
  });
}

function template(value, params, where, { path = false, delimiter = '/', strict = false } = {}) {
  const tokens = path ? parseTokens(value, where, delimiter) : nonPathTokens(value, params, strict, where);
  return tokens.map(token => {
    if (typeof token === 'string') return token;
    if (typeof token.name === 'number' || !params.has(token.name)) fail(where, `unknown destination parameter ${JSON.stringify(token.name)}`);
    if (params.get(token.name).repeat && !['*', '+'].includes(token.modifier)) {
      fail(where, `repeated parameter :${token.name} requires * or + in the destination`);
    }
    return { param: token.name, prefix: token.prefix, suffix: token.suffix, modifier: token.modifier,
      ...(token.join !== undefined ? { join: token.join } : {}) };
  });
}

function nonPathTokens(value, params, strict, where) {
  const result = [];
  let text = '';
  const flush = () => { if (text) result.push(text); text = ''; };
  for (let index = 0; index < value.length;) {
    if (value[index] === '\\' && value[index + 1] === ':') { text += ':'; index += 2; continue; }
    const match = value[index] === ':' && /^:([A-Za-z0-9_]+)([?*+]?)/.exec(value.slice(index));
    if (!match) { text += value[index++]; continue; }
    if (!params.has(match[1])) {
      // Non-path strings routinely contain literal colons (CSP, URLs, times).
      // Reject unresolved parameter-like query placeholders, but retain URI
      // schemes and numeric ports rather than guessing they are parameters.
      if (strict && /^[A-Za-z_]/.test(match[1])) fail(where, `unknown destination parameter ${JSON.stringify(match[1])}`);
      text += match[0]; index += match[0].length; continue;
    }
    flush();
    // Next compiles non-path values with an artificial leading slash, then
    // removes it. Arrays at the beginning consequently join with '/', whereas
    // embedded arrays use the preceding path-to-regexp prefix ('.' or '/').
    const join = index === 0 || value[index - 1] === '/' ? '/' : value[index - 1] === '.' ? '.' : '';
    result.push({ name: match[1], prefix: '', suffix: '', modifier: match[2],
      ...(['*', '+'].includes(match[2]) ? { join } : {}) });
    index += match[0].length;
  }
  flush(); return result;
}

function splitDestination(value, where) {
  let rest = value;
  const hashIndex = rest.indexOf('#');
  const hash = hashIndex === -1 ? '' : rest.slice(hashIndex + 1);
  if (hashIndex !== -1) rest = rest.slice(0, hashIndex);
  const queryIndex = rest.indexOf('?');
  const search = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);
  if (queryIndex !== -1) rest = rest.slice(0, queryIndex);
  let protocol, hostname, port;
  const external = /^https?:\/\//i.test(rest);
  if (external) {
    const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(rest);
    if (!match) fail(where, 'invalid external destination');
    protocol = match[1].toLowerCase();
    let authority = match[2];
    if (authority.includes('@') || authority.includes('\\')) fail(where, 'external credentials and backslashes are unsupported');
    if (authority.startsWith('[')) {
      const ipv6 = /^(\[[0-9a-fA-F:.]+\])(?::(\d+))?$/.exec(authority);
      if (!ipv6) fail(where, 'invalid IPv6 destination');
      hostname = ipv6[1]; port = ipv6[2];
    } else {
      const numericPort = /:(\d+)$/.exec(authority);
      if (numericPort) { port = numericPort[1]; authority = authority.slice(0, -numericPort[0].length); }
      hostname = authority;
      if (!hostname || /[\s%]/.test(hostname)) fail(where, 'invalid external hostname');
    }
    if (port && (+port > 65535 || +port === 0)) fail(where, 'invalid destination port');
    rest = match[3] || '/';
  } else if (!rest.startsWith('/') || rest.startsWith('//')) {
    fail(where, 'destination must start with /, http:// or https://');
  }
  if (rest.includes('\\') && /\\(?![:*+?(){}\\])/.test(rest)) fail(where, 'invalid destination escape');
  return { external, protocol, hostname, port, pathname: rest, search, hash };
}

function destination(value, params, where, rewrite) {
  string(value, where);
  const pieces = splitDestination(value, where);
  const pathname = template(pieces.pathname, params, `${where}.pathname`, { path: true });
  const hash = template(pieces.hash, params, `${where}.hash`, { path: true });
  const result = { external: pieces.external, pathname, query: [], hash };
  if (pieces.external) {
    result.protocol = pieces.protocol;
    result.hostname = pieces.hostname.startsWith('[') ? [pieces.hostname] : template(pieces.hostname, params, `${where}.hostname`, { path: true, delimiter: '.' });
    if (pieces.port) result.port = pieces.port;
  }
  const query = new URLSearchParams(pieces.search);
  if ([...query].length > 128) fail(where, 'at most 128 destination query entries are supported');
  for (const [key, value] of query) {
    string(key, `${where}.query key`, { empty: true }); string(value, `${where}.query value`, { empty: true });
    result.query.push({ key, value: template(value, params, `${where}.query`, { strict: true }) });
  }
  result.appendParamsToQuery = rewrite && ![...pathname, ...hash, ...(result.hostname || [])].some(token => typeof token !== 'string');
  return result;
}

function matcher(route, params, where, expose = true) {
  const result = compileSource(route.source, params, where);
  result.has = conditions(route.has, params, `${where}.has`, expose);
  result.missing = conditions(route.missing, params, `${where}.missing`, false);
  const existing = new Set(result.has.map(item => JSON.stringify(item)));
  if (result.missing.some(item => existing.has(JSON.stringify(item)))) fail(where, 'the same condition cannot be required and missing');
  return result;
}

// A deployment pathname is literal, not additional path-to-regexp syntax.
function mountedPattern(source, basePath) {
  if (!basePath) return source;
  const prefix = basePath.replace(/[\\:*+?(){}[\]]/g, '\\$&');
  return prefix + (source === '/' ? '' : source);
}

/** Middleware only needs a predicate; its captures are not destination params. */
export function compileRouteMatcher(input, where = 'middleware.matcher', { basePath = '' } = {}) {
  const route = typeof input === 'string' ? { source: input } : input;
  record(route, where);
  keys(route, ['source', 'has', 'missing', 'locale'], where);
  if (route.locale !== undefined && route.locale !== false) fail(where, 'locale only accepts false while that feature is unsupported');
  // Validate the original source before adding a mount prefix, otherwise an
  // invalid relative source could accidentally become an absolute pattern.
  string(route.source, `${where}.source`);
  if (!route.source.startsWith('/') || route.source.startsWith('//')) fail(where, 'source must start with a single /');
  return matcher({ ...route, source: mountedPattern(route.source, basePath) }, new Map(), where, false);
}

function compileRoute(route, type, where, basePath = '') {
  record(route, where);
  keys(route, ['source', 'has', 'missing', 'basePath', 'locale', ...(type === 'header' ? ['headers'] : type === 'redirect' ? ['destination', 'permanent', 'statusCode'] : ['destination'])], where);
  for (const option of ['basePath', 'locale']) if (route[option] !== undefined && route[option] !== false) fail(where, `${option} only accepts false`);
  string(route.source, `${where}.source`);
  if (!route.source.startsWith('/') || route.source.startsWith('//')) fail(where, 'source must start with a single /');
  if (type === 'rewrite' && route.basePath === false && !/^https?:\/\//i.test(route.destination)) fail(where, 'basePath:false rewrites require an external HTTP(S) destination');
  if (basePath && route.basePath !== false) {
    route = { ...route, source: mountedPattern(route.source, basePath),
      ...(typeof route.destination === 'string' && route.destination.startsWith('/') && !route.destination.startsWith('//')
        ? { destination: mountedPattern(route.destination, basePath) } : {}) };
  }
  const params = new Map();
  const result = matcher(route, params, where);
  if (type === 'header') {
    if (!Array.isArray(route.headers) || !route.headers.length || route.headers.length > MAX_HEADERS) fail(where, `headers must contain 1–${MAX_HEADERS} entries`);
    result.headers = route.headers.map((header, index) => {
      const location = `${where}.headers[${index}]`;
      record(header, location); keys(header, ['key', 'value'], location);
      string(header.key, `${location}.key`, { max: 256 });
      string(header.value, `${location}.value`, { empty: true, header: true });
      const key = template(header.key, params, `${location}.key`);
      if (!HEADER_NAME.test(key.map(token => typeof token === 'string' ? token : 'param').join(''))) fail(location, 'invalid header name');
      return { key, value: template(header.value, params, `${location}.value`) };
    });
    // Duplicate response header names intentionally retain source order: the
    // later matching header wins, just as Next custom headers do.
  } else {
    result.destination = destination(route.destination, params, `${where}.destination`, type === 'rewrite');
    if (type === 'redirect') {
      if (route.permanent !== undefined && route.statusCode !== undefined) fail(where, 'permanent and statusCode are mutually exclusive');
      if (route.statusCode !== undefined) {
        if (!STATUS.has(route.statusCode)) fail(where, 'statusCode must be 301, 302, 303, 307 or 308');
        result.statusCode = route.statusCode;
      } else {
        if (typeof route.permanent !== 'boolean') fail(where, 'redirect requires permanent or statusCode');
        result.statusCode = route.permanent ? 308 : 307;
      }
    }
  }
  return result;
}

/** Compile Next custom route callbacks into the bounded native manifest. */
export async function compileCustomRoutes(config = {}) {
  const loaded = await Promise.all(['headers', 'redirects', 'rewrites'].map(async name => {
    if (config[name] === undefined) return [];
    if (typeof config[name] !== 'function') fail(name, 'configuration must be a function');
    return await config[name]();
  }));
  let total = 0;
  const compileList = (value, type, where) => {
    if (!Array.isArray(value)) fail(where, 'callback must return an array');
    if (config.i18n) value = value.flatMap(route => route?.locale === false ? [route] : [...config.i18n.locales.filter(locale => locale !== config.i18n.defaultLocale), config.i18n.defaultLocale].map(locale => ({
      ...route, source: withLocale(route.source, locale, config.i18n.defaultLocale),
      ...(typeof route.destination === 'string' && route.destination.startsWith('/') && !route.destination.startsWith('//') ? {destination:withLocale(route.destination,locale,config.i18n.defaultLocale)} : {}),
    })));
    total += value.length;
    if (total > MAX_ROUTES) fail(where, `at most ${MAX_ROUTES} custom routes are supported`);
    return value.map((route, index) => compileRoute(route, type, `${where}[${index}]`, config.basePath || ''));
  };
  const headers = compileList(loaded[0], 'header', 'headers');
  const redirects = compileList(loaded[1], 'redirect', 'redirects');
  let rawRewrites = loaded[2];
  if (Array.isArray(rawRewrites)) rawRewrites = { afterFiles: rawRewrites };
  record(rawRewrites, 'rewrites'); keys(rawRewrites, ['beforeFiles', 'afterFiles', 'fallback'], 'rewrites');
  const rewrites = Object.fromEntries(['beforeFiles', 'afterFiles', 'fallback'].map(phase => [phase, compileList(rawRewrites[phase] === undefined ? [] : rawRewrites[phase], 'rewrite', `rewrites.${phase}`)]));
  const result = { version: 1, headers, redirects, rewrites };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_MANIFEST_BYTES) fail('manifest', 'compiled routes exceed 2 MiB');
  return result;
}
