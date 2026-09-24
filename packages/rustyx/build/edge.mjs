import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules, createRequire } from 'node:module';
import { build } from './compiler.mjs';
import { parse } from '@babel/parser';
import traversePackage from '@babel/traverse';
import { cachedTransform } from './transform-cache.mjs';
import generatePackage from '@babel/generator';
import {generateMapped,sourceMapsEnabled,inlineSourceMap,extractSourceMap} from './source-maps.mjs';

const traverse = traversePackage.default || traversePackage;
const compat = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../compat');
const builtin = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const trusted = new Set(['server-primitives.cjs', 'cookies.cjs', 'paths.cjs', 'locale.cjs', 'constants.cjs'].map(name => path.join(compat, name)));
const names = {
  headers: ['headers', 'cookies', 'draftMode'],
  cache: ['revalidateTag', 'revalidatePath', 'unstable_noStore'],
  navigation: ['redirect', 'permanentRedirect', 'notFound', 'RedirectType', 'unstable_rethrow'],
};

function validate(source, file, reactMode) {
  return cachedTransform('edge-validation',source,[file,reactMode],()=>validateUncached(source,file,reactMode));
}
function validateUncached(source,file,reactMode) {
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(file) ? ['typescript'] : [])] });
  const edits = [];
  const fail = message => { throw new Error(`Edge Runtime ${file}: ${message}`); };
  if (ast.program.directives.some(item => (reactMode === 'ssr' ? ['use server', 'use cache', 'use cache: private', 'use cache: remote'] : ['use client', 'use server', 'use cache', 'use cache: private', 'use cache: remote']).includes(item.value.value))) fail('This React boundary, Server Actions or Cache Components cannot run in the Edge graph.');
  traverse(ast, {
    Directive(nodePath) { if (nodePath.node.value.value === 'use server' || nodePath.node.value.value.startsWith('use cache')) fail('Server Actions and Cache Components are not implemented in the Edge graph.'); },
    UnaryExpression(nodePath) {
      const { node } = nodePath;
      if (node.operator === 'typeof' && node.argument.type === 'Identifier' && node.argument.name === 'require' && !nodePath.scope.hasBinding('require')) {
        edits.push({ start: node.start, end: node.end, text: 'typeof globalThis.require' });
        node.argument={type:'MemberExpression',object:{type:'Identifier',name:'globalThis'},property:{type:'Identifier',name:'require'},computed:false};
      }
    },
    'CallExpression|OptionalCallExpression|NewExpression'(nodePath) {
      const node = nodePath.node, callee = node.callee;
      if (callee.type === 'Identifier' && callee.name === 'require' && !nodePath.scope.hasBinding('require', true)) {
        if (node.type !== 'CallExpression' || node.arguments.length !== 1 || node.arguments[0]?.type !== 'StringLiteral') fail('dynamic require() is not supported; dependencies must be statically bundled.');
      } else if (callee.type === 'Identifier' && ['eval', 'Function'].includes(callee.name) && !nodePath.scope.hasBinding(callee.name, true)) fail(`${callee.name}() is not supported; use ESM imports and precompiled JavaScript.`);
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && ['globalThis', 'self'].includes(callee.object.name) && ['require', 'eval', 'Function'].includes(callee.computed ? callee.property.value : callee.property.name)) fail('Dynamic JavaScript compilation and require() are not supported.');
      if (callee.type === 'Import' && node.arguments[0]?.type !== 'StringLiteral') fail('dynamic import paths must be string literals so they can be bundled.');
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'WebAssembly' && ['compile', 'compileStreaming', 'Module'].includes(callee.computed ? callee.property.value : callee.property.name)) fail('dynamic WebAssembly compilation is not supported.');
    },
    ReferencedIdentifier(nodePath) {
      const name = nodePath.node.name;
      if (nodePath.scope.hasBinding(name, true)) return;
      const parent = nodePath.parent;
      if (name === 'module' && !(parent.type === 'MemberExpression' && parent.object === nodePath.node && (parent.computed ? parent.property.value : parent.property.name) === 'exports')) fail('Only statically bundled module.exports is supported in Edge; Node module APIs are unavailable.');
      if (name === 'require' && !(parent.type === 'CallExpression' && parent.callee === nodePath.node && parent.arguments.length === 1 && parent.arguments[0]?.type === 'StringLiteral') && !(parent.type === 'UnaryExpression' && parent.operator === 'typeof')) fail('A runtime require reference is not supported in Edge.');
    },
  });
  if(edits.length && sourceMapsEnabled())return generateMapped(generatePackage.default || generatePackage,ast,{comments:true},source,file);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

/** Bundle the entire application graph as Web ESM before entering the V8 realm. */
export async function compileEdge({ file, outfile, projectRoot, dev = false, defineEnvironment = {}, defaultExport = false, reactMode, plugins = [], transformSource }) {
  const runtime = path.resolve(path.dirname(outfile), '../runtime');
  await mkdir(runtime, { recursive: true });
  try { await access(path.join(runtime, 'edge-vm.cjs')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await build({ stdin: { contents: "module.exports=require('@edge-runtime/vm')", resolveDir: compat },
      outfile: path.join(runtime, 'edge-vm.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
    const source = await readFile(path.resolve(compat, '../runtime/edge.mjs'), 'utf8');
    await writeFile(path.join(runtime, 'edge.mjs'), source.replace("import('@edge-runtime/vm')", "import('./edge-vm.cjs')"));
    const require = createRequire(import.meta.url);
    for (const name of ['vm', 'primitives']) {
      const directory = path.dirname(require.resolve(`@edge-runtime/${name}/package.json`));
      await writeFile(path.join(runtime, `edge-${name}.LICENSE.txt`), await readFile(path.join(directory, 'LICENSE.md')));
    }
  }
  const output = await build({ absWorkingDir: projectRoot,
    stdin: { contents: `import {NextRequest} from 'rustyx/server';export const __rustyx_createRequest=(url,init)=>new NextRequest(url,init);export * from ${JSON.stringify(file)};${defaultExport ? `export {default} from ${JSON.stringify(file)};` : ''}`, resolveDir: projectRoot, sourcefile: 'rustyx-edge-entry.mjs' },
    write: false, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', sourcemap:dev?'inline':false, conditions: [...(reactMode === 'rsc' ? ['react-server'] : []), 'edge-light', 'worker', 'browser'],
    mainFields: ['browser', 'module', 'main'], logLevel: 'silent', metafile: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...defineEnvironment, 'process.env.NEXT_RUNTIME': '"edge"' },
    plugins: [...plugins, { name: 'rustyx-edge', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (builtin.has(args.path) || args.path.startsWith('node:')) return { errors: [{ text: `Node.js module ${args.path} cannot run in the Edge Runtime (${args.importer}).` }] };
        if (reactMode && ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-server-dom-webpack/server', 'react-server-dom-webpack/server.node'].includes(args.path)) return { path: args.path, namespace: 'rustyx-edge-react' };
        if (/^(next|rustyx)\//.test(args.path)) {
          const name = args.path.slice(args.path.indexOf('/') + 1).replace(/\.js$/, '');
          if (name === 'server' || Object.hasOwn(names, name)) return { path: name, namespace: 'rustyx-edge-compat' };
          if (name === 'constants') return { path: path.join(compat, 'constants.cjs') };
          return { errors: [{ text: `Edge Runtime does not support ${args.path}.` }] };
        }
        if (args.path === 'server-only') return { path: args.path, namespace: 'rustyx-edge-empty' };
        // The React graph collects styles for the browser. Its recursive resolver
        // only locates the file; the caller replaces it with an empty/module map
        // before Edge compilation. Route handlers still reject CSS imports.
        if (reactMode && args.pluginData?.rustyxResolvingCss && /\.(?:css|scss|sass)$/i.test(args.path)) return;
        if (args.path === 'client-only' || /\.(?:node|css|scss|sass)$/.test(args.path)) return { errors: [{ text: `${args.path} cannot run in the Edge Runtime.` }] };
      });
      builder.onLoad({ filter: /.*/, namespace: 'rustyx-edge-react' }, args => {
        const exported = args.path.startsWith('react-server-dom-webpack/server') ? ['registerClientReference', 'registerServerReference'] : Object.keys(createRequire(import.meta.url)(args.path)).filter(name => name !== '__esModule' && name !== 'default');
        return { loader: 'js', contents: `const module=globalThis.__RUSTYX_EDGE_REACT[${JSON.stringify(args.path === 'react-server-dom-webpack/server.node' ? 'react-server-dom-webpack/server' : args.path)}];export default module;\n` + exported.map(name => `export const ${name}=module[${JSON.stringify(name)}];`).join('\n') };
      });
      builder.onLoad({ filter: /.*/, namespace: 'rustyx-edge-empty' }, () => ({ contents: '', loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'rustyx-edge-compat' }, args => ({ loader: 'js', resolveDir: compat, contents: args.path === 'server'
        ? `import primitives from ${JSON.stringify(path.join(compat, 'server-primitives.cjs'))};export const {NextRequest,NextResponse,NextURL}=primitives;export const connection=globalThis.__RUSTYX_EDGE_HOST.server.connection;`
        : names[args.path].map(name => `export const ${name}=globalThis.__RUSTYX_EDGE_HOST.${args.path}.${name};`).join('\n') }));
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async args => {
        let source = args.rustyxSource ?? await readFile(args.path, 'utf8');
        if (transformSource) source = await transformSource(source, args.path, builder);
        if (!trusted.has(args.path)) source = validate(source, args.path, reactMode);
        return { contents: source, loader: /\.[cm]?tsx?$/.test(args.path) ? 'tsx' : 'jsx', resolveDir: path.dirname(args.path) };
      });
    } }] });
  const mapped=extractSourceMap(output.outputFiles[0].text);
  const mapFile=output.outputFiles.find(file=>file.path===output.outputFiles[0].path+'.map');
  let sourceMap=mapped.map || (mapFile?JSON.parse(mapFile.text):undefined);
  // No outfile is supplied to the bundler: relative sources are rooted at the
  // project, not at the final server/*.edge.js factory location.
  if(sourceMap)sourceMap={...sourceMap,sourceRoot:'',sources:sourceMap.sources.map(source=>/^(?:[a-z][a-z+.-]*:|\/)/i.test(source)?source:path.resolve(projectRoot,sourceMap.sourceRoot || '',source))};
  let code = mapped.code;
  const ast = parse(code, { sourceType: 'module' }), exported = [];
  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration' || statement.type === 'ExportAllDeclaration') throw new Error('Edge bundle still contains an external import');
    if (statement.type !== 'ExportNamedDeclaration') continue;
    if (statement.declaration || statement.source) throw new Error('Unexpected Edge bundle export');
    for (const specifier of statement.specifiers) exported.push([specifier.exported.name ?? specifier.exported.value, specifier.local.name]);
  }
  // esbuild emits only final named exports. Removing them preserves top-level
  // await inside an async factory without requiring Node's experimental modules.
  for (const statement of [...ast.program.body].reverse()) if (statement.type === 'ExportNamedDeclaration') code = code.slice(0, statement.start) + code.slice(statement.start,statement.end).replace(/[^\r\n]/g,' ') + code.slice(statement.end);
  const asset = outfile.replace(/\.mjs$/, '.edge.js');
  await mkdir(path.dirname(outfile), { recursive: true });
  await writeFile(asset, inlineSourceMap(`(async()=>{\n${code}\nreturn {${exported.map(([name, local]) => `${JSON.stringify(name)}:${local}`).join(',')}};})()`,sourceMap?{...sourceMap,mappings:';'+sourceMap.mappings}:undefined));
  await writeFile(outfile, `import {readFile} from 'node:fs/promises';import {loadEdgeModule} from '../runtime/edge.mjs';const edge=await loadEdgeModule(await readFile(new URL(${JSON.stringify('./' + path.basename(asset))},import.meta.url),'utf8'),import.meta.url,${JSON.stringify(reactMode)});\n${exported.filter(([name]) => name !== '__rustyx_createRequest').map(([name], index) => `const binding${index}=edge[${JSON.stringify(name)}];export {binding${index} as ${JSON.stringify(name)}};`).join('\n')}`);
  return { exports: exported.map(([name]) => name), metafile: output.metafile };
}
