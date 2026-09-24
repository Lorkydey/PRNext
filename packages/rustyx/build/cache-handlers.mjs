import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

export function validateCacheHandler(input) {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input || input.includes('\0') || Buffer.byteLength(input) > 4096) throw new TypeError('cacheHandler must be a module path');
  return input;
}

export async function prepareCacheHandler(options) {
  if (!options.config.cacheHandler) return undefined;
  const handlers = await prepareCacheHandlers({ ...options, config: { cacheHandlers: { __legacy: options.config.cacheHandler } } });
  return handlers.__legacy;
}

export function validateCacheHandlers(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('cacheHandlers must be an object of module paths');
  if (Object.keys(input).length > 16) throw new TypeError('cacheHandlers accepts at most 16 handlers');
  const result = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || ['private', '__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError(`Invalid cache handler name: ${name}`);
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 4096) throw new TypeError(`cacheHandlers.${name} must be a module path`);
    result[name] = value;
  }
  return result;
}

/** Private server entries travel with the build; no handler code is sent to browsers. */
export async function prepareCacheHandlers({ config, projectRoot, stage, environment = {} }) {
  const result = {};
  const compiled = new Map();
  const require = createRequire(path.join(projectRoot, 'package.json'));
  for (const [name, source] of Object.entries(config.cacheHandlers || {})) {
    let entry;
    try { entry = require.resolve(source.startsWith('.') || path.isAbsolute(source) ? path.resolve(projectRoot, source) : source); }
    catch (error) { throw new Error(`Cannot resolve cacheHandlers.${name}: ${source}`, { cause: error }); }
    if (compiled.has(entry)) { result[name] = compiled.get(entry); continue; }
    const output = `server/cache-handler-${name}.mjs`;
    await build({ absWorkingDir: projectRoot, entryPoints: [entry], outfile: path.join(stage, output), bundle: true,
      platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'silent', define: environment,
      banner: { js: "import {createRequire as __rustyxCreateRequire} from 'node:module';const require=__rustyxCreateRequire(import.meta.url);" },
      plugins: [{ name: 'cache-handler-compatibility', setup(builder) {
        builder.onResolve({ filter: /^(?:next|rustyx)\/(cache|headers|server)(?:\.js)?$/ }, ({ path: specifier }) => ({ path: `../compat/${specifier.split('/')[1].replace(/\.js$/, '')}.cjs`, external: true }));
      } }],
    });
    result[name] = output;
    compiled.set(entry, output);
  }
  return result;
}
