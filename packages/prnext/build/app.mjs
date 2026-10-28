import {applicationEntry, frameworkImportName, frameworkRuntimeImportPattern, frameworkSubpathPattern} from './framework-imports.mjs';
import { moduleResolutionPlugin } from './module-resolution.mjs';
import { build as bundle, compilerSource,readCompilerFile } from './compiler.mjs';
import { readFile, writeFile, mkdir, cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { rewriteServerChunks } from './transform.mjs';
import { transformDynamicImports } from './dynamic.mjs';
import { createServerActions } from './actions.mjs';
import { expandActionExports } from './action-exports.mjs';
import { compileEdge } from './edge.mjs';
import { createNativePackages } from './native-packages.mjs';
import { createRefreshTransform, createSourceLocationTransform, devSingletonsPlugin, devClientFile } from './dev.mjs';
import { npmPackagesPlugin } from './npm-packages.mjs';
import { transformCacheComponents } from './cache-components.mjs';
import {createReactCompilerTransform} from './react-compiler.mjs';
import {createAppStyleGraph, appStyleScopes, planAppStyleEntries} from './app-styles.mjs';
import {selectHtmlOnlyRoutes} from './html-only-config.mjs';
import {createHtmlOnlyGraph} from './html-only-graph.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts' };
const assetLoaders = Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'].map(ext => [ext, 'file']));
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const compatibility = new Set(['link', 'image', 'head', 'router', 'compat/router', 'next-router-context', 'next-app-router-context', 'navigation', 'headers', 'server', 'cache', 'dynamic', 'script', 'og']);
const forcedClient = new Set(['link.cjs', 'image.cjs', 'head.cjs', 'router.cjs', 'compat-router.cjs', 'next-router-context.cjs', 'next-app-router-context.cjs', 'app-context.cjs', 'script.cjs']);

export async function validateReactVersions(resolveFromProject) {
  const names = ['react', 'react-dom', 'react-server-dom-webpack'];
  const ownPackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const expected = ownPackage.peerDependencies['react-server-dom-webpack'];
  const versions = await Promise.all(names.map(async name => {
    try { return JSON.parse(await readFile(resolveFromProject.resolve(`${name}/package.json`), 'utf8')).version; }
    catch { return 'missing or inaccessible'; }
  }));
  if (versions.some(version => version !== expected)) {
    throw new Error(`PRNext App Router requires exactly matching React protocol versions: ${names.map(name => `${name}@${expected}`).join(', ')}. Resolved ${names.map((name, index) => `${name}@${versions[index]}`).join(', ')}. Run npm install --save-exact ${names.map(name => `${name}@${expected}`).join(' ')} in your application. React Server Components bundler APIs are version-specific.`);
  }
}

function sourceAst(source, filename) {
  return parse(source, { sourceType: 'unambiguous', sourceFilename: filename, plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(filename) ? ['typescript'] : [])] });
}
function clientDirective(source, filename) {
  if (!source.includes('use client')) return false;
  return sourceAst(source, filename).program.directives.some(directive => directive.value.value === 'use client');
}

function frameworkDirective(source, filename) {
  if (clientDirective(source, filename)) return true;
  if (!source.includes('use server')) return false;
  function contains(node) {
    if (!node || typeof node !== 'object') return false;
    if (t.isDirective(node) && node.value.value === 'use server') return true;
    return (t.VISITOR_KEYS[node.type] || []).some(key => Array.isArray(node[key]) ? node[key].some(contains) : contains(node[key]));
  }
  return contains(sourceAst(source, filename));
}

/** Enumerate runtime ESM exports without evaluating client code in the server build. */
async function exportedNames(file, esbuild, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = await compilerSource(file);
  const ast = sourceAst(source, file);
  const names = new Set();
  for (const node of ast.program.body) {
    if (t.isExportDefaultDeclaration(node)) { names.add('default'); continue; }
    if (node.exportKind === 'type') continue;
    if (t.isExportNamedDeclaration(node)) {
      if (node.declaration && !t.isTSInterfaceDeclaration(node.declaration) && !t.isTSTypeAliasDeclaration(node.declaration) && !node.declaration.declare) {
        for (const name of Object.keys(t.getOuterBindingIdentifiers(node.declaration))) names.add(name);
      }
      for (const specifier of node.specifiers) if (specifier.exportKind !== 'type') names.add(specifier.exported.name ?? specifier.exported.value);
    }
    if (t.isExportAllDeclaration(node)) {
      const resolved = await esbuild.resolve(node.source.value, { resolveDir: path.dirname(file), kind: 'import-statement', pluginData: { prnextExportScan: true } });
      if (resolved.errors.length || !resolved.path || resolved.external) throw new Error(`Cannot enumerate client boundary exports from ${node.source.value} in ${file}. Use explicit named re-exports.`);
      for (const name of await exportedNames(resolved.path, esbuild, seen)) if (name !== 'default') names.add(name);
    }
  }
  // CommonJS is supported for npm and PRNext compatibility components. The default
  // is module.exports; statically assigned properties are named exports as in Node.
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.object, { name: 'Object' }) && t.isIdentifier(node.callee.property, { name: 'defineProperty' }) && t.isIdentifier(node.arguments[0], { name: 'exports' }) && t.isStringLiteral(node.arguments[1]) && node.arguments[1].value !== '__esModule') {
      names.add('default');
      names.add(node.arguments[1].value);
    }
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left)) {
      const left = node.left;
      const property = left.computed ? left.property.value : left.property.name;
      if (t.isIdentifier(left.object, { name: 'module' }) && property === 'exports') {
        names.add('default');
        if (t.isObjectExpression(node.right)) for (const item of node.right.properties) {
          const key = item.computed ? item.key?.value : item.key?.name ?? item.key?.value;
          if (typeof key === 'string') names.add(key);
        }
      }
      if (t.isIdentifier(left.object, { name: 'exports' }) || (t.isMemberExpression(left.object) && t.isIdentifier(left.object.object, { name: 'module' }) && left.object.property.name === 'exports')) {
        names.add('default');
        if (typeof property === 'string') names.add(property);
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(ast.program);
  names.delete('__esModule');
  return names;
}

function boundaryEntry(boundary) {
  // Explicit ESM exports also preserve named exports from CommonJS npm clients;
  // a raw CJS entry would expose only `default` to the Flight module loader.
  return `import * as client from ${JSON.stringify(boundary.file)};\n` + boundary.exports.map((name, index) => `const ref${index}=client[${JSON.stringify(name)}];export {ref${index} as ${JSON.stringify(name)}};`).join('\n');
}

function routeEntry(route, globalError, dev) {
  if (route.kind === 'api') return `export * from ${JSON.stringify(route.file)};`;
  const imports = [`import * as page from ${JSON.stringify(route.file)};`, 'export {page};', `export const pageConfig=${JSON.stringify(route.pageConfig || {})};`];
  const rootLayout = route.segments.find(segment => segment.layout)?.layout;
  imports.push(`export const rootLayout=${JSON.stringify(rootLayout ? createHash('sha256').update(rootLayout).digest('hex').slice(0, 20) : undefined)};`);
  if (route.staticMetadata) imports.push(`export const staticMetadata=${JSON.stringify(route.staticMetadata)};`);
  if (route.metadataFiles?.length) {
    const files = route.metadataFiles.map((item, index) => {
      const { file, exports: names, ...descriptor } = item;
      if (!file || !names.length) return JSON.stringify(descriptor);
      const fields = names.map((name, field) => {
        const binding = `metadata_${index}_${field}`;
        imports.push(`import {${name} as ${binding}} from ${JSON.stringify(file)};`);
        return `${name}:${binding}`;
      });
      return `{...${JSON.stringify(descriptor)},module:{${fields.join(',')}}}`;
    });
    imports.push(`export const metadataFiles=[${files.join(',')}];`);
  }
  if (globalError) imports.push(`export {default as GlobalError} from ${JSON.stringify(globalError)};`);
  imports.push(`export {default as NavigationBoundary} from ${JSON.stringify(path.join(packageRoot, 'compat/app-navigation-boundary.cjs'))};`);
  imports.push(`export {ClientPageRoot} from ${JSON.stringify(path.join(packageRoot, 'compat/app-client-page.cjs'))};`);
  imports.push(`export {LayoutProvider,LayoutSlot} from ${JSON.stringify(path.join(packageRoot, 'compat/app-layout-context.cjs'))};`);
  if (route.routing || route.segments.some(segment => segment.error)) imports.push(`export {default as ErrorBoundary} from ${JSON.stringify(path.join(packageRoot, 'compat/app-error-boundary.cjs'))};`);
  if (route.routing) {
    let index = 0;
    // Only scaffold objects owned by this compiler are immutable. Imported
    // modules and config values retain their original live bindings/behavior.
    const structural = source => dev ? source : `Object.freeze(${source})`;
    function serialize(value) {
      const files = [];
      for (const [name, file] of Object.entries(value.files)) {
        const binding = `routing_${index++}`;
        imports.push(`import * as ${binding} from ${JSON.stringify(file)};`);
        files.push(`${JSON.stringify(name)}:${binding}`);
      }
      return structural(`{path:${JSON.stringify(value.path)},segment:${JSON.stringify(value.segment)},pattern:${JSON.stringify(value.pattern)},layoutId:${JSON.stringify(value.layoutId)},config:${JSON.stringify(value.config || {})},interception:${JSON.stringify(value.interception || null)},files:${structural(`{${files.join(',')}}`)},children:${structural(`[${value.children.map(serialize).join(',')}]`)},slots:${structural(`{${Object.entries(value.slots).map(([name, child]) => `${JSON.stringify(name)}:${serialize(child)}`).join(',')}}`)}}`);
    }
    const routing = serialize(route.routing);
    imports.push(`export const routing=${routing};export const interceptionOnly=${!!route.interceptionOnly};`);
  }
  const segments = route.segments.map((segment, index) => {
    const fields = [`segment:${JSON.stringify(segment.segment)}`, `path:${JSON.stringify(segment.path)}`, `staticConfig:${JSON.stringify(segment.staticConfig || {})}`];
    for (const [name, file] of Object.entries(segment)) {
      if (name === 'segment' || name === 'path' || name === 'staticConfig') continue;
      const binding = `segment_${index}_${name}`;
      imports.push(`import * as ${binding} from ${JSON.stringify(file)};`);
      fields.push(`${name}:${binding}`);
    }
    return `{${fields.join(',')}}`;
  });
  return imports.join('\n') + `\nexport const segments=[${segments.join(',')}];\n`;
}

/** Compile independent React Server and client graphs. The RSC graph contains only references to client boundaries. */
export async function compileApp({ project, stage, manifest, cssModules, fonts, images, dev, reactCompiler = false, defineEnvironment = {}, productionBrowserSourceMaps = false, serverExternalPackages = [], moduleResolution = {} }) {
  const refresh = dev ? createRefreshTransform(project.root, {generation:manifest.cacheId,forceGeneration:manifest.devForceRefresh,forceFiles:manifest.devAffectedModules}) : undefined;
  const locations = dev ? createSourceLocationTransform(project.root) : undefined;
  const compileReact = reactCompiler ? createReactCompilerTransform(project.root, reactCompiler, {dev}) : undefined;
  const { basePath = '', assetPrefix = '', assetBase = '/_prnext/assets', trailingSlash = false, skipTrailingSlashRedirect = false } = manifest.config || {};
  const publicPath = assetBase + '/';
  const routes = project.routes.filter(route => route.router === 'app');
  const htmlOnly = dev ? new Set() : selectHtmlOnlyRoutes(project.routes, manifest.config.htmlOnly, manifest.config);
  const htmlGraph = !dev && htmlOnly.size ? createHtmlOnlyGraph(project.root) : undefined;
  if (project.appNotFound) {
    const file = path.join(stage, '.entries', 'app-not-found.jsx');
    await writeFile(file, `import {notFound} from 'next/navigation';export default function MissingRoute(){notFound()}`);
    const segments = project.appNotFound.segments.map(segment => ({ ...segment }));
    if (!segments[0].notFound) {
      const fallback = path.join(stage, '.entries', 'app-default-not-found.jsx');
      await writeFile(fallback, `export default function NotFound(){return <main style={{fontFamily:'system-ui,sans-serif',height:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}><title>404: This page could not be found.</title><h1 style={{fontSize:24,fontWeight:500,paddingRight:23,marginRight:20,borderRight:'1px solid #888'}}>404</h1><h2 style={{fontSize:14,fontWeight:400}}>This page could not be found.</h2></main>}`);
      segments[0].notFound = fallback;
    }
    const id = 'app-page-internal-not-found';
    routes.push({ ...project.appNotFound, segments, id, file, pattern: '/_not-found', kind: 'page', router: 'app', internal: true });
    manifest.appNotFound = id;
  }
  if (!routes.length) return;
  if (!manifest.config.cacheComponents && routes.some(route => route.cacheConfig?.instant !== undefined || route.pageConfig?.instant !== undefined || route.segments?.some(segment => segment.staticConfig?.instant !== undefined))) throw new Error('instant requires cacheComponents: true.');
  const actions = createServerActions({ projectRoot: project.root });
  function actionTransform(source, file, mode, runtime = 'nodejs') {
    const result = actions.transform(source, file, mode);
    if (mode !== 'browser') for (const action of actions.actions.values()) if (action.file === file) {
      (action.runtimes ||= new Set()).add(runtime);
    }
    return result;
  }
  const boundaries = new Map();
  const cssFiles = new Set();
  const styleGraph = createAppStyleGraph(project.root);
  const globalErrorCssFiles = new Set();
  const globalErrorOnlyCss = new Set();
  const canonicalPaths = new Map();
  const canonicalFile = file => {
    if (!canonicalPaths.has(file)) canonicalPaths.set(file, realpath(file));
    return canonicalPaths.get(file);
  };
  const cacheSegments = new Map();
  for (const route of routes) {
    if (route.kind === 'page') cacheSegments.set(await canonicalFile(route.file), 'page');
    for (const segment of route.segments || []) if (segment.layout) cacheSegments.set(await canonicalFile(segment.layout), 'layout');
  }
  let browserStyleRevision;
  const resolveFromProject = createRequire(path.join(project.root, 'package.json'));
  await validateReactVersions(resolveFromProject);
  const nativePackages = createNativePackages(project.root, { isClientSource: frameworkDirective });
  const clientId = file => 'client-' + createHash('sha256').update(path.relative(project.root, file).replaceAll(path.sep, '/')).digest('hex').slice(0, 16);
  // esbuild canonicalizes file paths before registering client boundaries.
  // Use that same identity when the project or convention file is a symlink.
  const globalError = routes.some(route => route.kind === 'page') && project.appGlobalError ? await canonicalFile(project.appGlobalError) : undefined;
  const globalErrorId = globalError ? clientId(globalError) : undefined;
  if (globalError && !clientDirective(await readFile(globalError, 'utf8'), globalError)) {
    throw new Error('app/global-error must be a Client Component. Add the "use client" directive.');
  }

  function graphPlugin(mode, { styleTarget = cssFiles, omitGlobalStyles = true, omitAllStyles = false } = {}) {
    const browser = mode === 'browser';
    const rsc = mode === 'rsc';
    return {
      name: `prnext-app-${mode}`,
      setup(esbuild) {
        applicationEntry(esbuild,readCompilerFile,{transformTypedHelpers:!!compileReact && (browser || mode==='ssr')});
        esbuild.onResolve({ filter: /^prnext-internal:use-cache$/ }, () => browser
          ? { errors: [{ text: "'use cache' cannot enter a Client Component graph" }] }
          : { path: '../compat/use-cache.cjs', external: true });
        if (browser && omitGlobalStyles) esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, async args => {
          if ((!omitAllStyles && !globalErrorOnlyCss.size) || /\.module\.(?:css|scss|sass)$/i.test(args.path) || args.pluginData?.prnextResolvingCss || args.pluginData?.prnextAppCss || args.kind === 'import-rule' || args.path.startsWith('prnext-css:')) return;
          const resolved = await esbuild.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { prnextAppCss: true } });
          if (!resolved.errors.length && !resolved.external && resolved.namespace === 'file' && (omitAllStyles || globalErrorOnlyCss.has(await canonicalFile(resolved.path)))) return { path: resolved.path, namespace: 'prnext-app-empty' };
        });
        esbuild.onResolve({ filter: /^prnext-internal:action-(?:crypto|client|ssr)$/ }, args => {
          const helper = args.path.slice('prnext-internal:'.length);
          if (browser && helper !== 'action-client') return { errors: [{ text: 'Server Action implementation cannot enter the browser graph.' }] };
          return browser ? { path: path.join(packageRoot, 'runtime', helper + '.mjs') } : { path: '../runtime/' + helper + '.mjs', external: true };
        });
        esbuild.onResolve({ filter: frameworkRuntimeImportPattern }, args => {
          const name = frameworkImportName(args.path);
          if (!compatibility.has(name)) return { errors: [{ text: `PRNext does not implement ${args.path} yet (imported by ${args.importer}).` }] };
          if (browser && ['headers', 'server', 'cache', 'og'].includes(name)) return { errors: [{ text: `${args.path} is server-only and cannot be imported by a Client Component.` }] };
          const target = path.join(packageRoot, 'compat', (name === 'compat/router' ? 'compat-router' : name === 'dynamic' ? 'app-dynamic' : rsc && name === 'navigation' ? 'navigation-server' : name) + '.cjs');
          if (!browser && (!rsc || !forcedClient.has(path.basename(target)))) return { path: '../compat/' + path.basename(target), external: true };
          return { path: target };
        });
        // A single compatibility context must be shared with the normal React SSR
        // runtime. Never bundle a second copy into each client SSR entry.
        if (mode === 'ssr') esbuild.onResolve({ filter: /.*/ }, args => {
          if (path.isAbsolute(args.path) && path.dirname(args.path) === path.join(packageRoot, 'compat')) return { path: '../compat/' + path.basename(args.path), external: true };
        });
        esbuild.onResolve({ filter: /^(?:server-only|client-only)$/ }, args => {
          if (args.path === 'server-only' && browser) return { errors: [{ text: `A server-only module is reachable from a Client Component (${args.importer}).` }] };
          if (args.path === 'client-only' && rsc) return { errors: [{ text: `A client-only module is reachable from a Server Component (${args.importer}). Add a 'use client' boundary.` }] };
          return { path: args.path, namespace: 'prnext-app-empty' };
        });
        esbuild.onLoad({ filter: /.*/, namespace: 'prnext-app-empty' }, () => ({ contents: '', loader: 'js' }));
        if (rsc) esbuild.onLoad({ filter: /^react$/, namespace: 'prnext-rsc-react' }, () => ({
          // Keep the real singleton while preserving bundler-style CJS access.
          // Mixed npm modules may export both server-safe components and unused
          // hook-based components. Native ESM named imports would reject the
          // entire module because React's server build has no client hooks.
          contents: `import React from 'react';export default React;export const {${Object.keys(resolveFromProject('react')).filter(name => t.isValidIdentifier(name) && name !== 'default').join(',')}}=React;`,
          loader: 'js',
        }));
        esbuild.onResolve({ filter: /^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/ }, args => {
          if (args.pluginData?.prnextExportScan) return;
          if (rsc && args.path === 'react' && args.namespace !== 'prnext-rsc-react') return { path: 'react', namespace: 'prnext-rsc-react' };
          return browser ? { path: resolveFromProject.resolve(args.path) } : { path: args.path, external: true };
        });
        if (!browser) {
          esbuild.onResolve({ filter: /.*/ }, args => {
            if (builtins.has(args.path)) return { path: args.path, external: true };
          });
          esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, async args => {
            if (args.pluginData?.prnextResolvingCss || args.pluginData?.prnextAppCss) return;
            const resolved = await esbuild.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { prnextAppCss: true, prnextResolvingCss: true } });
            if (resolved.errors.length) return { errors: resolved.errors };
            let file = resolved.path;
            if (resolved.external) file = createRequire(path.join(args.resolveDir, '__prnext_css.cjs')).resolve(args.path);
            file = await canonicalFile(file);
            styleTarget.add(file);
            if (!/\.module\.(?:css|scss|sass)$/i.test(args.path)) return { path: file, namespace: 'prnext-app-empty' };
          });
        }
        esbuild.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/, namespace: 'file' }, async args => {
          if (browser && args.path === project.document) return { errors: [{ text: 'pages/_document is server-only and cannot be imported by a Client Component.' }] };
          const original=await readCompilerFile(args.path,args.prnextSource);
          htmlGraph?.source(args.path, original);
          // Only Client Component graphs use React's memo-cache runtime. Server
          // Components, route handlers and Server Action graphs remain untouched.
          const compiled=compileReact && (browser || mode==='ssr') ? await compileReact(original,args.path,{loaderOutput:args.prnextSource!==undefined}) : original;
          const source = await fonts.transform(await expandActionExports(locations?await locations(compiled,args.path):compiled, args.path, async (specifier, importer) => {
            const resolved = await esbuild.resolve(specifier, { resolveDir: path.dirname(importer), kind: 'import-statement', pluginData: { prnextExportScan: true } });
            return resolved.errors.length || resolved.external || resolved.namespace !== 'file' ? undefined : resolved.path;
          }), args.path);
          const cacheSegment = cacheSegments.get(await canonicalFile(args.path)) || '';
          const cachedSource = transformCacheComponents(source, args.path, { enabled: manifest.config.cacheComponents, handlers: manifest.config.cacheHandlers, projectRoot: project.root, mode, buildId: manifest.cacheId, segment: cacheSegment });
          const actionSource = actionTransform(cachedSource, args.path, mode);
          const builtin = path.dirname(args.path) === path.join(packageRoot, 'compat') && forcedClient.has(path.basename(args.path));
          if (rsc && (builtin || clientDirective(source, args.path))) {
            htmlGraph?.issue(args.path, 'a Client Component or interactive framework component');
            let boundary = boundaries.get(args.path);
            if (!boundary) {
              const exports = await exportedNames(args.path, esbuild);
              boundary = { id: clientId(args.path), file: args.path, exports: [...exports].sort() };
              boundaries.set(args.path, boundary);
            }
            const references = boundary.exports.map((name, index) => builtin && path.basename(args.path) === 'image.cjs' && name === 'getImageProps' ? `export {getImageProps} from ${JSON.stringify(path.join(packageRoot, 'compat/image-shared.cjs'))};` : `const ref${index}=registerClientReference(function(){throw new Error(${JSON.stringify(`Cannot call client export ${name} from a Server Component (${path.relative(project.root, args.path)}).`)});},${JSON.stringify(boundary.id)},${JSON.stringify(name)});export {ref${index} as ${JSON.stringify(name)}};`);
            return { contents: `import {registerClientReference} from 'react-server-dom-webpack/server';\n${references.join('\n')}`, loader: 'js', resolveDir: path.dirname(args.path) };
          }
          let contents = transformDynamicImports(actionSource, args.path, { projectRoot: project.root, mode: rsc ? 'rsc' : browser ? 'browser' : 'server' });
          if (browser && refresh && !actions.isServerModule(cachedSource,args.path)) contents = await refresh(contents, args.path);
          return { contents, loader: extensions[path.extname(args.path)] || 'jsx', resolveDir: path.dirname(args.path) };
        });
      },
    };
  }

  const common = {
    absWorkingDir: project.root, bundle: true, logLevel: 'silent', jsx: 'automatic', loader: assetLoaders,
    assetNames: '[name]-[hash]', publicPath: publicPath.slice(0, -1), metafile: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...defineEnvironment },
  };
  function edgeGraphPlugin(mode) {
    const rsc = mode === 'rsc';
    const framework = new Set(['link', 'image', 'head', 'router', 'compat-router', 'next-router-context', 'next-app-router-context', 'navigation', 'script', 'app-context', 'app-layout-context', 'app-navigation-boundary', 'app-client-page', 'app-error-boundary', 'app-dynamic']);
    return { name: 'prnext-edge-app', setup(esbuild) {
      applicationEntry(esbuild,readCompilerFile,{transformTypedHelpers:!!compileReact && mode==='ssr'});
      esbuild.onResolve({filter:/^prnext-internal:action-(?:crypto|ssr)$/}, args => ({path:args.path.slice('prnext-internal:'.length),namespace:'prnext-edge-action'}));
      esbuild.onLoad({filter:/.*/,namespace:'prnext-edge-action'}, args => ({loader:'js',contents:(args.path==='action-crypto'?['encryptBoundArgs','decryptBoundArgs','bindEncryptedReference']:['createServerReference']).map(name=>`export const ${name}=globalThis.__PRNEXT_EDGE_ACTIONS[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`).join('\n')}));
      esbuild.onResolve({ filter: frameworkSubpathPattern }, args => {
        let name = frameworkImportName(args.path);
        if (name === 'dynamic') name = 'app-dynamic';
        if (name === 'compat/router') name = 'compat-router';
        if (!framework.has(name) || (rsc && name === 'navigation')) return;
        return { path: path.join(packageRoot, 'compat', name + '.cjs'), ...(!rsc || name === 'app-dynamic' ? { namespace: 'prnext-edge-framework' } : {}) };
      });
      esbuild.onResolve({ filter: /.*/ }, args => {
        if (!rsc && path.dirname(args.path) === path.join(packageRoot, 'compat') && framework.has(path.basename(args.path, '.cjs'))) return { path: args.path, namespace: 'prnext-edge-framework' };
      });
      esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, async args => {
        if (args.pluginData?.prnextResolvingCss) return;
        const resolved = await esbuild.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { prnextResolvingCss: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        cssFiles.add(await canonicalFile(resolved.path));
        // Server-only Edge components have no browser module that would import
        // their CSS. Publish that stylesheet too, then let the module plugin
        // supply the same class map to the VM and the browser stylesheet.
        if (/\.module\.(?:css|scss|sass)$/i.test(args.path)) return;
        return { path: resolved.path, namespace: 'prnext-edge-empty' };
      });
      esbuild.onLoad({ filter: /.*/, namespace: 'prnext-edge-framework' }, async args => {
        const names = await exportedNames(args.path, esbuild), name = path.basename(args.path, '.cjs');
        return { loader: 'js', contents: `const module=globalThis.__PRNEXT_EDGE_FRAMEWORK[${JSON.stringify(name)}];\n` + [...names].map((name, index) => `const value${index}=${name === 'default' ? '(module.default||module)' : `module[${JSON.stringify(name)}]`};export {value${index} as ${JSON.stringify(name)}};`).join('\n') };
      });
      if (rsc) esbuild.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/, namespace: 'file' }, async args => {
        const source = args.prnextSource ?? await readFile(args.path, 'utf8');
        const builtin = path.dirname(args.path) === path.join(packageRoot, 'compat') && forcedClient.has(path.basename(args.path));
        if (!builtin && !clientDirective(source, args.path)) return;
        let boundary = boundaries.get(args.path);
        if (!boundary) {
          boundary = { id: clientId(args.path), file: args.path, exports: [...await exportedNames(args.path, esbuild)].sort() };
          boundaries.set(args.path, boundary);
        }
        boundary.edge = true;
        return { loader: 'js', contents: `import {registerClientReference} from 'react-server-dom-webpack/server';\n` + boundary.exports.map((name, index) => `const ref${index}=registerClientReference(function(){throw new Error('Cannot call a Client Component export from the Edge server graph')},${JSON.stringify(boundary.id)},${JSON.stringify(name)});export {ref${index} as ${JSON.stringify(name)}};`).join('\n') };
      });
    } };
  }
  async function edgeAppBuild(file, outfile, mode, defaultExport = false) {
    const result = await compileEdge({ file, outfile, projectRoot: project.root, dev, defineEnvironment, reactMode: mode, defaultExport, transformTypedHelpers:!!compileReact && mode==='ssr',
      plugins: [moduleResolutionPlugin(moduleResolution, project.root), edgeGraphPlugin(mode), images.plugin(), fonts.plugin(), cssModules.plugin(false)],
      transformSource: async (source, file, builder, {loaderOutput=false}={}) => {
        const compiled=compileReact && mode==='ssr' ? await compileReact(source,file,{loaderOutput}) : source;
        return actionTransform(await fonts.transform(await expandActionExports(locations?await locations(compiled,file):compiled, file, async (specifier, importer) => {
          const resolved = await builder.resolve(specifier, {resolveDir:path.dirname(importer),kind:'import-statement',pluginData:{prnextExportScan:true}});
          return resolved.errors.length || resolved.external || resolved.namespace !== 'file' ? undefined : resolved.path;
        }), file), file, mode, 'edge');
      } });
    fonts.record(result.metafile);
    styleGraph.record(result.metafile);
    htmlGraph?.record(result.metafile);
  }
  async function serverBuild(entryPoints, outdir, mode, styleTarget = cssFiles) {
    if (!Object.keys(entryPoints).length) return;
    let output;
    for (;;) {
      const nativeVersion = nativePackages.version;
      try {
        output = await bundle({ ...common, write: false, entryPoints, outdir: path.join(stage, outdir), outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', splitting: true,
      define:{...common.define,'process.env.NEXT_RUNTIME':'"nodejs"'},
      chunkNames: 'chunk-[hash]', banner: { js: "import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);" },
      target: 'node22', conditions: mode === 'rsc' ? ['react-server', 'node'] : ['node'], sourcemap: dev,
      // Dual-format packages can retain use-client boundaries only in their
      // ESM distribution (a bundled CommonJS entry can erase those directives).
      mainFields: mode === 'rsc' ? ['module', 'main'] : ['main', 'module'],
      plugins: [moduleResolutionPlugin(moduleResolution, project.root), images.plugin(), fonts.plugin(), graphPlugin(mode, { styleTarget }), npmPackagesPlugin({ projectRoot: project.root, serverExternalPackages }), nativePackages.plugin(mode), cssModules.plugin(false)],
        });
        if (nativePackages.version !== nativeVersion) {
          nativePackages.assertCompatibleCss(cssFiles);
          continue;
        }
        break;
      } catch (error) {
        if (nativePackages.version === nativeVersion) throw error;
        nativePackages.assertCompatibleCss(cssFiles);
      }
    }
    fonts.record(output.metafile);
    styleGraph.record(output.metafile);
    htmlGraph?.record(output.metafile);
    for (const file of output.outputFiles) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }
    const chunks = new Set(Object.keys(output.metafile.outputs).filter(file => file.endsWith('.mjs')).map(file => path.basename(file)));
    for (const [file, metadata] of Object.entries(output.metafile.outputs)) {
      const absolute = path.resolve(project.root, file);
      if (file.endsWith('.mjs') && metadata.imports.some(item => !item.external)) await rewriteServerChunks(absolute, chunks, assetBase);
      if (!metadata.entryPoint && !file.endsWith('.map') && !file.endsWith('.mjs')) await cp(absolute, path.join(stage, 'assets', path.basename(file)));
    }
    return output;
  }

  async function collectBrowserStyles(browserEntries) {
    const revision = `${boundaries.size}:${actions.actions.size}:${nativePackages.version}`;
    if (browserStyleRevision === revision) return;
    // SSR intentionally erases ssr:false loaders. Discover their dependencies
    // in one browser graph, then classify styles by reachability from each root.
    const discovery = await bundle({ ...common, write: false, entryPoints: browserEntries, outdir: path.join(stage, '.browser-styles'),
      platform: 'browser', format: 'esm', target: ['es2022'], splitting: true,
      define: { 'process.env': '{}', ...common.define },
      plugins: [moduleResolutionPlugin(moduleResolution, project.root), ...(dev ? [devSingletonsPlugin()] : []), images.plugin(), fonts.plugin(), graphPlugin('browser', { omitGlobalStyles: false }), nativePackages.plugin('browser'), cssModules.plugin(true)] });
    fonts.record(discovery.metafile);
    styleGraph.record(discovery.metafile);
    const entryIds = new Map(await Promise.all(Object.entries(browserEntries).map(async ([id, file]) => [await canonicalFile(file), id])));
    const globalRoots = [], normalRoots = [];
    for (const output of Object.values(discovery.metafile.outputs)) {
      if (!output.entryPoint) continue;
      const id = entryIds.get(await canonicalFile(path.resolve(project.root, output.entryPoint)));
      if (id) (id === globalErrorId ? globalRoots : normalRoots).push(output.entryPoint);
    }
    async function collect(roots, target) {
      const seen = new Set(), pending = [...roots];
      while (pending.length) {
        const file = pending.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const input = discovery.metafile.inputs[file];
        if (!input) continue;
        if (/\.(?:css|scss|sass)$/i.test(file)) {
          const source = file.replace(/^prnext-(?:css-mapping|compiled-css):/, '');
          target.add(await canonicalFile(path.resolve(project.root, source)));
          // Keep @import/composes ordering inside its owning stylesheet, rather
          // than flattening its children into additional standalone imports.
          continue;
        }
        for (const dependency of input.imports) if (!dependency.external) pending.push(dependency.path);
      }
    }
    await Promise.all([collect(globalRoots, globalErrorCssFiles), collect(normalRoots, cssFiles)]);
    browserStyleRevision = revision;
  }

  await mkdir(path.join(stage, 'assets'), { recursive: true });
  const entries = {}, handlerEntries = {};
  for (const route of routes) {
    const entry = path.join(stage, '.entries', route.id + '.server.mjs');
    if ((route.handlerConfig?.runtime === 'edge' || route.cacheConfig?.runtime === 'edge') && manifest.config?.cacheComponents) throw new Error(`Cache Components cannot run in the Edge Runtime (${route.file}).`);
    await writeFile(entry, routeEntry(route, globalError, dev));
    if (route.cacheConfig?.runtime === 'edge' && route.kind === 'page') await edgeAppBuild(entry, path.join(stage, 'server', route.id + '.mjs'), 'rsc');
    else if (route.handlerConfig?.runtime === 'edge') await compileEdge({ file: route.file, outfile: path.join(stage, 'server', route.id + '.mjs'), projectRoot: project.root, dev, defineEnvironment });
    else (route.kind === 'api' ? handlerEntries : entries)[route.id] = entry;
    const instantConfigs = [route.pageConfig, ...(route.segments || []).map(segment=>segment.staticConfig)];
    const collectInstant = node => {if(!node)return;instantConfigs.push(...Object.values(node.config || {}));for(const child of [...(node.children || []),...Object.values(node.slots || {})])collectInstant(child);};
    collectInstant(route.routing);
    manifest.routes.push({ id: route.id, pattern: route.pattern, kind: route.kind, router: 'app', module: `server/${route.id}.mjs`, css: [], ...(route.internal ? { internal: true } : {}),
      ...(!dev && htmlOnly.has(route.id) ? { htmlOnly:true } : {}),
      ...(route.parallel ? { parallel: true, interception: !!route.interception } : {}),
      ...(route.cacheConfig ? { cacheConfig: route.cacheConfig } : {}),
      ...(route.kind === 'page' ? { instantSamples: [route.pageConfig, ...[...route.segments].reverse().map(segment => segment.staticConfig)].find(config => config?.instant?.unstable_samples)?.instant.unstable_samples, instantBuild: instantConfigs.some(config => config?.instant?.level === 'experimental-error'), hasStaticParams: route.id !== manifest.appNotFound && !!(route.pageConfig?.generateStaticParams || route.segments.some(segment => segment.staticConfig?.generateStaticParams)) }
        : { handlerConfig: route.handlerConfig || {}, hasStaticParams: !!route.handlerConfig?.generateStaticParams }),
    });
  }
  manifest.app = { clientModules: {}, actions: {}, actionKey: actions.actionKey };
  const actionRevision = () => [...actions.actions.values()].map(action=>action.id+':'+[...(action.runtimes || [])].sort().join(',')).join(';');
  const boundaryRevision = () => [...boundaries.values()].map(boundary=>boundary.id+':'+!!boundary.edge).join(';');
  const browserRevision = () => `${boundaryRevision()}:${cssFiles.size}:${globalErrorCssFiles.size}:${nativePackages.version}`;
  // Route Handlers have a Node React environment and must not share RSC chunks
  // that import registerServerReference or client-reference registration.
  await serverBuild(handlerEntries, 'server', 'route');
  for (;;) {
    // Each graph consumes discoveries from the preceding one. Discovering a
    // client boundary in RSC is normal: SSR and browser below already include
    // it. Only discoveries made too late for a graph require another pass.
    const emittedActions = actionRevision();
    for (const action of actions.actions.values()) {
      const entry = path.join(stage, '.entries', 'action-' + action.id + '.mjs');
      await writeFile(entry, `export {${JSON.stringify(action.binding)} as invoke} from ${JSON.stringify(action.file)};`);
      if (action.runtimes?.has('edge')) await edgeAppBuild(entry, path.join(stage, 'server', 'action-edge-' + action.id + '.mjs'), 'rsc');
      if (!action.runtimes?.size || action.runtimes.has('nodejs')) entries['action-' + action.id] = entry;
    }
    await serverBuild(entries, 'server', 'rsc');
    const serverNativeVersion = nativePackages.version;
    const emittedBoundaries = boundaryRevision();
    const ssrEntries = {};
    const globalSsrEntries = {};
    for (const boundary of boundaries.values()) {
      const entry = path.join(stage, '.entries', boundary.id + '.ssr.mjs');
      await writeFile(entry, boundaryEntry(boundary));
      (boundary.id === globalErrorId ? globalSsrEntries : ssrEntries)[boundary.id] = entry;
    }
    await serverBuild(ssrEntries, 'app-ssr', 'ssr');
    for (const boundary of boundaries.values()) if (boundary.edge) await edgeAppBuild(path.join(stage, '.entries', boundary.id + '.ssr.mjs'), path.join(stage, 'app-ssr-edge', boundary.id + '.mjs'), 'ssr', boundary.exports.includes('default'));
    await serverBuild(globalSsrEntries, 'app-ssr', 'ssr', globalErrorCssFiles);
    const browserEntries = {};
    for (const boundary of boundaries.values()) {
      const entry = path.join(stage, '.entries', boundary.id + '.browser.mjs');
      await writeFile(entry, boundaryEntry(boundary));
      browserEntries[boundary.id] = entry;
    }
    await collectBrowserStyles(browserEntries);
    globalErrorOnlyCss.clear();
    for (const file of globalErrorCssFiles) if (!cssFiles.has(file)) globalErrorOnlyCss.add(file);
    const emittedBrowserInputs = browserRevision();
    if (routes.some(route => route.kind === 'page')) {
    let globalErrorCss = [];
    if (globalErrorCssFiles.size) {
      const styleEntry = path.join(stage, '.entries', 'app-global-error-style.mjs');
      await writeFile(styleEntry, [...globalErrorCssFiles].map(file => `import ${JSON.stringify(file)};`).join('\n'));
      const styles = await bundle({ ...common, entryPoints: { 'app-global-error-style': styleEntry }, outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]',
        platform: 'browser', format: 'esm', target: ['es2022'], minify: !dev, sourcemap: dev || productionBrowserSourceMaps,
        plugins: [moduleResolutionPlugin(moduleResolution, project.root), images.plugin(), fonts.plugin(), graphPlugin('browser', { omitGlobalStyles: false }), cssModules.plugin(true)] });
      globalErrorCss = Object.values(styles.metafile.outputs).filter(output => output.cssBundle).map(output => publicPath + path.basename(output.cssBundle));
    }
    if (globalErrorId) manifest.app.globalError = { id: globalErrorId, name: 'default', css: globalErrorCss };
    const runtimeEntry = path.join(stage, '.entries', 'app-runtime.mjs');
    const htmlOnlyRoutes = !dev && htmlOnly.size ? routes.filter(route => route.kind === 'page' && !route.internal).map(route => ({pattern:route.pattern,...(htmlOnly.has(route.id)?{htmlOnly:true}:{})})) : undefined;
    const importers = Object.entries(browserEntries).map(([id, file]) => `${JSON.stringify(id)}:()=>import(${JSON.stringify(file)})`);
    await writeFile(runtimeEntry, `${dev ? `import ${JSON.stringify(devClientFile)};\n` : ''}\nimport {bootstrapApp} from ${JSON.stringify(path.join(packageRoot, 'runtime/app-client.mjs'))};\nbootstrapApp({clientModules:{${importers.join(',')}},...${JSON.stringify({ basePath, assetPrefix, assetBase, htmlOnlyRoutes, trailingSlash, skipTrailingSlashRedirect, deploymentId: dev ? undefined : manifest.cacheId, strictMode: manifest.config.reactStrictMode !== false, cacheComponents: manifest.config.cacheComponents === true, ...(globalErrorId ? { globalErrorId, globalErrorCss } : {}), ...(dev ? { dev: { buildId: manifest.buildId, clientManifest: manifest.devClient, onDemand:manifest.devOnDemand===true, sequence:manifest.devSequence, session:manifest.devSession, indicator:manifest.devIndicators, ...(manifest.devTools ? {tools:manifest.devTools} : {}) } } : {}) })}});\n`);
    const clientEntries = { 'app-runtime': runtimeEntry, ...browserEntries };
    const browser = await bundle({ ...common, entryPoints: clientEntries, outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'app-chunk-[hash]', platform: 'browser', format: 'esm', target: ['es2022'], splitting: true, minify: !dev, sourcemap: dev || productionBrowserSourceMaps,
      define: { 'process.env': '{}', ...common.define, __PRNEXT_CACHE_COMPONENTS__: JSON.stringify(manifest.config.cacheComponents === true) }, plugins: [moduleResolutionPlugin(moduleResolution, project.root), ...(dev ? [devSingletonsPlugin()] : []), images.plugin(), fonts.plugin(), graphPlugin('browser', { omitAllStyles: true }), nativePackages.plugin('browser'), cssModules.plugin(true, { emitStyles: () => false })] });
    fonts.record(browser.metafile);
    const entryIds = new Map(Object.entries(clientEntries).map(([id, file]) => [file, id]));
    const edgeBoundaries = new Set([...boundaries.values()].filter(boundary => boundary.edge).map(boundary => boundary.id));
    let client;
    for (const [output, metadata] of Object.entries(browser.metafile.outputs)) {
      if (!metadata.entryPoint || !output.endsWith('.js')) continue;
      const id = entryIds.get(path.resolve(project.root, metadata.entryPoint));
      if (id === 'app-runtime') { client = publicPath + path.basename(output); continue; }
      if (!id) continue;
      manifest.app.clientModules[id] = { id, chunks: [id, publicPath + path.basename(output)], name: '*', ssrModule: `app-ssr/${id}.mjs`, ...(edgeBoundaries.has(id) ? { edgeSsrModule: `app-ssr-edge/${id}.mjs` } : {}), browserModule: publicPath + path.basename(output) };
    }
    const styleBundles = new Map();
    for (const route of routes.filter(route => route.kind === 'page')) {
      // All esbuild graphs canonicalize their inputs, including symlinked
      // convention files. Match those identities before querying reachability.
      for (const files of appStyleScopes(route)) for (const file of files) styleGraph.alias(file, await canonicalFile(file));
      const plan = planAppStyleEntries(route, styleGraph);
      const styles = [];
      const cssScopes = [];
      for (const { styles:files, path:scopePath, kind } of plan) {
        const signature = JSON.stringify(files);
        if (!styleBundles.has(signature)) {
          const id = 'app-style-' + createHash('sha256').update(files.map(file => path.relative(project.root, file).replaceAll(path.sep, '/')).join('\0')).digest('hex').slice(0, 16);
          const styleEntry = path.join(stage, '.entries', id + '.mjs');
          await writeFile(styleEntry, files.map(file => `import ${JSON.stringify(file)};`).join('\n'));
          const output = await bundle({ ...common, entryPoints: { [id]: styleEntry }, outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]', platform: 'browser', format: 'esm', target: ['es2022'], minify: !dev, sourcemap: dev || productionBrowserSourceMaps,
            plugins: [moduleResolutionPlugin(moduleResolution, project.root), images.plugin(), fonts.plugin(), graphPlugin('browser', { omitGlobalStyles: false }), cssModules.plugin(true)] });
          styleBundles.set(signature, Object.values(output.metafile.outputs).filter(output => output.cssBundle).map(output => publicPath + path.basename(output.cssBundle)));
        }
        const css = styleBundles.get(signature);
        styles.push(...css);
        if (route.parallel) cssScopes.push({ path:scopePath, kind, css });
      }
      const emitted = manifest.routes.find(item => item.id === route.id);
      if (!emitted.htmlOnly) emitted.client = client;
      emitted.css = [...new Set(styles)];
      if (route.parallel) emitted.cssScopes = cssScopes;
    }
    }
    manifest.app.actions = Object.fromEntries([...actions.actions.values()].map(action => [action.id, {
      module: `server/action-${action.runtimes?.has('nodejs')?'':'edge-'}${action.id}.mjs`, export: 'invoke',
      ...(action.runtimes?.has('edge') ? {edgeModule:`server/action-edge-${action.id}.mjs`} : {}),
    }]));
    if (emittedActions === actionRevision() && emittedBoundaries === boundaryRevision() &&
        serverNativeVersion === nativePackages.version && emittedBrowserInputs === browserRevision()) break;
  }

  if (htmlGraph) for (const route of routes) if (htmlOnly.has(route.id)) {
    for (const file of [...appStyleScopes(route).flat(), ...(route.metadataFiles || []).map(item=>item.file)].filter(Boolean)) htmlGraph.alias(file, await canonicalFile(file));
    htmlGraph.validate(route);
  }

}
