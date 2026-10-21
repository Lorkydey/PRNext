import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_CONTRACT = 'build-output.json';
const fields = ['version', 'adapter', 'buildId', 'manifest', 'assets', 'server', 'fallback'];

/** The public adapter contract is separate from internal rendering metadata. */
export function validateBuildOutput(value) {
  const invalid = reason => { throw new Error(`Invalid PRNext build output: ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected an object');
  if (value.version !== 1) invalid(`unsupported version ${value.version}; expected 1`);
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) invalid('unexpected or missing fields');
  if (!['react', 'static'].includes(value.adapter)) invalid('unsupported adapter');
  if (typeof value.buildId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.buildId)) invalid('invalid buildId');
  if (value.manifest !== 'manifest.json') invalid('manifest must be manifest.json');
  if (value.adapter === 'static') {
    if (value.assets !== 'static' || value.server !== null || ![null, 'index.html'].includes(value.fallback)) invalid('invalid static entrypoints');
  } else if (value.assets !== 'assets' || value.fallback !== null || !value.server ||
    Object.keys(value.server).sort().join(',') !== 'entry,runtimeContract' ||
    value.server.entry !== 'runtime/worker.mjs' || value.server.runtimeContract !== 'runtime-contract.json') invalid('invalid React entrypoints');
  return value;
}

export async function writeBuildOutput(directory, manifest, { adapter = 'react', spa = false } = {}) {
  const value = validateBuildOutput({ version: 1, adapter, buildId: manifest.buildId,
    manifest: 'manifest.json', assets: adapter === 'static' ? 'static' : 'assets',
    server: adapter === 'static' ? null : { entry: 'runtime/worker.mjs', runtimeContract: 'runtime-contract.json' },
    fallback: spa ? 'index.html' : null });
  await writeFile(path.join(directory, OUTPUT_CONTRACT), JSON.stringify(value, null, 2) + '\n');
  return value;
}

export async function readBuildOutput(directory) {
  const file = await open(path.join(directory, OUTPUT_CONTRACT), 'r');
  try {
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error('Invalid PRNext build output: exceeds 64 KiB');
    return validateBuildOutput(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await file.close(); }
}
