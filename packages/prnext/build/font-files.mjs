import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import googleFonts from './font-data.json' with { type: 'json' };

const formats = { woff: 'woff', woff2: 'woff2', ttf: 'truetype', otf: 'opentype', eot: 'embedded-opentype' };
const types = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject' };
const MAX_FONT = 16 * 1024 * 1024;
const quote = value => JSON.stringify(String(value));
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const commonOptions = ['display', 'preload', 'fallback', 'variable', 'adjustFontFallback', 'weight', 'style'];
const safeValue = value => typeof value === 'string' && !/[;{}\u0000-\u001f\u007f]/.test(value);
function fail(message) { throw new Error(`next/font: ${message}`); }
function weight(value) {
  if (typeof value !== 'string' || !/^(?:normal|bold|[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/.test(value)) fail(`Invalid font weight ${JSON.stringify(value)}.`);
  const values = value.split(' ').map(Number);
  if (values.length > 1 && values[0] > values[1]) fail('Font weight ranges must be increasing.');
  return value;
}
function style(value) {
  if (!['normal', 'italic', 'oblique'].includes(value)) fail(`Invalid font style ${JSON.stringify(value)}.`);
  return value;
}
function validate(kind, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Expected an options object.');
  const allowed = new Set([...commonOptions, ...(kind === 'local' ? ['src', 'declarations'] : ['subsets', 'axes'])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`Unsupported ${kind} font option ${key}.`);
  const result = { display: 'swap', preload: true, fallback: [], ...options };
  if (!['auto', 'block', 'swap', 'fallback', 'optional'].includes(result.display)) fail('Invalid display option.');
  if (typeof result.preload !== 'boolean') fail('preload must be a boolean.');
  if (!Array.isArray(result.fallback) || result.fallback.some(value => !safeValue(value) || !value)) fail('fallback must be an array of font family names.');
  if (result.variable !== undefined && (typeof result.variable !== 'string' || !/^--[A-Za-z_][A-Za-z0-9_-]*$/.test(result.variable))) fail('variable must be a CSS custom property, such as --font-body.');
  if (kind === 'google' ? result.adjustFontFallback !== undefined && typeof result.adjustFontFallback !== 'boolean'
    : result.adjustFontFallback !== undefined && ![false, 'Arial', 'Times New Roman'].includes(result.adjustFontFallback)) fail(`Invalid adjustFontFallback option for ${kind} fonts.`);
  return result;
}

async function responseBytes(url, maximum, accept) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } });
  if (!response.ok) { await response.body?.cancel(); fail(`Unable to download ${url}: HTTP ${response.status}.`); }
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); fail(`Font resource exceeds ${maximum} bytes.`); }
  const reader = response.body?.getReader();
  if (!reader) fail(`Empty font resource at ${url}.`);
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) fail(`Font resource exceeds ${maximum} bytes.`);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (!length) fail(`Empty font resource at ${url}.`);
  return Buffer.concat(chunks, length);
}

async function emit(bytes, ext, stage, assetBase) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const filename = `font-${hash}.${ext}`;
  await mkdir(path.join(stage, 'assets'), { recursive: true });
  await writeFile(path.join(stage, 'assets', filename), bytes);
  return { href: `${assetBase}/${filename}`, type: types[ext], crossOrigin: 'anonymous' };
}

async function local(options, context) {
  const sources = typeof options.src === 'string' ? [{ path: options.src, weight: options.weight, style: options.style }] : options.src;
  if (!Array.isArray(sources) || !sources.length || sources.length > 64) fail('src must be a font path or a nonempty array of at most 64 font descriptors.');
  if (options.weight !== undefined) weight(options.weight);
  if (options.style !== undefined) style(options.style);
  const declarations = options.declarations || [];
  if (!Array.isArray(declarations)) fail('declarations must be an array.');
  for (const item of declarations) {
    if (!item || !/^[a-z][a-z-]*$/.test(item.prop) || ['src', 'font-display', 'font-weight', 'font-style'].includes(item.prop) || !safeValue(item.value)) fail('Invalid font-face declaration.');
  }
  const faces = [];
  let total = 0;
  for (const item of sources) {
    if (!item || typeof item.path !== 'string' || !item.path || /^(?:https?:|data:)/i.test(item.path) || item.path.includes('\0')) fail('Local fonts require a local file path.');
    for (const key of Object.keys(item)) if (!['path', 'weight', 'style'].includes(key)) fail(`Invalid local font descriptor property ${key}.`);
    const ext = path.extname(item.path).slice(1).toLowerCase();
    if (!formats[ext]) fail(`Unsupported local font extension in ${item.path}.`);
    const filename = path.resolve(path.dirname(context.file), item.path);
    const size = (await stat(filename)).size;
    if (size > MAX_FONT || (total += size) > 64 * 1024 * 1024) fail('Local fonts exceed the build resource limit (16 MiB per file, 64 MiB per call).');
    const bytes = await readFile(filename);
    if (!bytes.length) fail(`Empty local font ${item.path}.`);
    const resource = await emit(bytes, ext, context.stage, context.assetBase);
    const fontWeight = item.weight ?? options.weight, fontStyle = item.style ?? options.style;
    if (fontWeight !== undefined) weight(fontWeight);
    if (fontStyle !== undefined) style(fontStyle);
    const descriptors = [...declarations.map(item => `${item.prop}:${item.value}`),
      ...(declarations.some(item => item.prop === 'font-family') ? [] : [`font-family:${quote(context.family)}`]),
      `src:url(${quote(resource.href)}) format(${quote(formats[ext])})`, `font-display:${options.display}`,
      ...(fontWeight ? [`font-weight:${fontWeight}`] : []), ...(fontStyle ? [`font-style:${fontStyle}`] : [])];
    faces.push({ css: `@font-face{${descriptors.join(';')};}`, bytes, resource, preload: options.preload, weight: fontWeight, style: fontStyle });
  }
  return { faces, weight: sources.length === 1 ? faces[0].weight : undefined, style: sources.length === 1 ? faces[0].style : undefined };
}

function googleOptions(name, options) {
  const family = name.replaceAll('_', ' '), metadata = googleFonts[family];
  if (!metadata) fail(`Unknown Google font ${name}.`);
  const weights = [...new Set(list(options.weight))], styles = [...new Set(list(options.style))];
  if (!weights.length) {
    if (!metadata.weights.includes('variable')) fail(`Missing weight for ${family}. Available: ${metadata.weights.join(', ')}.`);
    weights.push('variable');
  }
  if (weights.some(value => !metadata.weights.includes(value)) || (weights.length > 1 && weights.includes('variable'))) fail(`Invalid weight for ${family}. Available: ${metadata.weights.join(', ')}.`);
  if (!styles.length) styles.push(metadata.styles.length === 1 ? metadata.styles[0] : 'normal');
  if (styles.some(value => !metadata.styles.includes(value))) fail(`Invalid style for ${family}.`);
  const subsets = options.subsets || [];
  if (!Array.isArray(subsets) || subsets.some(value => !metadata.subsets.includes(value))) fail(`Invalid subset for ${family}. Available: ${metadata.subsets.join(', ')}.`);
  const preload = options.preload && metadata.subsets.length > 0;
  if (preload && !subsets.length) fail(`Preload is enabled for ${family}: specify subsets or preload:false.`);
  const axes = options.axes || [];
  if (!Array.isArray(axes) || (axes.length && weights[0] !== 'variable')) fail('axes requires a variable font.');
  const extraAxes = [];
  for (const tag of new Set(axes)) {
    const axis = metadata.axes?.find(axis => axis.tag === tag && axis.tag !== 'wght');
    if (!axis) fail(`Unknown variable axis ${tag} for ${family}.`);
    extraAxes.push([tag, `${axis.min}..${axis.max}`]);
  }
  const variableWeight = metadata.axes?.find(axis => axis.tag === 'wght');
  const variants = [];
  for (const currentStyle of styles) for (const currentWeight of weights) {
    const entries = [...extraAxes];
    if (styles.includes('italic')) entries.push(['ital', currentStyle === 'italic' ? '1' : '0']);
    if (currentWeight !== 'variable') entries.push(['wght', currentWeight]);
    else if (variableWeight) entries.push(['wght', `${variableWeight.min}..${variableWeight.max}`]);
    entries.sort(([a], [b]) => (/^[a-z]/.test(a) === /^[a-z]/.test(b)) ? a.localeCompare(b, 'en', { sensitivity: 'variant' }) : /^[a-z]/.test(a) ? -1 : 1);
    variants.push(entries);
  }
  const values = variants.map(entries => entries.map(([, value]) => value).join(',')).sort((a, b) => {
    const left = a.split(',').map(parseFloat), right = b.split(',').map(parseFloat);
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  });
  const axesQuery = variants[0].length ? `:${variants[0].map(([tag]) => tag).join(',')}@${[...new Set(values)].join(';')}` : '';
  return { url: `https://fonts.googleapis.com/css2?family=${family.replaceAll(' ', '+')}${axesQuery}&display=${options.display}`, preload, subsets,
    weight: weights.length === 1 && weights[0] !== 'variable' ? weights[0] : undefined, style: styles.length === 1 ? styles[0] : undefined };
}

async function google(name, options, context) {
  const normalized = googleOptions(name, options);
  const css = (await responseBytes(normalized.url, 1024 * 1024, 'text/css')).toString('utf8');
  const faces = [], downloaded = new Map();
  let total = 0;
  const facePattern = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g;
  for (const match of css.matchAll(facePattern)) {
    if (faces.length >= 128) fail('Google font CSS has too many font faces.');
    const subset = match[1]?.trim();
    const urls = [...match[2].matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)];
    if (!urls.length) fail('Google font face is missing its source.');
    let content = match[2].replace(/font-family\s*:[^;]+;/i, `font-family:${quote(context.family)};`);
    let representative;
    for (const urlMatch of urls) {
      const url = new URL(urlMatch[2]);
      if (url.protocol !== 'https:' || url.hostname !== 'fonts.gstatic.com' || url.username || url.password) fail('Google font CSS referenced an unexpected font origin.');
      if (!downloaded.has(url.href)) {
        if (downloaded.size >= 64) fail('Google font call exceeds 64 files.');
        const bytes = await responseBytes(url.href, MAX_FONT, 'font/woff2,font/woff,*/*');
        total += bytes.length;
        if (total > 64 * 1024 * 1024) fail('Google font call exceeds 64 MiB.');
        const ext = path.extname(url.pathname).slice(1).toLowerCase();
        if (!formats[ext]) fail(`Unsupported Google font extension ${ext}.`);
        downloaded.set(url.href, { bytes, resource: await emit(bytes, ext, context.stage, context.assetBase) });
      }
      const source = downloaded.get(url.href);
      representative ||= source;
      content = content.replace(urlMatch[0], `url(${quote(source.resource.href)})`);
    }
    const fontWeight = /font-weight\s*:\s*([^;]+)/i.exec(content)?.[1]?.trim();
    const fontStyle = /font-style\s*:\s*([^;]+)/i.exec(content)?.[1]?.trim();
    faces.push({ css: `@font-face{${content}}`, ...representative, preload: normalized.preload && normalized.subsets.includes(subset), weight: fontWeight, style: fontStyle });
  }
  if (!faces.length) fail(`No font faces returned for ${name}.`);
  return { faces, weight: normalized.weight, style: normalized.style };
}

async function fallbackMetrics(faces, fallbackName) {
  const { create } = await import('fontkit');
  // Prefer an upright face near the normal text weight for a shared fallback.
  const candidates = [...faces].sort((a, b) => Number(a.style === 'italic') - Number(b.style === 'italic') || Math.abs((parseFloat(a.weight) || 400) - 400) - Math.abs((parseFloat(b.weight) || 400) - 400));
  for (const face of candidates) {
    let font;
    try { font = create(face.bytes); } catch { continue; }
    if (!font.unitsPerEm) continue;
    const sample = 'aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ';
    let size = 1;
    if ([...sample].every(character => font.hasGlyphForCodePoint(character.codePointAt(0)))) {
      const glyphs = font.glyphsForString(sample);
      const average = glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / glyphs.length;
      size = average / font.unitsPerEm / ((fallbackName === 'Times New Roman' ? 854.3953488372093 : 934.5116279069767) / 2048);
    }
    if (!Number.isFinite(size) || size <= 0) size = 1;
    const percent = value => `${Math.abs(value * 100).toFixed(2)}%`;
    return `src:local(${quote(fallbackName)});ascent-override:${percent(font.ascent / font.unitsPerEm / size)};descent-override:${percent(font.descent / font.unitsPerEm / size)};line-gap-override:${percent(font.lineGap / font.unitsPerEm / size)};size-adjust:${percent(size)};`;
  }
  return null;
}

export async function compileFont({ kind, name, options: input, ...context }) {
  const options = validate(kind, input);
  const declaredFamily = kind === 'local' && options.declarations?.find(item => item?.prop === 'font-family')?.value;
  const family = declaredFamily ? String(declaredFamily).replace(/['"]/g, '') : `__prnext_${kind === 'google' ? name : 'local'}_${context.id}`;
  const compiled = await (kind === 'local' ? local(options, { ...context, family }) : google(name, options, { ...context, family }));
  const fallback = options.adjustFontFallback === false ? null : await fallbackMetrics(compiled.faces, options.adjustFontFallback === 'Times New Roman' ? 'Times New Roman' : 'Arial');
  const familyList = [quote(family), ...(fallback ? [quote(family + '_Fallback')] : []), ...options.fallback].join(',');
  const className = `__font_${context.id}`, variable = options.variable ? `__variable_${context.id}` : undefined;
  const fontWeight = compiled.weight && !compiled.weight.includes(' ') ? (compiled.weight === 'normal' ? 400 : compiled.weight === 'bold' ? 700 : Number(compiled.weight)) : undefined;
  const fontStyle = compiled.style;
  const value = { className, style: { fontFamily: familyList, ...(fontWeight !== undefined ? { fontWeight } : {}), ...(fontStyle ? { fontStyle } : {}) }, ...(variable ? { variable } : {}) };
  const classRules = `font-family:${familyList};${fontWeight !== undefined ? `font-weight:${fontWeight};` : ''}${fontStyle ? `font-style:${fontStyle};` : ''}`;
  const css = compiled.faces.map(face => face.css).join('\n') + (fallback ? `\n@font-face{font-family:${quote(family + '_Fallback')};${fallback}}` : '')
    + `\n.${className}{${classRules}}` + (variable ? `\n.${variable}{${options.variable}:${familyList};}` : '');
  const preloads = [...new Map(compiled.faces.filter(face => face.preload).map(face => [face.resource.href, face.resource])).values()];
  return { value, css, preloads };
}
