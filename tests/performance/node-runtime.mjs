import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const execute = promisify(execFile);
export function validateNodeRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'executable,sha256,version' || !path.isAbsolute(value.executable || '') || !/^v\d+\.\d+\.\d+$/.test(value.version || '') || !/^[a-f0-9]{64}$/.test(value.sha256 || '')) throw new Error('Use an absolute Node executable, exact version and SHA-256.');
  return value;
}
export function validateRuntimeComparisonArtifacts(artifacts) {
  const present = ['baseline', 'candidate'].map(name => artifacts?.[name]?.nodeRuntime !== undefined);
  if (!present.some(Boolean)) return false;
  if (!present.every(Boolean)) throw new Error('Declare the server Node runtime for both variants or neither.');
  for (const name of ['baseline', 'candidate']) validateNodeRuntime(artifacts[name].nodeRuntime);
  const a = artifacts.baseline, b = artifacts.candidate;
  if (a.source?.declaredCommit !== b.source?.declaredCommit || a.binarySha256 !== b.binarySha256 || JSON.stringify(a.archives) !== JSON.stringify(b.archives)) throw new Error('A Node runtime comparison requires identical source, native and framework archives.');
  if (!/^[a-f0-9]{64}$/.test(a.nodeDependencyGraphSha256 || '') || a.nodeDependencyGraphSha256 !== b.nodeDependencyGraphSha256) throw new Error('Node comparison dependency lock graphs differ or are unverified.');
  return true;
}
export function nodeDependencyGraph(lock, directory, archives) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('An installed v3 dependency lock graph is required.');
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const local = value => {
    const file = path.resolve(directory, value.slice(5));
    const archive = archives.find(value => path.resolve(value.file) === file);
    if (!archive || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error('Unbound local dependency in the comparison lock graph.');
    return `archive-sha256:${archive.sha256}`;
  };
  const packages = {};
  for (const [name, original] of Object.entries(lock.packages)) {
    const entry = structuredClone(original);
    if (!name) {
      delete entry.name;
      for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [dependency, spec] of Object.entries(entry[kind] || {})) {
        if (typeof spec === 'string' && spec.startsWith('file:')) entry[kind][dependency] = local(spec);
      }
    }
    if (entry.resolved?.startsWith('file:')) entry.resolved = local(entry.resolved);
    packages[name] = entry;
  }
  if (!Object.keys(packages).some(Boolean)) throw new Error('Empty comparison dependency graph.');
  return createHash('sha256').update(JSON.stringify(stable(packages))).digest('hex');
}
export function validateSampleNodeRuntime(artifacts, variant, sample) {
  if (JSON.stringify(artifacts[variant].nodeRuntime) !== JSON.stringify(sample.serverNodeRuntime)) throw new Error('Sample Node runtime does not match the verified variant.');
}
export async function verifyNodeRuntime(value, { run = execute } = {}) {
  validateNodeRuntime(value);
  const file = await realpath(value.executable), info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 256 * 1024 ** 2) throw new Error('Node executable exceeds its file budget.');
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== value.sha256) throw new Error('Node executable SHA-256 changed.');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = await run(file, ['--version'], { env, timeout: 10000, maxBuffer: 4096, windowsHide: true });
  if (result.stdout.trim() !== value.version) throw new Error('Node executable version differs from its declaration.');
  return { executable: file, version: value.version, sha256: value.sha256 };
}
