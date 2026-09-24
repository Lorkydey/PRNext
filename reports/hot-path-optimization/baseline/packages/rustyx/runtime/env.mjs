import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';

// Track only values installed here, preserving shell inputs and runtime changes.
const loadedValues = new WeakMap();

/** Scope build-time env mutations so later child servers inherit only callers' env. */
export function snapshotEnvConfig(env = process.env) {
  const snapshot = { ...env };
  const provenance = loadedValues.get(env);
  return () => {
    for (const key of Object.keys(env)) if (!Object.hasOwn(snapshot, key)) delete env[key];
    Object.assign(env, snapshot);
    if (provenance) loadedValues.set(env, provenance);
    else loadedValues.delete(env);
  };
}

export function envFileNames({ dev = false, env = process.env, mode = env.NODE_ENV === 'test' ? 'test' : dev ? 'development' : 'production' } = {}) {
  if (!['development', 'production', 'test'].includes(mode)) throw new Error('Environment file mode must be development, production or test.');
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

/** Load root env files in Next's precedence order, without logging values. */
export function loadEnvConfig(projectRoot, { dev = false, env = process.env, mode } = {}) {
  for (const [key, value] of loadedValues.get(env) || []) {
    if (env[key] === value) delete env[key];
  }
  const original = { ...env };
  const combined = { ...original };
  const parsedEnv = Object.create(null);
  const loadedEnvFiles = [];
  for (const name of envFileNames({ dev, env, mode })) {
    const filename = path.join(projectRoot, name);
    let contents;
    try {
      if (!statSync(filename).isFile()) continue;
      contents = readFileSync(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Could not load ${filename}: ${error.code || error.message}`, { cause: error });
    }
    let parsed;
    try { parsed = expand({ parsed: parse(contents), processEnv: combined }).parsed; }
    catch (error) { throw new Error(`Could not expand variables in ${filename}. Check for circular references.`, { cause: error }); }
    for (const [key, value] of Object.entries(parsed)) {
      if (!Object.hasOwn(original, key) && !Object.hasOwn(parsedEnv, key)) parsedEnv[key] = value;
    }
    loadedEnvFiles.push(name);
  }
  // Expansion uses a scratch object so caller-owned escaped dollars stay intact.
  for (const [key, value] of Object.entries(parsedEnv)) env[key] = value;
  loadedValues.set(env, new Map(Object.entries(parsedEnv)));
  return { combinedEnv: env, parsedEnv, loadedEnvFiles };
}

export function shouldWatchProjectFile(filename) {
  if (!filename) return false;
  const parts = String(filename).split(/[\\/]/);
  if (parts.length === 1 && /^\.env(?:\.(?:development|production|test))?(?:\.local)?$/.test(parts[0])) return true;
  if (parts.length === 1 && /^(?:\.postcssrc(?:\.(?:js|mjs|cjs|json))?|\.browserslistrc)$/.test(parts[0])) return true;
  return !parts.some(part => part === 'node_modules' || part === 'target' || part.startsWith('.'));
}
