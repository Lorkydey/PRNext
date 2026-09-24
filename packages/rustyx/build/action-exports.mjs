import {generateMapped} from './source-maps.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import generateImport from '@babel/generator';
import * as t from '@babel/types';

const generate = generateImport.default || generateImport;
const astFor = (source, file) => parse(source, { sourceType: 'module', sourceFilename: file, plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(file) ? ['typescript'] : [])] });
const exportName = node => node.name ?? node.value;

/** Resolve wildcard exports statically, including cycles and ESM ambiguity rules. */
export async function expandActionExports(source, file, resolve) {
  if (!source.includes('use server') || !source.includes('export') || !source.includes('*')) return source;
  const ast = astFor(source, file);
  if (!ast.program.directives.some(item => item.value.value === 'use server') || !ast.program.body.some(item => t.isExportAllDeclaration(item) && item.exportKind !== 'type')) return source;
  const graph = new Map([[file, { source, ast }]]);
  const pending = [file];
  let sourceBytes = 0;
  for (let index = 0; index < pending.length; index++) {
    const filename = pending[index];
    const node = graph.get(filename);
    node.source ??= await readFile(filename, 'utf8');
    sourceBytes += Buffer.byteLength(node.source);
    if (sourceBytes > 2 * 1024 * 1024) throw new Error('Server Action export graph exceeds 2 MiB');
    node.ast ??= astFor(node.source, filename);
    node.explicit = new Map(); node.stars = []; node.locals = new Map();
    const imports = new Map(), resolutions = new Map();
    async function target(specifier) {
      if (resolutions.has(specifier)) return resolutions.get(specifier);
      const result = await resolve(specifier, filename);
      if (!result || !path.isAbsolute(result)) throw new Error(`Cannot enumerate Server Action exports from ${specifier} in ${filename}; use explicit named exports`);
      if (!graph.has(result)) {
        if (graph.size >= 256) throw new Error('Server Action export graph exceeds 256 modules');
        graph.set(result, {}); pending.push(result);
      }
      resolutions.set(specifier, result);
      return result;
    }
    for (const item of node.ast.program.body) {
      const declaration = t.isExportNamedDeclaration(item) || t.isExportDefaultDeclaration(item) ? item.declaration : item;
      if (t.isFunctionDeclaration(declaration) && declaration.id) node.locals.set(declaration.id.name, { id: filename + '#' + declaration.id.name, async: declaration.async && !declaration.generator });
      if (t.isVariableDeclaration(declaration)) for (const binding of declaration.declarations) if (t.isIdentifier(binding.id)) {
        node.locals.set(binding.id.name, t.isIdentifier(binding.init) ? { local: binding.init.name } :
          { id: filename + '#' + binding.id.name, ...(t.isFunction(binding.init) ? { async: binding.init.async && !binding.init.generator } : t.isLiteral(binding.init) || t.isObjectExpression(binding.init) || t.isArrayExpression(binding.init) || t.isClassExpression(binding.init) ? { async: false } : {}) });
      }
      if (t.isClassDeclaration(declaration) && declaration.id) node.locals.set(declaration.id.name, { id: filename + '#' + declaration.id.name, async: false });
      if (t.isImportDeclaration(item) && item.importKind !== 'type') for (const binding of item.specifiers) {
        if (binding.importKind === 'type') continue;
        imports.set(binding.local.name, { source: item.source.value, name: t.isImportDefaultSpecifier(binding) ? 'default' : t.isImportNamespaceSpecifier(binding) ? '*' : exportName(binding.imported) });
      }
    }
    async function local(name, seen = new Set()) {
      if (seen.has(name)) return { id: filename + '#' + name };
      seen.add(name);
      if (imports.has(name)) { const imported = imports.get(name); return { file: await target(imported.source), name: imported.name }; }
      const value = node.locals.get(name);
      return value?.local ? local(value.local, seen) : value || { id: filename + '#' + name };
    }
    for (const item of node.ast.program.body) {
      if (item.exportKind === 'type') continue;
      if (t.isExportAllDeclaration(item)) { node.stars.push({ source: item.source.value, file: await target(item.source.value), node: item }); continue; }
      if (t.isExportDefaultDeclaration(item)) {
        node.explicit.set('default', t.isIdentifier(item.declaration) ? await local(item.declaration.name) : { id: filename + '#default', ...(t.isFunction(item.declaration) ? { async: item.declaration.async && !item.declaration.generator } : {}) });
      }
      if (!t.isExportNamedDeclaration(item)) continue;
      if (item.declaration && !t.isTSInterfaceDeclaration(item.declaration) && !t.isTSTypeAliasDeclaration(item.declaration) && !item.declaration.declare) {
        for (const name of Object.keys(t.getOuterBindingIdentifiers(item.declaration))) node.explicit.set(name, await local(name));
      }
      for (const binding of item.specifiers) if (binding.exportKind !== 'type') {
        node.explicit.set(exportName(binding.exported), item.source ? { file: await target(item.source.value), name: binding.local ? exportName(binding.local) : '*' } : await local(binding.local.name));
      }
    }
  }
  const names = new Set([...graph.values()].flatMap(node => [...node.explicit.keys()]));
  if (names.size > 4096) throw new Error('Server Action export graph exceeds 4096 names');
  function resolveExport(filename, name, seen = new Set()) {
    const identity = filename + '\0' + name;
    if (seen.has(identity)) return undefined;
    // ESM ResolveExport shares resolveSet across sibling branches, not just
    // ancestors. Visit each module/name once per resolution, including diamonds.
    seen.add(identity);
    const node = graph.get(filename), own = node.explicit.get(name);
    if (own) return own.file ? own.name === '*' ? { id: own.file + '#namespace', async: false } : resolveExport(own.file, own.name, seen) : own;
    if (name === 'default') return undefined;
    let found;
    for (const star of node.stars) {
      const value = resolveExport(star.file, name, seen);
      if (!value) continue;
      if (value.ambiguous || (found && found.id !== value.id)) return { ambiguous: true };
      found = value;
    }
    return found;
  }
  const root = graph.get(file), replacements = new Map(root.stars.map(star => [star.node, []]));
  for (const name of names) {
    if (name === 'default' || root.explicit.has(name)) continue;
    const value = resolveExport(file, name);
    if (!value || value.ambiguous) continue;
    if (value.async === false) throw new Error(`Server Action export '${name}' must be an async function (${file}).`);
    const origin = root.stars.find(star => resolveExport(star.file, name)?.id === value.id);
    replacements.get(origin.node).push({ type: 'ExportSpecifier', local: t.isValidIdentifier(name) ? t.identifier(name) : t.stringLiteral(name), exported: t.stringLiteral(name) });
  }
  ast.program.body = ast.program.body.flatMap(item => replacements.has(item)
    ? replacements.get(item).length ? [t.exportNamedDeclaration(null, replacements.get(item), item.source)] : [] : [item]);
  return generateMapped(generate, ast, { comments: true }, source, file);
}
