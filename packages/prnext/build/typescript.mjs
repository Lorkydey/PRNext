import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);

export function validateTypeScript(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('typescript must be an object');
  for (const key of Object.keys(input)) if (!['ignoreBuildErrors', 'tsconfigPath', 'devChecks'].includes(key)) throw new TypeError(`typescript.${key} is not supported`);
  const { ignoreBuildErrors = false, tsconfigPath = 'tsconfig.json' } = input;
  if (typeof ignoreBuildErrors !== 'boolean') throw new TypeError('typescript.ignoreBuildErrors must be a boolean');
  if (typeof tsconfigPath !== 'string' || !tsconfigPath || tsconfigPath.includes('\0') || Buffer.byteLength(tsconfigPath) > 4096) throw new TypeError('typescript.tsconfigPath must be a nonempty filesystem path of at most 4096 bytes');
  if(input.devChecks!==undefined&&typeof input.devChecks!=='boolean')throw new TypeError('typescript.devChecks must be a boolean');
  return { ignoreBuildErrors, tsconfigPath, ...(input.devChecks===undefined?{}:{devChecks:input.devChecks}) };
}

export async function projectTsconfig(root, config) {
  const name = config.typescript?.tsconfigPath ?? 'tsconfig.json';
  const filename = path.resolve(root, name);
  try {
    if (!(await stat(filename)).isFile()) throw new Error(`TypeScript configuration is not a file: ${filename}`);
    return filename;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (name !== 'tsconfig.json') throw new Error(`typescript.tsconfigPath does not exist: ${filename}`, { cause: error });
    return undefined;
  }
}

/** Run the checker outside the build/dev process so its graph is released on exit.
 * Never emit files, rewrite the user's config, or install packages implicitly. */
export async function checkTypeScript(root, config, { dev = false, tsconfig, force = false } = {}) {
  if (!force && (dev || !config.typescript || config.typescript.ignoreBuildErrors)) return;
  tsconfig ??= await projectTsconfig(root, config);
  if (!tsconfig) throw new Error('TypeScript checking was explicitly enabled, but tsconfig.json does not exist. Create a TypeScript configuration, set typescript.tsconfigPath to an existing configuration, or explicitly set typescript.ignoreBuildErrors: true if types are checked separately.');
  let compiler;
  try { compiler = createRequire(path.join(root, 'package.json')).resolve('typescript'); }
  catch (error) { throw new Error('TypeScript checking requires typescript in the project. Install it as a dev dependency, or explicitly set typescript.ignoreBuildErrors: true if a separate process checks types.', { cause: error }); }
  try {
    await execute(process.execPath, [fileURLToPath(new URL('./typescript-check.mjs', import.meta.url)), compiler, tsconfig], {
      cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`TypeScript check failed (${path.relative(root, tsconfig)}):\n${error.stdout || error.stderr || error.message}`, { cause: error });
  }
}
