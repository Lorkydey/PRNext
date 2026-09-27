import { build as bundle } from 'esbuild';
import { access, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import flexbugs from 'postcss-flexbugs-fixes';
import presetEnv from 'postcss-preset-env';

export const stylesheetPattern = /\.(?:css|scss|sass)$/i;
export const moduleStylesheetPattern = /\.module\.(?:css|scss|sass)$/i;
const configPattern = /^(?:postcss\.config|\.postcssrc)\.(?:js|mjs|cjs|json)$/;

async function importConfiguration(filename) {
  const temporary = path.join(path.dirname(filename), `.prnext-postcss-${randomUUID()}.mjs`);
  try {
    // Bundle local helpers afresh so an in-process rebuild sees their changes.
    const result = await bundle({ entryPoints: [filename], bundle: true, write: false,
      platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'silent',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(filename).href), __filename: JSON.stringify(filename), __dirname: JSON.stringify(path.dirname(filename)) },
      banner: { js: `import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(${JSON.stringify(pathToFileURL(filename).href)});` } });
    await writeFile(temporary, result.outputFiles[0].contents, { flag: 'wx' });
    return (await import(pathToFileURL(temporary).href)).default;
  } finally { await rm(temporary, { force: true }); }
}

async function loadConfiguration(root) {
  const filenames = (await readdir(root)).filter(name => configPattern.test(name) || name === '.postcssrc');
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (filenames.length > 1 || (filenames.length && metadata?.postcss !== undefined)) throw new Error('Multiple PostCSS configurations found. Keep one postcss.config.*, .postcssrc*, or package.json postcss entry.');
  if (!filenames.length) return metadata?.postcss;
  const filename = path.join(root, filenames[0]);
  return /\.(?:js|mjs|cjs)$/.test(filename) ? importConfiguration(filename) : JSON.parse(await readFile(filename, 'utf8'));
}

async function createProcessor(root) {
  const config = await loadConfiguration(root);
  if (config === undefined) return postcss([flexbugs(), presetEnv({ autoprefixer: { flexbox: 'no-2009' }, stage: 3, features: { 'custom-properties': false } })]);
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.plugins || typeof config.plugins !== 'object') throw new Error('PostCSS configuration must export an object with a plugins object or array; configuration functions are not supported.');
  const entries = Array.isArray(config.plugins)
    ? config.plugins.filter(item => item != null).map(item => typeof item === 'string' ? [item, true] : item)
    : Object.entries(config.plugins);
  const require = createRequire(path.join(root, 'package.json'));
  const plugins = [];
  for (const item of entries) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || item.length !== 2 || item[1] == null || !['object', 'boolean', 'string'].includes(typeof item[1])) throw new Error('PostCSS plugins must be names or [name, options] pairs, with false to disable a plugin.');
    const [name, configuredOptions] = item;
    const options = name === '@tailwindcss/postcss' && configuredOptions !== false
      ? { base: root, ...(typeof configuredOptions === 'object' ? configuredOptions : {}) } : configuredOptions;
    if (options === false) continue;
    if (/^(?:postcss-modules|postcss-modules-(?:values|scope|extract-imports|local-by-default))$/.test(name)) throw new Error(`${name} duplicates PRNext CSS Modules processing. Remove it from the PostCSS configuration.`);
    let filename;
    try { filename = require.resolve(name); }
    catch (cause) { throw new Error(`PostCSS plugin ${name} is missing from the application. Install it in ${root}.`, { cause }); }
    const imported = await import(pathToFileURL(filename).href);
    const plugin = imported.default || imported;
    plugins.push(options === true || (typeof options === 'object' && Object.keys(options).length === 0)
      ? (plugin.postcss === true ? plugin() : plugin) : typeof plugin === 'function' ? plugin(options) : plugin);
  }
  return postcss(plugins);
}

function rebaseReferences(root, file) {
  const rebase = (value, node) => {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#|var\()/i.test(value)) return value;
    let source = node.source?.input?.file || file;
    const position = node.source?.start;
    if (position && node.source.input.map) source = node.source.input.origin(position.line, position.column)?.file || source;
    if (source.startsWith('file:')) source = fileURLToPath(source);
    if (path.dirname(source) === path.dirname(file)) return value;
    const suffixIndex = value.search(/[?#]/);
    const pathname = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
    const suffix = suffixIndex < 0 ? '' : value.slice(suffixIndex);
    let relative = path.relative(path.dirname(file), path.resolve(path.dirname(source), pathname)).replaceAll(path.sep, '/');
    if (!relative.startsWith('.')) relative = './' + relative;
    return relative + suffix;
  };
  const values = (value, owner, imports = false) => {
    const parsed = valueParser(value);
    parsed.walk(node => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const child = node.nodes.find(part => part.type === 'string' || part.type === 'word');
        if (child && node.nodes.filter(part => !['space', 'comment'].includes(part.type)).length === 1) child.value = rebase(child.value, owner);
        return false;
      }
    });
    if (imports) {
      const first = parsed.nodes.find(node => !['space', 'comment'].includes(node.type));
      if (first?.type === 'string') first.value = rebase(first.value, owner);
    }
    return parsed.toString();
  };
  root.walkDecls(node => { if (/url\(/i.test(node.value)) node.value = values(node.value, node); });
  root.walkAtRules('import', node => { node.params = values(node.params, node, true); });
}

async function canAccess(filename) {
  try { await access(filename); return true; } catch { return false; }
}

function packageImporter(require) {
  return { async findFileUrl(url) {
    if (/^(?:\.|\/|[a-z][a-z\d+.-]*:)/i.test(url)) return null;
    const specifier = url.replace(/^~/, '');
    const parts = specifier.split('/');
    const name = parts.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    for (const directory of require.resolve.paths(name) || []) {
      const packageDirectory = path.join(directory, name);
      if (!await canAccess(packageDirectory)) continue;
      if (parts.length) return pathToFileURL(path.join(packageDirectory, ...parts));
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')); } catch {}
      const entry = metadata?.sass || metadata?.style || 'index';
      return pathToFileURL(path.join(packageDirectory, entry));
    }
    return null;
  } };
}

/** Build-only transformations, shared and deduplicated across all three React graphs. */
export function createStyleProcessor({ projectRoot, sassOptions = {} }) {
  const root = path.resolve(projectRoot);
  const require = createRequire(path.join(root, 'package.json'));
  const cache = new Map();
  let processor;
  let sass;
  async function transform(file) {
    let css = await readFile(file, 'utf8');
    let sourceMap;
    const dependencies = new Set([file]);
    if (/\.s[ac]ss$/i.test(file)) {
      const { implementation = 'sass', additionalData = '', includePaths = [], loadPaths = [], outputStyle, ...options } = sassOptions;
      if (!['sass', 'sass-embedded'].includes(implementation)) throw new Error('sassOptions.implementation must be sass or sass-embedded.');
      if (!sass) {
        let filename;
        try { filename = require.resolve(implementation); }
        catch (cause) { throw new Error(`Sass stylesheet ${file} requires ${implementation} in the application. Install it with npm install --save-dev ${implementation}.`, { cause }); }
        sass = import(pathToFileURL(filename).href);
      }
      const imported = await sass;
      const compiler = imported.compileStringAsync ? imported : imported.default;
      if (typeof additionalData === 'function') css = await additionalData(css, { resourcePath: file, rootContext: root });
      else if (typeof additionalData === 'string') css = additionalData + '\n' + css;
      else throw new Error('sassOptions.additionalData must be a string or function.');
      if (typeof css !== 'string') throw new Error('sassOptions.additionalData must return a string.');
      const compiled = await compiler.compileStringAsync(css, { ...options, ...(outputStyle ? { style: outputStyle } : {}),
        url: pathToFileURL(file), syntax: file.endsWith('.sass') ? 'indented' : 'scss',
        loadPaths: [...includePaths, ...loadPaths].map(directory => path.resolve(root, directory)),
        importers: [...(options.importers || []), packageImporter(require), ...(compiler.NodePackageImporter ? [new compiler.NodePackageImporter(root)] : [])],
        sourceMap: true, sourceMapIncludeSources: true });
      css = compiled.css;
      sourceMap = compiled.sourceMap;
      for (const url of compiled.loadedUrls) if (url.protocol === 'file:') dependencies.add(fileURLToPath(url));
    }
    processor ??= createProcessor(root);
    const processed = await (await processor).process(css, { from: file, to: file, map: sourceMap ? { prev: sourceMap, inline: false, annotation: false } : false });
    for (const message of processed.messages) if (message.type === 'dependency' && message.file) dependencies.add(path.resolve(root, message.file));
    rebaseReferences(processed.root, file);
    const exports = Object.create(null);
    if (moduleStylesheetPattern.test(file)) processed.root.walkRules(':export', rule => {
      rule.walkDecls(declaration => { exports[declaration.prop] = declaration.value; });
      rule.remove();
    });
    return { css: processed.root.toString(), exports, watchFiles: [...dependencies] };
  }
  return { process(file) {
    if (!cache.has(file)) cache.set(file, transform(file));
    return cache.get(file);
  } };
}
