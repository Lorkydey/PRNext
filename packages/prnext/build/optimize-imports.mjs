import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { generateMapped } from './source-maps.mjs';

const generate = generateModule.default || generateModule;
const name = node => node?.name ?? node?.value;

export function validateOptimizePackageImports(value = []) {
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== 'string' || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(item))) {
    throw new TypeError('experimental.optimizePackageImports must be an array of at most 256 npm package names');
  }
  return [...new Set(value)];
}

/** Only bypass pure ESM barrels in packages declaring sideEffects:false.
 * Uncertain graphs retain their original import and normal bundler semantics.
 * Never execute package code or infer private export paths from symbol names.
 */
export function createImportOptimizer(packages) {
  const selected = new Set(packages), barrels = new Map(), dependencies = new Set();
  async function inspect(file) {
    if (!barrels.has(file)) barrels.set(file, (async () => {
      if (!/\.[cm]?jsx?$/.test(file) || (await stat(file)).size > 2 * 1024 * 1024) return;
      let directory = path.dirname(file), owner;
      for (;;) {
        try { owner = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') return; }
        const parent = path.dirname(directory);
        if (parent === directory) return;
        directory = parent;
      }
      if (owner.sideEffects !== false || !selected.has(owner.name)) return;
      dependencies.add(file);
      dependencies.add(path.join(directory, 'package.json'));
      const ast = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
      // Crossing either directive here would change the RSC boundary identity.
      if (ast.program.directives.some(d => d.value.value !== 'use strict')) return;
      const imports = new Map(), exports = new Map();
      for (const node of ast.program.body) {
        if (t.isImportDeclaration(node)) {
          if (!node.specifiers.length || node.attributes?.length) return;
          for (const item of node.specifiers) {
            if (t.isImportNamespaceSpecifier(item)) return;
            imports.set(item.local.name, { source: node.source.value, imported: t.isImportDefaultSpecifier(item) ? 'default' : name(item.imported) });
          }
        } else if (!t.isExportNamedDeclaration(node) || node.declaration || node.attributes?.length) return;
      }
      for (const node of ast.program.body) if (t.isExportNamedDeclaration(node)) {
        for (const item of node.specifiers) {
          if (!t.isExportSpecifier(item)) return;
          const target = node.source ? { source: node.source.value, imported: name(item.local) } : imports.get(name(item.local));
          if (!target || !target.source.startsWith('./') && !target.source.startsWith('../')) return;
          exports.set(name(item.exported), target);
        }
      }
      return { exports, root: directory };
    })());
    return barrels.get(file);
  }
  async function optimize(source, file, resolve) {
    if (![...selected].some(value => source.includes(value))) return source;
    const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(file) ? ['typescript'] : [])] });
    let changed = false;
    for (const node of ast.program.body) {
      if (!t.isImportDeclaration(node) || !selected.has(node.source.value) || node.importKind === 'type' || !node.specifiers.length || node.attributes?.length) continue;
      const resolved = await resolve(node.source.value, file);
      if (!resolved) continue;
      const barrel = await inspect(resolved);
      if (!barrel) continue;
      const replacements = [];
      for (const item of node.specifiers) {
        if (!t.isImportSpecifier(item) || item.importKind === 'type') continue;
        const target = barrel.exports.get(name(item.imported));
        if (!target) continue;
        const leaf = await resolve(target.source, resolved);
        if (!leaf) continue;
        const relative = path.relative(barrel.root, leaf);
        if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) continue;
        replacements.push({ item, declaration: t.importDeclaration([target.imported === 'default' ? t.importDefaultSpecifier(item.local) : t.importSpecifier(item.local, t.isValidIdentifier(target.imported) ? t.identifier(target.imported) : t.stringLiteral(target.imported))], t.stringLiteral(leaf)) });
      }
      if (!replacements.length) continue;
      const at = ast.program.body.indexOf(node);
      node.specifiers = node.specifiers.filter(item => !replacements.some(value => value.item === item));
      ast.program.body.splice(at, node.specifiers.length ? 0 : 1, ...replacements.map(value => value.declaration));
      changed = true;
    }
    return changed ? generateMapped(generate, ast, { retainLines: true }, source, file) : source;
  }
  optimize.dependencies = dependencies;
  return optimize;
}

export function optimizeImportsPlugins(plugins, packages) {
  if (!packages?.length) return plugins;
  const optimize = createImportOptimizer(packages);
  return plugins.map(plugin => ({ ...plugin, setup(builder) {
    return plugin.setup({ ...builder, onLoad(settings, callback) {
      builder.onLoad(settings, async args => {
        const result = await callback(args);
        if (!result || typeof result.contents !== 'string' || args.namespace !== 'file' || !/\.[cm]?[jt]sx?$/.test(args.path) || result.errors?.length) return result;
        const contents = await optimize(result.contents, args.path, async (specifier, importer) => {
          const resolved = await builder.resolve(specifier, { importer, resolveDir: path.dirname(importer), kind: 'import-statement', pluginData: { prnextNpmResolving: true } });
          return !resolved.errors.length && !resolved.external && resolved.namespace === 'file' && !resolved.suffix ? resolved.path : undefined;
        });
        return { ...result, contents, watchFiles: [...(result.watchFiles || []), ...optimize.dependencies] };
      });
    } });
  } }));
}
