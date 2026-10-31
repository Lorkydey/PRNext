import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {isMainModule} from '../../scripts/main-module.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Snapshot a reviewed configuration before any application build or load. */
export async function prepareReleaseComparison({ configuration, output, expectedSha256, baselineSource, candidateSource, workspace }) {
  if (!path.isAbsolute(configuration || '') || !path.isAbsolute(output || '') || !path.isAbsolute(workspace || '') || !/^[a-f0-9]{64}$/.test(expectedSha256 || '') || ![baselineSource, candidateSource].every(value => /^[a-f0-9]{40}$/.test(value || ''))) throw new Error('Use absolute paths, an expected SHA-256 and two explicit 40-character source labels.');
  const file = await realpath(configuration), checkout = await realpath(workspace);
  if (within(checkout, file)) throw new Error('The prepared comparison configuration must be outside the checkout after realpath.');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The comparison configuration must be a bounded regular JSON file.');
  const bytes = await readFile(file);
  if (sha256(bytes) !== expectedSha256) throw new Error('The comparison configuration differs from its reviewed SHA-256.');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['baseline', 'candidate', 'workload', 'budgets','resourcePolicy'].includes(key))) throw new Error('Invalid comparison configuration fields.');
  for (const [variant, label] of [['baseline', baselineSource], ['candidate', candidateSource]]) {
    const target = value[variant];
    if (!target || Object.keys(target).some(key => !['directory', 'archives', 'source'].includes(key)) || target.source !== label || typeof target.directory !== 'string' || !Array.isArray(target.archives) || target.archives.length !== 2 || target.archives.some(name => typeof name !== 'string')) throw new Error('Comparison source labels or archive/application paths do not match the reviewed configuration.');
    target.directory = path.resolve(path.dirname(file), target.directory);
    target.archives = target.archives.map(name => path.resolve(path.dirname(file), name));
  }
  const snapshot = JSON.stringify(value, null, 2) + '\n';
  await mkdir(output, { recursive: false, mode: 0o700 });
  await writeFile(path.join(output, 'configuration-original.json'), bytes, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(output, 'configuration.json'), snapshot, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(output, 'preparation.json'), JSON.stringify({ version: 1, originalSha256: expectedSha256, snapshotSha256: sha256(snapshot), sourceLabels: { baseline: baselineSource, candidate: candidateSource }, sourceAssociationVerified: false, note: 'Source commits are declared labels; this step does not prove their association with the archives.' }, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  return path.join(output, 'configuration.json');
}

if (isMainModule(import.meta.url)) {
  const [configuration, output, expectedSha256, baselineSource, candidateSource, workspace] = process.argv.slice(2);
  await prepareReleaseComparison({ configuration, output, expectedSha256, baselineSource, candidateSource, workspace });
}
