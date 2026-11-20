import path from 'node:path';
import {validateCondition} from './turbopack-conditions.mjs';
import {frameworkImportPattern} from './framework-imports.mjs';

const reserved = name => frameworkImportPattern.test(name) || /^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/.test(name);
export function validateWebpackResolution(input = {}) {
  for(const key of Object.keys(input))if(!['alias','extensions'].includes(key))throw new Error(`webpack.resolve.${key} is not implemented`);
  const aliases=input.alias || {};
  if (!aliases || typeof aliases!=='object' || Array.isArray(aliases) || Object.keys(aliases).length>256)throw new TypeError('webpack.resolve.alias must contain at most 256 aliases');
  for(const [key,value]of Object.entries(aliases)){
    const name=key.endsWith('$')?key.slice(0,-1):key;
    if (!name || name.length>4096 || /[\0*$]/.test(name) || reserved(name))throw new TypeError(`Unsupported webpack.resolve.alias key ${key}`);
    const values=Array.isArray(value)?value:[value];
    if(!values.length || values.length>32 || values.some(value=>value!==false && (typeof value!=='string' || !value || value.length>4096 || /[\0*]/.test(value))))throw new TypeError(`Invalid webpack.resolve.alias.${key}`);
  }
  const extensions=validateTurbopack({resolveExtensions:input.extensions}).resolveExtensions;
  return {resolveAlias:aliases,aliasesRelativeToImporter:true,...(extensions?{resolveExtensions:extensions}:{})};
}
function isTurbopackLoader(value) {
  return typeof value === 'string' && value.length > 0 ||
    value && typeof value === 'object' && typeof value.loader === 'string' && value.loader.length > 0 &&
    Object.keys(value).every(key => key === 'loader' || key === 'options');
}

export function validateTurbopack(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('turbopack must be an object');
  for (const key of Object.keys(input)) if (!['root', 'resolveAlias', 'resolveExtensions', 'rules'].includes(key)) throw new Error(`turbopack.${key} is not implemented by PRNext`);
  if (input.root !== undefined && (typeof input.root !== 'string' || !path.isAbsolute(input.root) || input.root.includes('\0'))) throw new TypeError('turbopack.root must be an absolute filesystem path');
  const aliases = input.resolveAlias ?? {};
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length > 256) throw new TypeError('turbopack.resolveAlias must contain at most 256 aliases');
  const validTarget = target => typeof target === 'string' && target.length > 0 && target.length <= 4096 && !/[\0*]/.test(target);
  const validChoice = target => target === false || validTarget(target) ||
    (Array.isArray(target) && target.length > 0 && target.length <= 32 && target.every(validTarget));
  for (const [name, target] of Object.entries(aliases)) {
    if (!name || name.length > 4096 || /[\0*$]/.test(name) || reserved(name)) throw new TypeError(`Unsupported turbopack.resolveAlias key ${name}; framework aliases and wildcard aliases cannot be overridden`);
    if (!validChoice(target) && (!target || typeof target !== 'object' || Array.isArray(target) ||
        Object.keys(target).length !== 1 || !validChoice(target.browser))) {
      throw new TypeError(`Invalid turbopack.resolveAlias.${name}; expected a path/package, fallback list, false or browser condition`);
    }
  }
  const extensions = input.resolveExtensions;
  if (extensions !== undefined && (!Array.isArray(extensions) || !extensions.length || extensions.length > 32 || extensions.some(value => typeof value !== 'string' || !/^\.[a-zA-Z0-9.]+$/.test(value)))) throw new TypeError('turbopack.resolveExtensions must be an array of at most 32 file extensions');
  let rules;
  if (input.rules !== undefined) {
    const inputRules = input.rules;
    if (!inputRules || typeof inputRules !== 'object' || Array.isArray(inputRules) || Object.keys(inputRules).length > 256) throw new TypeError('turbopack.rules must contain at most 256 patterns');
    let count = 0;
    rules = Object.fromEntries(Object.entries(inputRules).map(([pattern, entries]) => {
      const shorthand = Array.isArray(entries) && entries.length > 0 && entries.every(isTurbopackLoader);
      // Turbopack applies standalone loader rules in declaration order.
      // The loader runner expects a right-to-left chain.
      const variants = shorthand ? [{loaders:[...entries].reverse()}] : Array.isArray(entries) ? entries : [entries];
      count += variants.length;
      if (!variants.length || count > 256) throw new TypeError('turbopack.rules must contain at most 256 nonempty rule variants');
      for (const rule of variants) {
        if (!pattern || pattern.length > 1024 || !rule || typeof rule !== 'object' ||
            Object.keys(rule).some(key => !['loaders', 'as', 'condition'].includes(key)) ||
            !Array.isArray(rule.loaders) || !rule.loaders.length || rule.loaders.length > 32 ||
            !rule.loaders.every(isTurbopackLoader)) {
          throw new TypeError(`Invalid turbopack.rules ${pattern}; expected a loader list or rules with loaders and optional as/condition`);
        }
        if (rule.as !== undefined && !['*.js', '*.jsx'].includes(rule.as)) throw new Error('Turbopack loader output must be JavaScript (*.js or *.jsx)');
        if (rule.condition !== undefined) validateCondition(rule.condition);
      }
      return [pattern, shorthand ? variants[0] : entries];
    }));
  }
  return { ...(input.root !== undefined ? {root:path.resolve(input.root)} : {}), ...(rules ? {rules} : {}), resolveAlias: aliases, ...(extensions ? { resolveExtensions: [...new Set(extensions)] } : {}) };
}

/** Resolve aliases before boundary analysis so every graph uses the same module identity. */
export function moduleResolutionPlugin(config = {}, projectRoot) {
  const aliases = Object.entries(config.resolveAlias || {}).sort(([a], [b]) => b.length - a.length);
  return { name: 'prnext-module-resolution', setup(build) {
    if (config.resolveExtensions) build.initialOptions.resolveExtensions = config.resolveExtensions;
    if (!aliases.length) return;
    build.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.prnextAlias || args.namespace && args.namespace !== 'file') return;
      const match = aliases.find(([name]) => name.endsWith('$') ? args.path===name.slice(0,-1) : args.path === name || args.path.startsWith(name + '/'));
      if (!match) return;
      const [name, value] = match;
      const selected = value && typeof value === 'object' && !Array.isArray(value)
        ? (build.initialOptions.platform === 'browser' ? value.browser : undefined)
        : value;
      const targets = Array.isArray(selected) ? selected : [selected];
      let resolved;
      for(const target of targets){
      if (target===false) return {path:args.path,namespace:'prnext-ignored-alias'};
      if (target===undefined) return;
      const replacement = target + args.path.slice(name.endsWith('$')?name.length-1:name.length);
      const resolveDir = config.aliasesRelativeToImporter ? args.resolveDir || projectRoot : config.root || projectRoot;
      resolved = await build.resolve(replacement.startsWith('.') ? path.resolve(resolveDir, replacement) : replacement, {
        importer: args.importer, namespace: args.namespace, resolveDir,
        kind: args.kind, with: args.with, pluginData: { ...args.pluginData, prnextAlias: true },
      });
      if(!resolved.errors.length)break;
      }
      // Do not leak the recursion guard to imports made by the aliased module.
      return { ...resolved, pluginData: args.pluginData };
    });
    build.onLoad({filter:/.*/,namespace:'prnext-ignored-alias'},()=>({contents:'module.exports = {};',loader:'js'}));
  } };
}
