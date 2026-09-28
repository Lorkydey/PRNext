import {generateMapped} from './source-maps.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { compileFont } from './font-files.mjs';

const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;
const fontImport = /^(?:next|prnext|@thomas\.f\/prnext)\/font\/(local|google)(?:\.js)?$/;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);

function literal(node, file) {
  while (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node) || t.isTSNonNullExpression(node)) node = node.expression;
  if (t.isStringLiteral(node) || t.isBooleanLiteral(node) || t.isNumericLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) return -node.argument.value;
  if (t.isArrayExpression(node)) return node.elements.map(item => literal(item, file));
  if (t.isObjectExpression(node)) {
    const result = Object.create(null);
    for (const item of node.properties) {
      if (!t.isObjectProperty(item) || item.computed || item.method) throw new Error(`Font options must contain only literal properties (${file}).`);
      const key = t.isIdentifier(item.key) ? item.key.name : item.key.value;
      result[key] = literal(item.value, file);
    }
    return result;
  }
  throw new Error(`Font options must be statically written literals, without variables, spreads or function calls (${file}).`);
}

/** Fonts are compiled once per build; generated modules contain only objects and CSS imports. */
export function createFonts({ projectRoot, stage, assetBase }) {
  const sources = new Map(), compilations = new Map(), modules = new Map(), styles = new Set(), graph = new Map();
  async function prepare(kind, name, options, file, position) {
    const id = hash(JSON.stringify([path.relative(projectRoot, file), position, kind, name, options]));
    if (!compilations.has(id)) compilations.set(id, (async () => {
      const compiled = await compileFont({ kind, name, options, file, id, stage, assetBase });
      const moduleFile = path.join(stage, '.entries', `font-${id}.mjs`);
      const cssFile = path.join(stage, '.entries', `font-${id}.css`);
      await mkdir(path.dirname(moduleFile), { recursive: true });
      await writeFile(cssFile, compiled.css);
      await writeFile(moduleFile, `import ${JSON.stringify(cssFile)};\nexport default ${JSON.stringify(compiled.value)};\n`);
      modules.set(moduleFile, compiled.preloads);
      styles.add(cssFile);
      return moduleFile;
    })());
    return compilations.get(id);
  }
  async function transformSource(source, file) {
    if (/(?:^|[/\\])pages[/\\]_document\.[cm]?[jt]sx?$/.test(file)) throw new Error('next/font cannot be used in pages/_document. Define fonts in pages/_app or a page component.');
    const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
    let program;
    traverse(ast, { Program(value) { program = value; value.stop(); } });
    const imports = [], calls = [];
    for (const statement of program.get('body')) {
      if (!statement.isImportDeclaration() || !fontImport.test(statement.node.source.value) || statement.node.importKind === 'type') continue;
      const kind = fontImport.exec(statement.node.source.value)[1];
      for (const item of statement.node.specifiers) {
        if (item.importKind === 'type') continue;
        if (kind === 'local' ? !t.isImportDefaultSpecifier(item) : !t.isImportSpecifier(item)) throw new Error(`${statement.node.source.value} requires ${kind === 'local' ? 'a default import' : 'named font imports'} (${file}).`);
        const name = kind === 'local' ? 'local' : item.imported.name || item.imported.value;
        const binding = program.scope.getBinding(item.local.name);
        for (const reference of binding.referencePaths) {
          const call = reference.parentPath;
          const declaration = call.parentPath;
          const variable = declaration?.parentPath;
          const owner = variable?.parentPath?.isExportNamedDeclaration() ? variable.parentPath.parentPath : variable?.parentPath;
          if (!call.isCallExpression() || call.node.callee !== reference.node || !declaration.isVariableDeclarator() || declaration.node.init !== call.node || !t.isIdentifier(declaration.node.id) || !variable.isVariableDeclaration({ kind: 'const' }) || !owner?.isProgram()) {
            throw new Error(`Font loaders must be called and assigned to a const at module scope (${file}).`);
          }
          if (call.node.arguments.length > 1) throw new Error(`Font loaders accept a single options object (${file}).`);
          const options = call.node.arguments.length ? literal(call.node.arguments[0], file) : {};
          const identifier = program.scope.generateUidIdentifier('prnextFont');
          calls.push({ kind, name, options, position: call.node.start, call, identifier });
        }
      }
      imports.push(statement);
    }
    if (!imports.length) return source;
    for (const item of calls) {
      const moduleFile = await prepare(item.kind, item.name, item.options, file, item.position);
      item.call.replaceWith(item.identifier);
      program.node.body.unshift(t.importDeclaration([t.importDefaultSpecifier(item.identifier)], t.stringLiteral(moduleFile)));
    }
    for (const statement of imports) statement.remove();
    return generateMapped(generate, ast, { retainLines: true }, source, file);
  }
  const normalize = file => path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
  return {
    transform(source, file) {
      if (!/(?:next|prnext|@thomas\.f\/prnext)\/font\//.test(source)) return source;
      const key = `${file}\0${hash(source)}`;
      if (!sources.has(key)) sources.set(key, transformSource(source, file));
      return sources.get(key);
    },
    plugin() {
      return { name: 'prnext-font-assets', setup(build) {
        build.onResolve({ filter: /font-[a-f0-9]+\.mjs$/ }, args => modules.has(args.path) ? { path: args.path } : undefined);
        // Generated CSS must not run through application PostCSS plugins again.
        build.onLoad({ filter: /\.css$/, namespace: 'file' }, async args => styles.has(args.path) ? { contents: await readFile(args.path, 'utf8'), loader: 'css', resolveDir: path.dirname(args.path) } : undefined);
        build.onResolve({ filter: /^\// }, args => args.kind === 'url-token' && styles.has(args.importer) ? { path: args.path, external: true } : undefined);
        build.onResolve({ filter: /^https?:\/\// }, args => args.kind === 'url-token' && styles.has(args.importer) ? { path: args.path, external: true } : undefined);
      } };
    },
    record(metafile) {
      for (const [file, input] of Object.entries(metafile.inputs)) {
        const key = normalize(file);
        if (!graph.has(key)) graph.set(key, new Set());
        for (const dependency of input.imports) if (!dependency.external) graph.get(key).add(normalize(dependency.path));
      }
    },
    attach(manifest) {
      for (const route of manifest.routes) {
        if (route.kind !== 'page') continue;
        const pending = [path.join(stage, '.entries', `${route.id}.server.mjs`)];
        const visited = new Set(), preloads = new Map();
        while (pending.length) {
          const file = pending.pop();
          if (visited.has(file)) continue;
          visited.add(file);
          for (const preload of modules.get(file) || []) preloads.set(preload.href, preload);
          for (const dependency of graph.get(file) || []) pending.push(dependency);
        }
        if (preloads.size) route.fonts = [...preloads.values()];
      }
    },
  };
}
