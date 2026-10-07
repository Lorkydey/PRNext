import { parse } from '@babel/parser';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkProject } from './check.mjs';
import { frameworkImportName } from './framework-imports.mjs';
import { packageManifest } from '../native/resolve.mjs';

const supported = new Set([...Object.keys(packageManifest.exports).map(name => name.slice(2)), 'font/google', 'font/local', 'next-router-context', 'next-app-router-context']);
const ignored = new Set(['node_modules', '.git', '.next', '.prnext', '.prnext-cache', 'dist', 'build', 'out', 'coverage', 'test-results', '__tests__']);
const code = /\.(?:[cm]?[jt]s|[jt]sx)$/;
function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walkAst(child, visit);
    else if (value && typeof value === 'object') walkAst(value, visit);
  }
}

/** A bounded source audit. It never runs a build, installs packages, or edits the project. */
export async function auditMigration(directory) {
  const root = path.resolve(directory);
  const preflight = await checkProject(root, { validateDependencies: false });
  const report = { version: 1, root, ok: false, status: 'checked', files: 0, routes: preflight.routes,
    versions: preflight.versions, findings: [], imports: [], notes: [
      'This source audit does not execute application routes or inspect every installed dependency. Run a production build and browser tests before switching.',
      'Configuration files are evaluated by preflight. Application sources and package files are not modified.',
    ] };
  const finding = (severity, id, file, line, message, action) => report.findings.push({ severity, id, file, line, message, action });
  for (const error of preflight.errors) finding('error', 'preflight', null, null, error, 'Fix the configuration or route convention, then run the check again.');
  let bytes = 0;
  async function scan(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(item.name) || item.name.startsWith('.prnext-')) continue;
      const filename = path.join(dir, item.name), file = path.relative(root, filename).split(path.sep).join('/');
      if (item.isSymbolicLink()) { finding('warning', 'linked-source', file, null, 'Linked source was not scanned.', 'Check the linked package during the production build.'); continue; }
      if (item.isDirectory()) { await scan(filename); continue; }
      if (!item.isFile() || !code.test(item.name) || /(?:\.d|\.test|\.spec)\.[cm]?[jt]sx?$/.test(item.name)) continue;
      if (++report.files > 5000 || (bytes += (await stat(filename)).size) > 32 * 1024 ** 2) throw new Error('Source audit exceeds 5000 files or 32 MiB. Choose the application directory.');
      const source = await readFile(filename, 'utf8');
      let ast;
      try { ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx', ...( /\.[cm]?tsx?$/.test(item.name) ? ['typescript'] : []), 'decorators-legacy'] }); }
      catch (error) { finding('warning', 'source-syntax', file, error.loc?.line || 1, 'The audit could not parse this source file.', 'Validate it with the production compiler; custom loaders may be required.'); continue; }
      const client = ast.program.directives.some(directive => directive.value.value === 'use client');
      walkAst(ast.program, node => {
        const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.importKind !== 'type' && node.exportKind !== 'type' ? node.source?.value
          : node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.name === 'require') ? node.arguments[0]?.value : undefined;
        if (typeof specifier !== 'string' || !(specifier === 'next' || specifier.startsWith('next/'))) return;
        if (node.type === 'ImportDeclaration' && node.specifiers.length && node.specifiers.every(value => value.importKind === 'type')) return;
        const name = frameworkImportName(specifier), available = supported.has(name);
        report.imports.push({ file, line: node.loc.start.line, specifier, supported: available });
        if (!available) finding('error', 'unsupported-import', file, node.loc.start.line, `No PRNext runtime adapter for ${specifier}.`, 'Replace this import with a supported public API or keep this route on Next.js.');
        else if (client && ['headers', 'cache', 'server', 'og'].includes(name)) finding('error', 'server-import-in-client', file, node.loc.start.line, `${specifier} is imported by a client module.`, 'Move the server operation into a Server Component or Server Action.');
      });
    }
  }
  try { await scan(root); }
  catch (error) { finding('error', 'scan-incomplete', null, null, error.message, 'Resolve the file access or size limit and run the check again.'); }
  let pkg = {};
  try { pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) { finding('error', 'package-json', 'package.json', null, error.message, 'Provide a valid package.json in the application directory.'); }
  const { migrateScript } = await import('./migrate.mjs');
  for (const command of ['dev', 'build', 'start']) {
    try { migrateScript(pkg.scripts?.[command], command); }
    catch (error) { finding('warning', 'custom-script', 'package.json', null, error.message, `Keep a backup of the command and adapt scripts.${command} manually.`); }
  }
  const expected = packageManifest.peerDependencies;
  for (const name of ['react', 'react-dom', ...(report.routes.some(route => route.router === 'app') ? ['react-server-dom-webpack'] : [])]) {
    if (report.versions[name] !== expected[name]) finding('warning', 'react-version', 'package.json', null, `${name}: ${report.versions[name] || 'not installed'}; PRNext expects ${expected[name]}.`, 'Review the dependency changes with prn migrate --dry-run.');
  }
  report.ok = !report.findings.some(item => item.severity === 'error');
  return report;
}

function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Comparison servers must be HTTP(S) origins without credentials, paths, or queries.');
  return url.origin;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function comparableBody(body, type) {
  if (type.includes('json')) return JSON.stringify(canonical(JSON.parse(body)));
  if (type.includes('html')) return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return body;
}
async function probe(base, route, timeout) {
  const started = performance.now();
  const response = await fetch(base + route, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  const headersMs = performance.now() - started;
  let size = 0;
  const chunks = [];
  if (response.body) for await (const chunk of response.body) {
    if ((size += chunk.length) > 2 * 1024 ** 2) throw new Error('Comparison response exceeds 2 MiB.');
    chunks.push(chunk);
  }
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const location = response.headers.get('location');
  const target = location ? new URL(location, base + route) : null;
  const bytes = Buffer.concat(chunks);
  const body = type.includes('json') || type.includes('html') || type.startsWith('text/') ? comparableBody(bytes.toString('utf8'), type) : bytes;
  return { status: response.status, type, redirect: target ? (target.origin === base ? '' : target.origin) + target.pathname + target.search + target.hash : null,
    bodySha256: createHash('sha256').update(body).digest('hex'), bytes: size, headersMs: Math.round(headersMs * 100) / 100,
    totalMs: Math.round((performance.now() - started) * 100) / 100, cacheControl: response.headers.get('cache-control') };
}
export async function compareServers({ against, candidate, routes, timeout = 10000 }) {
  const reference = origin(against), current = origin(candidate);
  if (!Array.isArray(routes) || !routes.length || routes.length > 100 || routes.some(route => typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\r\n#]/.test(route) || new URL(route, reference).origin !== reference)) throw new Error('Provide 1–100 local URL paths, including concrete values for dynamic routes.');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('Comparison timeout must be 100–60000 milliseconds.');
  const results = [];
  for (const route of [...new Set(routes)]) {
    const values = await Promise.allSettled([probe(reference, route, timeout), probe(current, route, timeout)]);
    if (values.some(value => value.status === 'rejected')) {
      results.push({ route, equal: false, error: values.map((value, index) => value.status === 'rejected' ? `${index ? 'candidate' : 'reference'}: ${value.reason.message}` : null).filter(Boolean).join('; ') });
      continue;
    }
    const [before, after] = values.map(value => value.value);
    const differences = ['status', 'type', 'redirect', 'bodySha256'].filter(key => before[key] !== after[key]);
    results.push({ route, equal: differences.length === 0, differences, reference: before, candidate: after });
  }
  return { ok: results.every(result => result.equal), reference, candidate: current, results,
    scope: 'GET status, content type, redirect target and body comparison. HTML compares text without scripts/styles; JSON ignores object key order. Headers timings are observations, not a benchmark. Browser behavior and authenticated requests require separate tests.' };
}
