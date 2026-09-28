import { withLocale } from '../compat/locale.cjs';
import {frameworkImportName, frameworkImportPattern} from './framework-imports.mjs';
import { moduleResolutionPlugin } from './module-resolution.mjs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import { build as bundle } from './compiler.mjs';
import { compileRouteMatcher } from './custom-routes.mjs';
import { createNativePackages } from './native-packages.mjs';
import { compileEdge } from './edge.mjs';

const extensions = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'];
const loaders = { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx', '.ts': 'ts', '.tsx': 'tsx' };
const compatibility = new Map([['server', 'server'], ['headers', 'headers'], ['cache', 'cache'], ['navigation', 'navigation-server'], ['constants', 'constants']]);
const forbiddenConfig = new Set(['preferredRegion', 'maxDuration', 'dynamic', 'dynamicParams', 'revalidate', 'fetchCache']);
const MAX_MATCHERS = 1000;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_VISITS = 300_000;

function fail(file, message) { throw new Error(`Invalid middleware/proxy ${file}: ${message}`); }
function unwrap(node) {
  while (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TypeCastExpression', 'ParenthesizedExpression'].includes(node?.type)) node = node.expression;
  return node;
}
function keyOf(property) {
  return !property.computed && (property.key?.type === 'Identifier' ? property.key.name : property.key?.value);
}
function member(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression' || node.optional) return;
  const owner = member(node.object);
  const name = node.computed ? node.property.type === 'StringLiteral' && node.property.value : node.property.name;
  return owner && typeof name === 'string' ? `${owner}.${name}` : undefined;
}

function configBudget(file) {
  let visits = 0, bytes = 0;
  return {
    visit() { if (++visits > MAX_CONFIG_VISITS) fail(file, 'configuration constant expansion exceeds the evaluation budget'); },
    bytes(length) { if ((bytes += length) > MAX_CONFIG_BYTES) fail(file, 'configuration constant expansion exceeds 2 MiB'); },
    string(value) {
      // Reject a large literal before JSON escaping can allocate another copy.
      if (Buffer.byteLength(value) > MAX_CONFIG_BYTES - bytes) fail(file, 'configuration constant expansion exceeds 2 MiB');
      this.bytes(Buffer.byteLength(JSON.stringify(value)));
    },
  };
}

function literal(node, locals, file, seen = new Set(), depth = 0, budget = configBudget(file)) {
  budget.visit();
  if (depth > 32) fail(file, 'configuration nesting exceeds 32 levels');
  node = unwrap(node);
  if (!node) { budget.bytes(4); return undefined; }
  if (node.type === 'StringLiteral') { budget.string(node.value); return node.value; }
  if (['NumericLiteral', 'BooleanLiteral'].includes(node.type)) { budget.bytes(String(node.value).length); return node.value; }
  if (node.type === 'NullLiteral') { budget.bytes(4); return null; }
  if (node.type === 'TemplateLiteral' && !node.expressions.length) {
    budget.string(node.quasis[0].value.cooked);
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') { budget.bytes(4); return undefined; }
    if (!locals.has(node.name) || seen.has(node.name)) fail(file, `configuration must be statically analyzable; cannot resolve ${node.name}`);
    return literal(locals.get(node.name), locals, file, new Set([...seen, node.name]), depth + 1, budget);
  }
  if (node.type === 'ArrayExpression') {
    if (node.elements.length > MAX_MATCHERS) fail(file, `configuration arrays may contain at most ${MAX_MATCHERS} items`);
    budget.bytes(2 + Math.max(0, node.elements.length - 1));
    return node.elements.map(item => {
      if (!item || item.type === 'SpreadElement') fail(file, 'configuration arrays cannot contain holes or spreads');
      return literal(item, locals, file, seen, depth + 1, budget);
    });
  }
  if (node.type === 'ObjectExpression') {
    budget.bytes(2 + Math.max(0, node.properties.length - 1));
    const result = {};
    for (const property of node.properties) {
      const key = keyOf(property);
      if (property.type !== 'ObjectProperty' || typeof key !== 'string') fail(file, 'configuration requires literal object properties without spreads or computed keys');
      if (Object.hasOwn(result, key)) fail(file, `duplicate configuration field ${key}`);
      budget.string(key); budget.bytes(1);
      Object.defineProperty(result, key, { value: literal(property.value, locals, file, seen, depth + 1, budget), enumerable: true });
    }
    return result;
  }
  fail(file, 'configuration must be statically analyzable literals, not executable expressions');
}

function collectExports(ast, file) {
  const locals = new Map();
  const exported = new Map();
  let commonjs = false;
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') for (const item of declaration.declarations) {
      if (item.id.type !== 'Identifier') continue;
      if (declaration.kind === 'const') locals.set(item.id.name, item.init);
      if (statement.type === 'ExportNamedDeclaration') exported.set(item.id.name, item.init);
    }
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(declaration?.type) && declaration.id) {
      locals.set(declaration.id.name, declaration);
      if (statement.type === 'ExportNamedDeclaration') exported.set(declaration.id.name, declaration);
    }
    if (statement.type === 'ExportDefaultDeclaration') exported.set('default', statement.declaration);
    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') for (const specifier of statement.specifiers) {
      if (specifier.exportKind === 'type') continue;
      const name = specifier.exported.name ?? specifier.exported.value;
      if (statement.source && (name === 'config' || name === 'runtime')) fail(file, `${name} must be declared in this file, not re-exported`);
      exported.set(name, statement.source ? null : specifier.local);
    }
    if (statement.type === 'ExportAllDeclaration') fail(file, 'wildcard exports cannot define middleware or its static configuration; use explicit exports');
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression' || statement.expression.operator !== '=') continue;
    const assignment = statement.expression;
    const target = member(assignment.left);
    if (!target || !(target === 'module.exports' || /^(?:module\.exports|exports)\.[^.]+$/.test(target))) continue;
    commonjs = true;
    if (target === 'module.exports') {
      const value = unwrap(assignment.right);
      if (value.type === 'ObjectExpression') {
        for (const property of value.properties) {
          const key = keyOf(property);
          if (typeof key !== 'string' || !['ObjectProperty', 'ObjectMethod'].includes(property.type)) fail(file, 'CommonJS middleware exports require explicit named properties');
          exported.set(key, property.type === 'ObjectMethod' ? property : property.value);
        }
      } else exported.set('default', value);
    } else exported.set(target.split('.').at(-1), assignment.right);
  }
  return { locals, exported, commonjs };
}

export async function inspectMiddleware(file, convention = path.basename(file).split('.')[0], { basePath = '', i18n } = {}) {
  const ast = parse(await readFile(file, 'utf8'), { sourceType: 'unambiguous', sourceFilename: file,
    plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
  if (ast.program.directives.some(directive => ['use client', 'use server'].includes(directive.value.value))) fail(file, 'React Client Components and Server Actions cannot define middleware');
  const { locals, exported, commonjs } = collectExports(ast, file);
  for (const name of forbiddenConfig) if (exported.has(name)) fail(file, `route segment option ${name} is unsupported here`);
  const raw = exported.has('config') ? literal(exported.get('config'), locals, file) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'config must be a literal object');
  const unknown = Object.keys(raw).filter(key => !['matcher', 'runtime'].includes(key));
  if (unknown.length) fail(file, `unsupported config fields: ${unknown.join(', ')}`);
  const declaredRuntime = exported.has('runtime') ? literal(exported.get('runtime'), locals, file) : raw.runtime;
  if (convention === 'proxy' && (exported.has('runtime') || raw.runtime !== undefined)) fail(file, 'proxy always uses Node.js and cannot configure runtime');
  if ([declaredRuntime, raw.runtime].some(value => value !== undefined && !['nodejs', 'edge', 'experimental-edge'].includes(value))) fail(file, 'runtime must be nodejs, edge or experimental-edge');
  const exportName = exported.has(convention) ? convention : exported.has('default') ? 'default' : undefined;
  if (!exportName) fail(file, `export a default function or a named ${convention} function`);
  let handler = unwrap(exported.get(exportName));
  const seen = new Set();
  while (handler?.type === 'Identifier' && locals.has(handler.name) && !seen.has(handler.name)) {
    seen.add(handler.name); handler = unwrap(locals.get(handler.name));
  }
  if (handler && ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'ObjectExpression', 'ArrayExpression', 'ClassDeclaration', 'ClassExpression'].includes(handler.type)) fail(file, `${exportName} must be a function`);
  const matchers = raw.matcher === undefined ? ['/:path*'] : typeof raw.matcher === 'string' ? [raw.matcher] : raw.matcher;
  if (!Array.isArray(matchers) || matchers.length > MAX_MATCHERS) fail(file, `matcher must be a string or at most ${MAX_MATCHERS} matcher entries`);
  const localized = i18n ? matchers.flatMap(input => {const value = typeof input === 'string' ? {source: input} : input; return value.locale === false ? [value] : i18n.locales.map(locale=>({...value,source:withLocale(value.source,locale,i18n.defaultLocale)}));}) : matchers;
  if (localized.length > MAX_MATCHERS) fail(file, `localized matchers exceed ${MAX_MATCHERS} entries`);
  const compiled = localized.map((matcher, index) => compileRouteMatcher(matcher, `${file}.config.matcher[${index}]`, { basePath }));
  if (Buffer.byteLength(JSON.stringify(compiled)) > MAX_CONFIG_BYTES) fail(file, 'compiled matchers exceed 2 MiB');
  return { file, convention, exportName, commonjs, runtime: declaredRuntime === 'edge' || declaredRuntime === 'experimental-edge' ? 'edge' : 'nodejs',
    ...(declaredRuntime !== undefined ? { declaredRuntime } : {}), matchers: compiled };
}

export async function scanMiddleware(root, { basePath = '', pageExtensions = extensions, i18n } = {}) {
  const candidates = [];
  for (const directory of ['', 'src']) for (const convention of ['middleware', 'proxy']) for (const extension of pageExtensions) {
    const file = path.join(root, directory, `${convention}.${extension}`);
    try { await access(file); candidates.push({ file, convention }); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  if (candidates.length > 1) throw new Error(`Conflicting middleware/proxy files: ${candidates.map(item => path.relative(root, item.file)).join(', ')}. Keep exactly one middleware or proxy entry.`);
  return candidates.length ? inspectMiddleware(candidates[0].file, candidates[0].convention, { basePath, i18n }) : undefined;
}

/** Build request interception independently of either React router graph. */
export async function compileMiddleware({ project, stage, manifest, dev, defineEnvironment = {}, moduleResolution = {} }) {
  const descriptor = project.middleware;
  if (!descriptor) return;
  if (descriptor.runtime === 'edge') {
    await compileEdge({ file: descriptor.file, outfile: path.join(stage, 'server/middleware.mjs'), projectRoot: project.root,
      dev, defineEnvironment, plugins: [moduleResolutionPlugin(moduleResolution, project.root)], defaultExport: descriptor.exportName === 'default' });
    manifest.middleware = { module: 'server/middleware.mjs', exportName: descriptor.exportName, convention: descriptor.convention,
      runtime: 'edge', declaredRuntime: descriptor.declaredRuntime, matchers: descriptor.matchers };
    return;
  }
  const entry = path.join(stage, '.entries', 'middleware.mjs');
  const selected = descriptor.exportName;
  const statement = descriptor.commonjs
    ? `import module from ${JSON.stringify(descriptor.file)};\n${selected === 'default' ? "export default typeof module==='function'?module:module.default;" : `export const ${selected}=module[${JSON.stringify(selected)}];`}`
    : `export {${selected}} from ${JSON.stringify(descriptor.file)};`;
  await writeFile(entry, statement);
  const native = createNativePackages(project.root, { isClientSource: () => false });
  const compatibilityPlugin = {
    name: 'prnext-middleware-compatibility',
    setup(esbuild) {
      esbuild.onResolve({ filter: frameworkImportPattern }, args => {
        const name = frameworkImportName(args.path);
        const compatible = compatibility.get(name);
        return compatible ? { path: `../compat/${compatible}.cjs`, external: true }
          : { errors: [{ text: `Unsupported middleware import ${args.path}; use next/server, next/headers, next/cache, next/navigation or next/constants.` }] };
      });
      esbuild.onResolve({ filter: /^(?:server-only|client-only)$/ }, args => args.path === 'server-only'
        ? { path: args.path, namespace: 'prnext-middleware-empty' }
        : { errors: [{ text: 'client-only modules cannot run in middleware/proxy.' }] });
      esbuild.onResolve({ filter: /\.css$/ }, () => ({ errors: [{ text: 'Middleware/proxy cannot import stylesheet assets.' }] }));
      esbuild.onLoad({ filter: /.*/, namespace: 'prnext-middleware-empty' }, () => ({ contents: '', loader: 'js' }));
      esbuild.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?)$/, namespace: 'file' }, async args => {
        const contents = args.prnextSource ?? await readFile(args.path, 'utf8');
        if (/['"]use (?:client|server)['"]/.test(contents)) {
          const ast = parse(contents, { sourceType: 'unambiguous', plugins: ['jsx', ...(/\.tsx?$/.test(args.path) ? ['typescript'] : [])] });
          if (ast.program.directives.some(directive => ['use client', 'use server'].includes(directive.value.value))) fail(args.path, 'React Client Components and Server Actions cannot run in middleware');
        }
        return { contents, loader: loaders[path.extname(args.path)] || 'jsx', resolveDir: path.dirname(args.path) };
      });
    },
  };
  let output;
  for (;;) {
    const version = native.version;
    try {
      output = await bundle({ absWorkingDir: project.root, entryPoints: [entry], outfile: path.join(stage, 'server/middleware.mjs'),
        bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', conditions: ['node'], jsx: 'automatic',
        sourcemap: dev, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...defineEnvironment },
        banner: { js: "import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);" },
        plugins: [moduleResolutionPlugin(moduleResolution, project.root), compatibilityPlugin, native.plugin('middleware')],
      });
      if (version === native.version) break;
    } catch (error) { if (version === native.version) throw error; }
  }
  for (const file of output.outputFiles) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents); }
  manifest.middleware = { module: 'server/middleware.mjs', exportName: selected, convention: descriptor.convention,
    runtime: 'nodejs', ...(descriptor.declaredRuntime !== undefined ? { declaredRuntime: descriptor.declaredRuntime } : {}), matchers: descriptor.matchers };
}
