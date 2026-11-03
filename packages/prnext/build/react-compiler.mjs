import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedAsyncTransform } from './transform-cache.mjs';
import { extractSourceMap, inlineSourceMap, sourceMapsEnabled } from './source-maps.mjs';
import { compilerEvent, recordReactCompilerTransform, reactCompilerGraphTarget } from './react-compiler-report.mjs';

const require = createRequire(import.meta.url);
// Only metadata is loaded here. Disabled builds do not load Babel or the compiler.
export const REACT_COMPILER_VERSION = require('babel-plugin-react-compiler/package.json').version;
export const OXC_REACT_COMPILER_VERSION = require('oxc-transform-react/package.json').version;
const BABEL_VERSION = require('@babel/core/package.json').version;
const frameworkRoot = fileURLToPath(new URL('../', import.meta.url));
const options = new Set(['backend', 'compilationMode', 'panicThreshold', 'target']);
let implementation, oxcImplementation;
const REPORT_CACHE_VERSION = 2;
const optOutDirective = directives => directives?.map(item => item.value.value).find(value => value === 'use no memo' || value === 'use no forget') || false;

function functionLocations(ast) {
  const functions = [], stack = [{ node: ast.program, parent: null }];
  while (stack.length && functions.length < 4096) {
    const { node, parent } = stack.pop();
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') continue;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) && node.loc) {
      const name = node.id?.name || (parent?.type === 'VariableDeclarator' ? parent.id?.name : null)
        || (parent?.type === 'ObjectProperty' ? parent.key?.name : null);
      functions.push({ name: name || null, start: { line: node.loc.start.line, column: node.loc.start.column },
        end: { line: node.loc.end.line, column: node.loc.end.column },
        optOut: optOutDirective(node.body?.directives) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'leadingComments', 'innerComments', 'trailingComments', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) stack.push({ node: child, parent: node });
      else if (value && typeof value === 'object') stack.push({ node: value, parent: node });
    }
  }
  return functions;
}

/** Deliberately expose only supported, serializable compiler options. */
export function normalizeReactCompilerConfig(value) {
  if (value === undefined || value === false) return false;
  const input = value === true ? {} : value;
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('reactCompiler must be false, true or an options object.');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!options.has(key)) throw new TypeError(`reactCompiler.${String(key)} is not supported by PRNext.`);
  }
  const compilationMode = input.compilationMode === undefined ? 'infer' : input.compilationMode;
  const backend = input.backend === undefined ? 'babel' : input.backend;
  const panicThreshold = input.panicThreshold === undefined ? 'none' : input.panicThreshold;
  const target = input.target === undefined ? '19' : input.target;
  if (!['infer', 'annotation'].includes(compilationMode)) throw new TypeError('reactCompiler.compilationMode must be infer or annotation.');
  if (!['none', 'critical_errors', 'all_errors'].includes(panicThreshold)) throw new TypeError('reactCompiler.panicThreshold must be none, critical_errors or all_errors.');
  if (target !== '19') throw new TypeError("reactCompiler.target must be '19'; PRNext requires React 19.");
  if (!['babel', 'oxc'].includes(backend)) throw new TypeError('reactCompiler.backend must be babel or oxc.');
  return Object.freeze({ ...(backend === 'oxc' ? { backend } : {}), compilationMode, panicThreshold, target });
}

export const reactCompilerVersion = config => config?.backend === 'oxc' ? OXC_REACT_COMPILER_VERSION : REACT_COMPILER_VERSION;

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function excluded(root, filename) {
  if (!inside(root, filename)) return true;
  const relative = path.relative(root, filename).split(path.sep);
  return relative.some(part => /^(?:node_modules|\.git|\.next|\.contentlayer|\.prnext|\.prnext-cache|\.prnext-dev|\.prnext-types|out|dist)$/.test(part)
    || part.startsWith('.prnext-build-') || part.startsWith('.prnext-incremental-'));
}

function loadImplementation() {
  implementation ??= Promise.all([import('@babel/core'), import('babel-plugin-react-compiler')]).then(([babel, plugin]) => ({
    babel, compiler: plugin.default?.default ?? plugin.default,
  }));
  return implementation;
}

function loadOxcImplementation() {
  oxcImplementation ??= Promise.all([import('oxc-transform-react'), import('oxc-parser')]).then(([compiler, parser]) => {
    if (compiler.__napiBindingTarget !== 'native') throw new Error('reactCompiler.backend="oxc" requires the native platform binding. Install optional dependencies or select backend:"babel".');
    return { transform: compiler.transform, parse: parser.parseSync };
  });
  return oxcImplementation;
}

/** Compose only source-map coordinates; application strings never enter this path. */
async function composeOxcMap(output, input) {
  if (!input || !output) return output;
  const { TraceMap, decodedMappings, originalPositionFor, sourceContentFor, encodedMap } = await import('@jridgewell/trace-mapping');
  const previous = new TraceMap(input), current = new TraceMap(output);
  const sources = [], contents = [], names = [];
  const mappings = decodedMappings(current).map(line => line.map(segment => {
    if (segment.length < 4) return [segment[0]];
    const position = originalPositionFor(previous, { line: segment[2] + 1, column: segment[3] });
    if (position.source === null || position.line === null || position.column === null) return [segment[0]];
    let source = sources.indexOf(position.source);
    if (source < 0) { source = sources.length; sources.push(position.source); contents.push(sourceContentFor(previous, position.source)); }
    const mapped = [segment[0], source, position.line - 1, position.column];
    const name = position.name || (segment.length > 4 ? current.names[segment[4]] : null);
    if (name) { let index = names.indexOf(name); if (index < 0) { index = names.length; names.push(name); } mapped.push(index); }
    return mapped;
  }));
  return encodedMap(new TraceMap({ version: 3, sources, sourcesContent: contents, names, mappings }));
}

async function transformOxc(source, filename, normalized, { mapped, outputMode, loaderOutput, root }) {
  const { transform, parse } = await loadOxcImplementation();
  const { code, map } = extractSourceMap(source);
  const lang = /\.tsx$/i.test(filename) ? 'tsx' : /\.[cm]?ts$/i.test(filename) ? 'ts' : 'jsx';
  // The native transform does not expose directives. Inspect its original input
  // with the existing Rust parser, never Babel, before entering executable modules.
  const parsed = parse(filename, code, { lang, sourceType: 'unambiguous' });
  const directives = [];
  if (!parsed.errors.length) for (const statement of parsed.program.body) {
    if (!statement.directive) break;
    directives.push(statement.directive);
  }
  if (directives.includes('use server')) return { code: source, events: [], notes: ['Server Action module excluded.'] };
  const result = await transform(filename, code, { lang, sourceType: 'unambiguous', jsx: 'preserve', sourcemap: mapped,
    reactCompiler: { compilationMode: normalized.compilationMode, panicThreshold: normalized.panicThreshold,
      target: normalized.target, outputMode, reportDiagnostics: true, sources: [''] } });
  const diagnostics = result.errors.slice(0, 16).map(error => compilerEvent({
    kind: result.fatal ? 'CompileError' : 'CompileDiagnostic', reason: error.message, detail: { category: 'Oxc' },
  }, [], { root })).filter(Boolean);
  const notes = ['Experimental Oxc backend; upstream does not expose per-function optimization events. Function optimization totals are unavailable.',
    `Oxc output mode: ${outputMode}. TypeScript syntax is removed; JSX is preserved for the graph compiler.`];
  if (normalized.compilationMode === 'annotation') notes.push('Annotation mode only selects functions with "use memo".');
  if (loaderOutput) notes.push('Locations refer to JavaScript produced by the configured loader.');
  return { code: result.fatal ? source : mapped ? inlineSourceMap(result.code, await composeOxcMap(result.map, map)) : result.code,
    events: [], diagnostics, notes, fatal: result.fatal, truncated: result.errors.length > 16 };
}

/**
 * Compile application source before JSX lowering and React Refresh. The Oxc
 * development path instruments original JSX first, before native hoisting.
 * JSX remains available to the graph compiler; Oxc also removes TypeScript.
 * No application Babel configuration is loaded.
 */
export function createReactCompilerTransform(projectRoot, config, { dev = false } = {}) {
  const normalized = normalizeReactCompilerConfig(config);
  if (!normalized) return async source => source;
  const root = path.resolve(projectRoot);
  const canonicalRoot = realpath(root).catch(error => {
    if (error.code === 'ENOENT') return root;
    throw error;
  });
  const canonicalFramework = realpath(frameworkRoot).catch(() => frameworkRoot);
  return async (source, filename, { loaderOutput = false } = {}) => {
    filename = path.resolve(filename);
    if ((!loaderOutput && !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filename)) || /\.d\.[cm]?ts$/i.test(filename)) return source;
    const actualRoot = await canonicalRoot;
    if (excluded(root, filename) && excluded(actualRoot, filename)) return source;
    // Bundlers canonicalize linked project roots. Also resolve linked source
    // files so a project symlink cannot pull dependencies/framework/generated
    // files into the application compiler accidentally.
    const actualFile = await realpath(filename).catch(error => {
      if (error.code === 'ENOENT') return inside(root, filename) ? path.resolve(actualRoot, path.relative(root, filename)) : filename;
      throw error;
    });
    if (excluded(actualRoot, actualFile) || inside(await canonicalFramework, actualFile)) return source;
    const backend = normalized.backend || 'babel';
    const graph = reactCompilerGraphTarget();
    const outputMode = graph === 'node' || graph === 'edge' ? 'ssr' : 'client';
    let cacheHit = true;
    const serialized = await cachedAsyncTransform('react-compiler-report', source,
      [REPORT_CACHE_VERSION, backend, reactCompilerVersion(normalized), backend === 'babel' ? BABEL_VERSION : null,
        normalized, root, actualRoot, filename, actualFile, !!dev, !!loaderOutput, backend === 'oxc' ? outputMode : null], async () => {
        cacheHit = false;
        if (backend === 'oxc') return JSON.stringify(await transformOxc(source, filename, normalized, { mapped: sourceMapsEnabled(), outputMode, loaderOutput, root }));
        const { babel, compiler } = await loadImplementation();
        const mapped = sourceMapsEnabled();
        const { code, map } = extractSourceMap(source);
        const syntax = { filename, babelrc: false, configFile: false, sourceType: 'unambiguous',
          parserOpts: { plugins: ['jsx', ...(/\.(?:[cm]?ts|tsx)$/i.test(filename) ? ['typescript'] : [])] } };
        const ast = await babel.parseAsync(code, syntax);
        // Server Action files are executable server modules, not render graphs.
        if (ast.program.directives.some(item => item.value.value === 'use server')) return JSON.stringify({ code: source, events: [], notes: ['Server Action module excluded.'] });
        const functions = functionLocations(ast), events = [], notes = [];
        const moduleOptOut = optOutDirective(ast.program.directives);
        if (moduleOptOut) notes.push(`Module uses "${moduleOptOut}"; compiled functions are not emitted.`);
        if (normalized.compilationMode === 'annotation') notes.push('Annotation mode only selects functions with "use memo". Unselected functions have no compiler events.');
        if (loaderOutput) notes.push('Locations refer to JavaScript produced by the configured loader.');
        let truncated = false;
        const logger = { logEvent(_filename, event) {
          const value = compilerEvent(event, functions, { moduleOptOut, root });
          if (value) { if (events.length < 256) events.push(value); else truncated = true; }
        } };
        const result = await babel.transformFromAstAsync(ast, code, { ...syntax, cloneInputAst: false,
          sourceMaps: mapped, sourceFileName: filename, inputSourceMap: mapped ? map ?? false : false,
          // Boundary checks above use real path segments. Avoid the plugin's
          // default substring test rejecting e.g. /my-node_modules-example/.
          plugins: [[compiler, { ...normalized, sources: null, logger }]],
        });
        return JSON.stringify({ code: mapped ? inlineSourceMap(result.code, result.map) : result.code, events, notes, truncated });
      });
    const payload = JSON.parse(serialized);
    recordReactCompilerTransform(inside(root, filename) ? filename : path.resolve(root, path.relative(actualRoot, actualFile)), payload, { cacheHit });
    if (payload.fatal) throw new Error(`React Compiler (oxc ${OXC_REACT_COMPILER_VERSION}) failed for ${filename}: ${payload.diagnostics.map(value => value.reason).join('; ') || 'Native compilation failed.'}`);
    return payload.code;
  };
}
