import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { parse } from '@babel/parser';
import { VISITOR_KEYS } from '@babel/types';
import { createNativeDiscovery } from './native-discovery.mjs';

const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const react = /^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/;
const framework = /^(?:(?:next|prnext)(?:\/|$)|server-only$|client-only$)/;
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const bare = name => !name.startsWith('.') && !name.startsWith('#') && !path.isAbsolute(name);

/** Inspect reached imports once per compiler graph; never execute npm modules. */
export function npmPackagesPlugin({ pages = false, projectRoot, transpilePackages = [], serverExternalPackages = [] }) {
  const transpile = new Set(transpilePackages), external = new Set(serverExternalPackages);
  const sources = new Map(), decisions = new Map();
  let sourceBytes = 0;
  const native = createNativeDiscovery({ projectRoot, isClientSource: source => /['"]use (?:client|server)['"]/.test(source) });
  function imports(file) {
    if (!sources.has(file)) sources.set(file, (async () => {
      if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(file)) return { imports: [] };
      const source = await readFile(file, 'utf8');
      sourceBytes += Buffer.byteLength(source);
      if (sourceBytes > 64 * 1024 * 1024) throw new Error('npm compilation analysis exceeded 64 MiB of source. Separate large runtime dependencies using serverExternalPackages.');
      if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error(`npm source ${file} exceeds the 8 MiB analysis limit. Configure serverExternalPackages for packages that do not use Next APIs.`);
      const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, allowReturnOutsideFunction: true, plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
      const result = { imports: [], computedRequire: false, frameworkBoundary: ast.program.directives.some(item => ['use client', 'use server'].includes(item.value.value)) };
      function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source && node.importKind !== 'type' && node.exportKind !== 'type') result.imports.push({ path: node.source.value, kind: 'import-statement' });
        if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.type === 'Identifier' && node.callee.name === 'require')) {
          const argument = node.arguments[0];
          if (argument?.type === 'StringLiteral') result.imports.push({ path: argument.value, kind: node.callee.type === 'Import' ? 'dynamic-import' : 'require-call' });
          else if (node.callee.type !== 'Import') result.computedRequire = true;
        }
        for (const key of VISITOR_KEYS[node.type] || []) {
          if (Array.isArray(node[key])) node[key].forEach(visit); else visit(node[key]);
        }
      }
      visit(ast.program);
      return result;
    })());
    return sources.get(file);
  }
  return { name: 'prnext-npm-packages', setup(build) {
    const resolving = { prnextNpmResolving: true, prnextNativeResolving: true };
    const resolve = (name, importer, kind) => build.resolve(name, { importer, resolveDir: path.dirname(importer), kind, pluginData: resolving });
    function classify(file) {
      if (!decisions.has(file)) decisions.set(file, (async () => {
        const queue = [file], visited = new Set();
        let directory = path.dirname(file);
        for (;;) {
          try { await readFile(path.join(directory, 'package.json')); break; }
          catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
        let needsCompiler = false, computedRequire = false;
        while (queue.length) {
          const current = queue.pop();
          if (visited.has(current)) continue;
          visited.add(current);
          if (visited.size > 4096) throw new Error(`npm dependency graph for ${file} exceeds 4096 source files. Use serverExternalPackages for packages that do not use Next APIs.`);
          const info = await imports(current);
          needsCompiler ||= info.frameworkBoundary;
          const relative = path.relative(directory, current);
          if (!relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules')) computedRequire ||= info.computedRequire;
          for (const dependency of info.imports) {
            if (framework.test(dependency.path)) { needsCompiler = true; continue; }
            if (builtins.has(dependency.path) || react.test(dependency.path)) continue;
            if (bare(dependency.path)) {
              if (transpile.has(packageName(dependency.path))) needsCompiler = true;
            }
            const resolved = await resolve(dependency.path, current, dependency.kind);
            if (!resolved.errors.length && !resolved.external && resolved.namespace === 'file') queue.push(resolved.path);
          }
        }
        return { needsCompiler, computedRequire };
      })());
      return decisions.get(file);
    }
    build.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.prnextNpmResolving || args.namespace !== 'file' || !bare(args.path) || framework.test(args.path)) return;
      if (builtins.has(args.path) || react.test(args.path)) return { path: args.path, external: true };
      const name = packageName(args.path);
      // App graphs already compile npm by default. Explicit externals need the
      // same validation as Pages to avoid bypassing compatibility transforms.
      if (!pages && !external.has(name)) return;
      const resolved = await resolve(args.path, args.importer || path.join(projectRoot, 'package.json'), args.kind);
      if (resolved.errors.length || resolved.external || resolved.namespace !== 'file') return resolved;
      const decision = await classify(resolved.path);
      const fromRoot = await resolve(args.path, path.join(projectRoot, 'package.json'), args.kind);
      const nestedResolution = fromRoot.errors.length || fromRoot.path !== resolved.path;
      const bundle = transpile.has(name) || decision.needsCompiler || nestedResolution;
      if (external.has(name) && decision.needsCompiler) throw new Error(`serverExternalPackages includes ${name}, but its imports require Next/PRNext compilation. Remove it from serverExternalPackages.`);
      if (external.has(name) && nestedResolution) throw new Error(`External package ${name} resolves differently from the application root. Install the required version as a direct application dependency.`);
      if (bundle && !external.has(name)) {
        const owner = await native.externalOwner(resolved.path, 'ssr');
        if (owner && decision.needsCompiler) throw new Error(`npm package ${name} combines Next imports with a native addon. Separate the native loader into a server-only dependency so its Next imports can be compiled.`);
        if (owner) throw new Error(`transpilePackages cannot bundle native npm package ${name}. Keep its native loader external.`);
        if (decision.computedRequire) throw new Error(`npm package ${name} needs compilation but reaches a computed require(). Use static imports or separate its runtime loader into a serverExternalPackages dependency.`);
        return resolved;
      }
      return { path: args.path, external: true };
    });
  } };
}
