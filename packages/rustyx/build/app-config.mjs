import { readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import {validSamples} from '../compat/instant-samples.cjs';
import { createHash } from 'node:crypto';

const parsedConfigs = new Map();
let parsedBytes = 0, parsedHits = 0, parsedMisses = 0;
export const appConfigCacheStats = () => ({ entries: parsedConfigs.size, bytes: parsedBytes, hits: parsedHits, misses: parsedMisses });

// Platform and cache modes without implemented semantics fail during scanning.
const supported = new Map([
  ['runtime', ['nodejs', 'edge']],
  ['dynamic', ['auto', 'force-dynamic', 'force-static', 'error']],
  ['revalidate', [false]],
  ['dynamicParams', [true, false]],
  ['instant', [true, false]],
  ['fetchCache', ['auto', 'default-cache', 'only-cache', 'force-cache', 'force-no-store', 'default-no-store', 'only-no-store']],
  ['preferredRegion', ['auto']],
  ['maxDuration', []],
  ['generateStaticParams', []],
  ['experimental_ppr', [false]],
]);

function literal(node) {
  while (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TypeCastExpression'].includes(node?.type)) node = node.expression;
  if (node?.type === 'NullLiteral') return null;
  if (node?.type === 'ArrayExpression') { const values = node.elements.map(literal); return values.includes(undefined) ? undefined : values; }
  if (node?.type === 'ObjectExpression') {
    const output = {};
    for (const item of node.properties) {
      if (item.type !== 'ObjectProperty' || item.computed || item.shorthand) return undefined;
      const key = item.key.name ?? item.key.value, value = literal(item.value);
      if (typeof key !== 'string' || value === undefined || key === '__proto__') return undefined;
      Object.defineProperty(output, key, { value, enumerable: true });
    }
    return output;
  }
  return ['StringLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(node?.type) ? node.value : undefined;
}

export async function validateAppConfig(file) {
  const source = await readFile(file, 'utf8');
  const digest = createHash('sha256').update(source).digest('hex');
  const hit = parsedConfigs.get(file);
  if (hit?.digest === digest) {
    parsedHits++; parsedConfigs.delete(file); parsedConfigs.set(file, hit);
    return JSON.parse(hit.json);
  }
  parsedMisses++;
  if (hit) { parsedConfigs.delete(file); parsedBytes -= hit.size; }
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file,
    plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
  const locals = new Map();
  const exports = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') for (const item of declaration.declarations) {
      if (item.id.type !== 'Identifier') continue;
      locals.set(item.id.name, literal(item.init));
      if (statement.type === 'ExportNamedDeclaration') exports.push({ name: item.id.name, local: item.id.name });
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') exports.push({ name: declaration.id.name });
    for (const item of statement.specifiers) if (item.exportKind !== 'type') exports.push({
      name: item.exported.name ?? item.exported.value, local: statement.source ? undefined : item.local?.name,
    });
  }
  const config = {};
  for (const item of exports) {
    if (!supported.has(item.name)) continue;
    const value = locals.get(item.local);
    const allowed = supported.get(item.name);
    if (item.name === 'instant') {
      if (ast.program.directives.some(directive => directive.value.value === 'use client')) throw new Error(`instant cannot be exported by a Client Component (${file}).`);
      if (value && typeof value === 'object' && Object.entries(value).every(([name, value]) => name === 'unstable_samples' ? validSamples(value) : name === 'level' ? ['warning', 'experimental-error'].includes(value) : ['unstable_disableValidation', 'unstable_disableDevValidation', 'unstable_disableBuildValidation'].includes(name) && value === true)) { config.instant = value; continue; }
    }
    if (item.name === 'generateStaticParams') {
      if (ast.program.directives.some(directive => directive.value.value === 'use client')) throw new Error(`generateStaticParams cannot be exported by a Client Component (${file}).`);
      config.generateStaticParams = true;
      continue;
    }
    if (allowed.includes(value) || (item.name === 'revalidate' && Number.isSafeInteger(value) && value >= 0)) { config[item.name] = value; continue; }
    throw new Error(`App Router export ${item.name} in ${file} is not supported with this value.${allowed.length ? ` Supported literal values: ${allowed.map(value => JSON.stringify(value)).join(', ')}${item.name === 'revalidate' ? ', or a nonnegative integer' : ''}.` : ''}`);
  }
  if (config.runtime === 'edge') {
    if (config.revalidate !== undefined || ['force-static', 'error'].includes(config.dynamic)) throw new Error(`Edge Runtime does not support static generation or ISR configuration (${file}).`);
  }
  const json = JSON.stringify(config), size = Buffer.byteLength(file) + Buffer.byteLength(json);
  if (size <= 64 * 1024) {
    while (parsedConfigs.size && (parsedConfigs.size >= 256 || parsedBytes + size > 1024 * 1024)) {
      const [key, value] = parsedConfigs.entries().next().value;
      parsedConfigs.delete(key); parsedBytes -= value.size;
    }
    parsedConfigs.set(file, {digest, json, size}); parsedBytes += size;
  }
  return config;
}

export function mergeAppConfig(configs) {
  const merged = { dynamic: 'auto', revalidate: false, dynamicParams: true, fetchCache: 'auto', forceNoStore: false };
  const policies = new Set(configs.map(config => config.fetchCache).filter(Boolean));
  if (configs.some(config => config.dynamic === 'force-dynamic')) policies.add('force-no-store');
  if (policies.has('force-cache') && policies.has('force-no-store') || policies.has('only-cache') && policies.has('only-no-store')) {
    throw new Error('Incompatible App Router fetchCache guarantees across route segments.');
  }
  let forceDynamic = false;
  for (const config of configs) {
    if (config.runtime === 'edge') merged.runtime = 'edge';
    else if (config.runtime === 'nodejs') delete merged.runtime;
    // The first explicit ancestor decides whether a blocking route is allowed.
    // A child cannot weaken a parent's requirement for an instant shell.
    if (config.instant !== undefined && merged.instant === undefined) merged.instant = config.instant;
    if (config.dynamic !== undefined) merged.dynamic = config.dynamic;
    if (config.dynamic === 'force-dynamic') forceDynamic = true;
    if (typeof config.revalidate === 'number') merged.revalidate = merged.revalidate === false ? config.revalidate : Math.min(merged.revalidate, config.revalidate);
    if (config.dynamicParams === false) merged.dynamicParams = false;
    if (config.fetchCache !== undefined) merged.fetchCache = config.fetchCache;
    if (config.fetchCache === 'force-no-store') merged.forceNoStore = true;
  }
  if (forceDynamic) merged.dynamic = 'force-dynamic';
  if (policies.has('force-cache')) merged.fetchCache = 'force-cache';
  else if (!merged.forceNoStore && !forceDynamic) {
    if (policies.has('only-cache')) merged.fetchCache = 'only-cache';
    if (policies.has('only-no-store')) merged.fetchCache = 'only-no-store';
  }
  if (forceDynamic || merged.forceNoStore) { merged.forceNoStore = true; merged.fetchCache = 'force-no-store'; }
  if (merged.dynamic === 'error' && (merged.revalidate === 0 || merged.forceNoStore)) {
    throw new Error("Incompatible App Router configuration: dynamic='error' cannot be combined with revalidate=0 or fetchCache='force-no-store'.");
  }
  if (!merged.forceNoStore) {
    let parentNoStore = false;
    for (const config of configs) {
      if (parentNoStore && (config.fetchCache === 'auto' || config.fetchCache?.endsWith('-cache'))) throw new Error("Incompatible App Router configuration: a parent fetchCache='default-no-store' cannot have a child fetchCache='auto' or '*-cache'.");
      if (config.fetchCache === 'default-no-store') parentNoStore = true;
    }
  }
  return merged;
}
