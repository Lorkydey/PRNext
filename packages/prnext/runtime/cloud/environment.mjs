import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';

export const productionEnvFiles = ['.env.production.local', '.env.local', '.env.production', '.env'];
export async function detectEnvFiles(directory) {
  const files = [];
  for (const name of productionEnvFiles) {
    try { await lstat(path.join(directory, name)); files.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}
export async function readDeploymentEnv(directory, files) {
  const values = Object.create(null), combined = Object.create(null);
  let bytes = 0;
  for (const name of productionEnvFiles.filter(name => files.includes(name))) {
    const filename = path.join(directory, name), before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536 || (bytes += before.size) > 65536)
      throw new Error('Environment files must be regular files, up to 64 KiB in total.');
    const handle = await open(filename, 'r');
    let contents;
    try {
      const info = await handle.stat();
      if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size || (await lstat(filename)).isSymbolicLink())
        throw new Error('Environment file changed while reading. Try again.');
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        const {bytesRead} = await handle.read(data,offset,data.length-offset,offset);
        if (!bytesRead) throw new Error('Environment file changed while reading. Try again.');
        offset += bytesRead;
      }
      contents = data.toString('utf8');
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Environment file changed while reading. Try again.');
    } finally { await handle.close(); }
    let parsed;
    // No shell environment: never import machine credentials through expansion.
    try { parsed = expand({ parsed: parse(contents), processEnv: combined }).parsed; }
    catch { throw new Error('Could not expand environment variables. Check for circular references.'); }
    for (const [key, value] of Object.entries(parsed)) if (!Object.hasOwn(values, key)) values[key] = value;
  }
  if (Object.keys(values).length > 64 || Buffer.byteLength(JSON.stringify({ variables: values })) > 60000)
    throw new Error('Environment import exceeds 64 variables or 60 KiB.');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_][A-Z0-9_]{0,95}$/.test(key) || /^(CLOUD_|DOCKER_|PRNEXT_CACHE_|PRNEXT_BINARY$|PATH$|HOME$|NODE_OPTIONS$|NODE_PATH$|NODE_ENV$|PORT$|HOSTNAME$)/.test(key))
      throw new Error(`Environment variable ${key.replace(/[^A-Za-z0-9_]/g, '')} is reserved or invalid. Remove it before importing.`);
    if (value.length > 8192 || value.includes('\0')) throw new Error('An environment value exceeds 8192 characters or contains a null byte.');
  }
  return values;
}
export async function confirmEnvImport(message, { signal } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes|o|oui)$/i.test((await prompt.question(message + ' [y/N] ', { signal })).trim()); }
  finally { prompt.close(); }
}
