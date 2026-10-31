import { parse } from '@babel/parser';
import { context as esbuildContext } from 'esbuild';
import { readFile, realpath, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { frameworkImportName, frameworkRuntimeImportPattern } from './framework-imports.mjs';
import { packageManifest } from '../native/resolve.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const code = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const slash = name => name.split(path.sep).join('/');
const limits = Object.freeze({ modules: 2000, edges: 12000, bytes: 32 * 1024 ** 2, depth: 32, findings: 2000 });
const isType = node => node.importKind === 'type' || node.exportKind === 'type';
const literal = node => node?.type === 'StringLiteral' ? node.value : undefined;
const property = node => node && (!node.computed && node.property?.name || literal(node.property));

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function sourceImports(ast) {
  const found = [], calls = new Map();
  walk(ast.program, node => {
    if (isType(node)) return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      const entries = (node.specifiers || []).filter(item => !isType(item));
      if (node.specifiers?.length && !entries.length) return;
      const names = entries.filter(item => item.type !== 'ImportNamespaceSpecifier').map(item => item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported?.name || item.imported?.value || item.local?.name).filter(Boolean);
      found.push({ specifier: node.source.value, line: node.loc.start.line, names, kind: 'import-statement' });
    }
    if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.type === 'Identifier' && node.callee.name === 'require')) {
      const specifier = literal(node.arguments[0]);
      if (specifier !== undefined) { const item = { specifier, line: node.loc.start.line, names: [], kind: node.callee.type === 'Import' ? 'dynamic-import' : 'require-call' }; found.push(item); calls.set(node, item); }
      else if (node.arguments.length) found.push({ specifier: null, line: node.loc.start.line, names: [], kind: 'computed-import' });
    }
  });
  walk(ast.program, node => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || !calls.has(node.init)) return;
    calls.get(node.init).names = node.id.properties.filter(item => item.type === 'ObjectProperty' && !item.computed).map(item => item.key.name || item.key.value);
  });
  return found;
}

// Read adapter declarations, never require an adapter or execute application code.
async function adapterExports(filename) {
  const ast = parse(await readFile(filename, 'utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] });
  const names = new Set(), cjs = filename.endsWith('.cjs');
  let complete = true;
  walk(ast.program, node => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      const left = node.left, object = left.object;
      const moduleExports = object?.type === 'Identifier' && object.name === 'module' && property(left) === 'exports';
      const named = object?.type === 'Identifier' && object.name === 'exports' || object?.type === 'MemberExpression' && object.object?.name === 'module' && property(object) === 'exports';
      if (moduleExports) {
        names.add('default');
        if (node.right.type === 'ObjectExpression') for (const item of node.right.properties) {
          if (item.type === 'SpreadElement' || item.computed) complete = false;
          else names.add(item.key.name || item.key.value);
        }
        else if (!['Identifier', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.right.type)) complete = false;
      }
      else if (named && property(left)) names.add(property(left));
    }
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type === 'ExportAllDeclaration') complete = false;
    if (node.type === 'ExportNamedDeclaration') {
      for (const item of node.specifiers) names.add(item.exported?.name || item.exported?.value);
      const declaration = node.declaration;
      if (declaration?.id?.name) names.add(declaration.id.name);
      for (const item of declaration?.declarations || []) if (item.id.type === 'Identifier') names.add(item.id.name); else complete = false;
    }
  });
  if (cjs) names.add('default');
  return { names, complete };
}

function adapterFile(name) {
  if (name === 'next-router-context' || name === 'next-app-router-context') return path.join(packageRoot, `compat/${name}.cjs`);
  let target = packageManifest.exports[`./${name}`];
  if (target && typeof target === 'object') target = target.default;
  return typeof target === 'string' && code.test(target) ? path.resolve(packageRoot, target) : null;
}

/** Follow only imported modules. Resolution reads package metadata; no module is loaded. */
export async function auditImportGraph(root, sourceFiles) {
  const findings = [], imports = [], dependencies = new Map(), seen = new Set(), physical = new Set(), adapters = new Map();
  const queue = sourceFiles.map(filename => ({ filename, chain: [], realm: 'node', package: null }));
  let bytes = 0, edges = 0, unknown = 0, limited = false;
  const emitted = new Set(), resolvers = new Map();
  const fileLabel = item => item.package ? `npm:${item.package.name}/${slash(path.relative(item.package.root, item.filename))}` : slash(path.relative(root, item.filename));
  function finding(item, entry, id, severity, message, action) {
    const key = `${fileLabel(item)}:${entry?.line || 0}:${id}:${entry?.specifier || ''}:${message}`;
    if (emitted.has(key)) return;
    if (findings.length >= limits.findings) { limited = true; return; }
    emitted.add(key);
    findings.push({ severity, id, file: fileLabel(item), line: entry?.line || 1, message, action, chain: item.chain });
  }
  async function resolve(specifier, item, kind, realm) {
    if (!resolvers.has(realm)) {
      let builder;
      const context = await esbuildContext({ absWorkingDir: root, stdin: { contents: '', resolveDir: root }, bundle: true, write: false, logLevel: 'silent', platform: realm === 'browser' ? 'browser' : 'node', conditions: realm === 'rsc' ? ['react-server'] : [], plugins: [{ name: 'migration-resolver', setup(build) { builder = build; } }] });
      resolvers.set(realm, { context, builder });
    }
    return resolvers.get(realm).builder.resolve(specifier, { resolveDir: path.dirname(item.filename), importer: item.filename, kind });
  }
  async function packageFor(filename, specifier, inherited) {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) return inherited;
    // Package roots are discovered upward from the resolved file, including pnpm
    // stores and workspace symlinks. Never enumerate their sibling packages.
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    let directory = path.dirname(filename);
    for (let depth = 0; depth < 32; depth++) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name === name) return { name, version: typeof metadata.version === 'string' ? metadata.version : null, root: directory };
      } catch {}
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    return null;
  }
  try {
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      if (physical.size >= limits.modules || edges >= limits.edges || bytes >= limits.bytes) { limited = true; break; }
      let filename, source, ast;
      try {
        filename = await realpath(item.filename);
        const key = `${filename}:${item.realm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const info = await stat(filename);
        if (!info.isFile() || info.size > limits.bytes - bytes) { limited = true; break; }
        bytes += info.size; physical.add(filename);
        source = await readFile(filename, 'utf8');
        ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx', ...( /\.[cm]?tsx?$/.test(filename) ? ['typescript'] : []), 'decorators-legacy'] });
      } catch {
        unknown++;
        finding(item, null, 'source-syntax', 'warning', 'This imported source could not be read or parsed.', 'Run a production build with the application loaders to validate this module.');
        continue;
      }
      item.filename = filename;
      const client = ast.program.directives.some(value => value.value.value === 'use client');
      const realm = client ? 'browser' : item.realm;
      for (const entry of sourceImports(ast)) {
        if (++edges > limits.edges) { limited = true; break; }
        if (!entry.specifier) { unknown++; finding(item, entry, 'computed-import', 'info', 'A computed import needs runtime validation.', 'Exercise this code path in the production build and application tests.'); continue; }
        if (frameworkRuntimeImportPattern.test(entry.specifier)) {
          const name = frameworkImportName(entry.specifier), target = adapterFile(name), available = !!target;
          imports.push({ file: fileLabel(item), line: entry.line, specifier: entry.specifier, supported: available, exports: entry.names, chain: item.chain });
          if (!available) finding(item, entry, 'unsupported-import', 'error', `No PRNext runtime adapter for ${entry.specifier}.`, 'Replace this import with a supported public API or keep this route on Next.js.');
          else {
            if (!adapters.has(target)) adapters.set(target, await adapterExports(target));
            const adapter = adapters.get(target);
            const compilerOwned = ['font/google', 'font/local'].includes(name);
            if (compilerOwned) {
              unknown++;
              finding(item, entry, 'compiler-import', 'info', `${entry.specifier} is resolved by the production font transform.`, 'Run a production build to validate this font name and its options.');
            }
            for (const name of entry.names) if (!adapter.names.has(name) && !compilerOwned) {
              if (adapter.complete) finding(item, entry, 'unsupported-export', 'error', `${entry.specifier} does not provide the runtime export "${name}" in this PRNext release.`, 'Use an export provided by this release or retain the original framework for this code path.');
              else { unknown++; finding(item, entry, 'unknown-export', 'warning', `The runtime export "${name}" from ${entry.specifier} could not be checked statically.`, 'Validate this import with a production build.'); }
            }
            if (realm === 'browser' && ['headers', 'cache', 'server', 'og'].includes(name)) finding(item, entry, 'server-import-in-client', 'error', `${entry.specifier} is imported by a client module.`, 'Move the server operation into a Server Component or Server Action.');
          }
          continue;
        }
        if (builtins.has(entry.specifier) || /^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/.test(entry.specifier)) continue;
        // CSS, images and native addons are owned by loaders/native packaging.
        if (/\.(?:css|s[ac]ss|less|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|json)$/.test(entry.specifier)) continue;
        if (item.chain.length >= limits.depth) { unknown++; limited = true; continue; }
        const resolution = await resolve(entry.specifier, item, entry.kind, realm);
        if (resolution.errors.length || resolution.external || !resolution.path) {
          unknown++;
          finding(item, entry, 'unresolved-import', 'warning', `The imported module "${entry.specifier}" could not be resolved for this audit.`, 'Install the application dependencies and run a production build; custom aliases and optional imports may need application-specific validation.');
          continue;
        }
        if (!code.test(resolution.path)) { unknown++; finding(item, entry, 'loader-import', 'info', `The imported module "${entry.specifier}" requires loader or native validation.`, 'Validate it with a production build and deployed application tests.'); continue; }
        const dependency = await packageFor(resolution.path, entry.specifier, item.package);
        if (dependency) {
          const key = `${dependency.name}@${dependency.version || 'unknown'}`;
          if (!dependencies.has(key)) dependencies.set(key, { name: dependency.name, version: dependency.version, state: 'checked', importedBy: [] });
          const record = dependencies.get(key);
          if (record.importedBy.length < 16 && !record.importedBy.some(value => value.file === fileLabel(item) && value.line === entry.line)) record.importedBy.push({ file: fileLabel(item), line: entry.line, specifier: entry.specifier });
        }
        queue.push({ filename: resolution.path, realm, package: dependency, chain: [...item.chain, { file: fileLabel(item), line: entry.line, specifier: entry.specifier }] });
        // Server Component package exports can differ from ordinary Node exports.
        // Check both statically instead of certifying only one conditional branch.
        if (realm === 'node' && !item.package && /(?:^|[\\/])app[\\/]/.test(item.filename)) {
          const rsc = await resolve(entry.specifier, item, entry.kind, 'rsc');
          // Preserve the realm even when this hop resolves to the same helper:
          // a later package import can select a different react-server export.
          // The (physical file, realm) seen key deduplicates each traversal, and
          // both reads still count toward the same byte/edge/module budgets.
          if (!rsc.errors.length && rsc.path && code.test(rsc.path)) queue.push({ filename: rsc.path, realm: 'rsc', package: await packageFor(rsc.path, entry.specifier, item.package), chain: [...item.chain, { file: fileLabel(item), line: entry.line, specifier: entry.specifier }] });
        }
      }
      if (limited && edges >= limits.edges) break;
    }
  } finally { await Promise.all([...resolvers.values()].map(value => value.context.dispose())); }
  if (limited) findings.push({ severity: 'warning', id: 'import-graph-limit', file: null, line: null, message: 'The imported dependency graph exceeded an audit limit.', action: 'Run a production build and application tests; this audit does not cover the remaining modules.' });
  return { imports, findings, dependencies: [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name)), evidence: { state: unknown || limited ? 'unknown' : 'checked', modules: physical.size, edges, bytes, limits, unknown, limited, scope: 'Static imports and selected Node, browser and React Server Component package conditions. A checked module is not a compatibility certification; custom loaders, aliases, runtime branches and behavior still require a production build and application tests.' } };
}
