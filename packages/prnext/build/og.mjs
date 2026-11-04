import { cp, mkdir, readdir, lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { analyzeSource } from './source-analysis.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const unsafeBuiltins = /^(?:node:)?(?:vm|worker_threads|child_process)$/;
const react = /^(?:react|react-dom|react-server-dom-webpack)(?:\/|$)/;
const maxFiles = 4096, maxBytes = 64 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024;

/** Certification examines the actual emitted server graph, never source-text
 * matches. An unknown loader/dependency is an inclusion, not an omission. The
 * installed framework modules are a fixed boundary; application graph roots,
 * middleware, instrumentation, cache handlers and client SSR are all inspected. */
export async function imageResponseRequirement(stage, {dev = false, manifest = {}} = {}) {
  const included = reason => ({included: true, reason});
  if (dev) return included('development');
  if (manifest.middleware?.runtime === 'edge' || manifest.routes?.some(route => route.handlerConfig?.runtime === 'edge' || route.cacheConfig?.runtime === 'edge')) return included('edge-runtime');
  stage = path.resolve(stage);
  const pending = [], seen = new Set();
  let bytes = 0;
  try {
    for (const name of ['server', 'app-ssr', 'app-ssr-edge']) {
      const directory = path.join(stage, name);
      let entries;
      try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return included('unverified-output'); entries = await readdir(directory, {withFileTypes: true}); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (entries.some(entry => !entry.isFile())) return included('unverified-output');
      for (const entry of entries) if (/\.(?:[cm]?js)$/.test(entry.name)) pending.push(path.join(directory, entry.name));
    }
    for (const entry of [manifest.middleware?.module, manifest.config?.cacheHandler, ...Object.values(manifest.config?.cacheHandlers || {})]) if (entry) pending.push(path.resolve(stage, entry));
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      if (!inside(stage, file) || seen.size >= maxFiles) return included('unverified-output');
      seen.add(file);
      // An actual application import of the compatibility layer or loader is
      // sufficient evidence, even if the ImageResponse binding is only dynamic.
      if (file === path.join(stage, 'compat/og.cjs') || file === path.join(stage, 'runtime/og-loader.mjs') || inside(path.join(stage, 'runtime/og'), file)) return included('image-response-import');
      const relative = path.relative(stage, file);
      const frameworkFile = relative.startsWith('compat' + path.sep) || relative.startsWith('runtime' + path.sep);
      if (frameworkFile) {
        // Only exact installed files are trusted. Configured output overrides
        // and missing/unknown framework modules retain the complete renderer.
        const known = path.join(packageRoot, relative), [a, b] = await Promise.all([lstat(file), lstat(known)]);
        if (!a.isFile() || a.isSymbolicLink() || !b.isFile() || b.isSymbolicLink() || a.size !== b.size) return included('unverified-framework');
        const [actual, expected] = await Promise.all([readBounded(file, maxFileBytes), readBounded(known, maxFileBytes)]);
        if (!actual.equals(expected)) return included('unverified-framework');
        continue;
      }
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes || (bytes += info.size) > maxBytes) return included('unverified-output');
      const source = await readBounded(file, maxFileBytes), analysis = analyzeSource(source.toString(), file);
      if (hasUnknownLoading(analysis.program)) return included('dynamic-loader');
      for (const dependency of analysis.imports) {
        const specifier = dependency.path;
        if (typeof specifier !== 'string' || specifier.includes('\0') || unsafeBuiltins.test(specifier)) return included('unverified-dependency');
        if (builtins.has(specifier) || react.test(specifier)) continue;
        if (/^(?:next|prnext|@thomas\.f\/prnext)\/og(?:\.js)?$/.test(specifier)) return included('image-response-import');
        if (!specifier.startsWith('.')) return included('external-dependency');
        const target = path.resolve(path.dirname(file), specifier);
        // JSON/data imports cannot load executable OG code. Other extensions
        // and extensionless resolution are deliberately not guessed.
        if (target.endsWith('.json')) {
          if (!inside(stage, target) || !(await lstat(target)).isFile()) return included('unverified-dependency');
          continue;
        }
        if (!/\.(?:[cm]?js)$/.test(target)) return included('unverified-dependency');
        pending.push(target);
      }
    }
    return {included: false, reason: 'certified-unused', files: seen.size, bytes};
  } catch { return included('unverified-output'); }
}

async function readBounded(filename, limit) {
  const file = await open(filename, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw Error('ImageResponse graph exceeds its file budget');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) { const next = await file.read(buffer, length, buffer.length - length, null); if (!next.bytesRead) break; length += next.bytesRead; }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('ImageResponse graph changed during certification');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

function hasUnknownLoading(program) {
  const factories = new Set(program.body.filter(node => node.type === 'ImportDeclaration' && ['module', 'node:module'].includes(node.source?.value)).flatMap(node => node.specifiers.filter(item => item.type === 'ImportSpecifier' && item.imported?.name === 'createRequire').map(item => item.local.name)));
  const stack = [[program, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (node.type === 'Identifier' && (['eval', 'Function', 'Reflect'].includes(node.name) || /webpack_require/.test(node.name))) return true;
    if (node.type === 'MemberExpression' && (node.property?.name ?? node.property?.value) === 'constructor') return true;
    if (node.type === 'ImportExpression' && typeof node.source?.value !== 'string') return true;
    if ((node.type === 'NewExpression' || node.type === 'CallExpression') && (node.callee?.name === 'eval' || node.callee?.name === 'Function' || ['eval', 'Function', 'constructor', 'runInContext', 'runInNewContext', 'compileFunction', 'dlopen', 'getBuiltinModule'].includes(node.callee?.property?.name ?? node.callee?.property?.value))) return true;
    if (node.type === 'CallExpression' && factories.has(node.callee?.name) && (parent?.type !== 'VariableDeclarator' || parent.id?.name !== 'require')) return true;
    if (node.type === 'ImportDeclaration' && ['module', 'node:module'].includes(node.source?.value) && node.specifiers.some(item => item.type !== 'ImportSpecifier' || item.imported?.name !== 'createRequire')) return true;
    if (node.type === 'Identifier' && /^_*require\d*$/.test(node.name)) {
      const binding = parent?.type === 'VariableDeclarator' && parent.id === node && parent.init?.type === 'CallExpression' && factories.has(parent.init.callee?.name);
      const call = node.name === 'require' && parent?.type === 'CallExpression' && parent.callee === node;
      if (!binding && (!call || parent.arguments.length !== 1 || typeof parent.arguments[0]?.value !== 'string')) return true;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && ['require', '_load', 'createRequire'].includes(node.callee.property?.name)) return true;
    if (node.type === 'Identifier' && factories.has(node.name)) {
      const specifier = parent?.type === 'ImportSpecifier';
      const call = parent?.type === 'CallExpression' && parent.callee === node && parent.arguments.length === 1 && parent.arguments[0]?.type === 'MemberExpression' && parent.arguments[0].object?.type === 'MetaProperty' && parent.arguments[0].property?.name === 'url';
      if (!specifier && !call) return true;
    }
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && factories.has(node.init.callee?.name) && node.id?.name !== 'require') return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const item of value) if (item?.type) stack.push([item, node]); }
      else if (value?.type) stack.push([value, node]);
    }
  }
  return false;
}

export async function prepareImageResponse(stage) {
  const target = path.join(stage, 'runtime/og');
  await mkdir(target, { recursive: true });
  await cp(fileURLToPath(new URL('../runtime/og/', import.meta.url)), target, { recursive: true });
}
