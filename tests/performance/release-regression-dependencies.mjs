import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const names = ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler'];
const digest = value => createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export const runtimeDependencyScope = 'Installed bytes of the project React trio and scheduler resolved from react-dom; other build and transitive dependencies are not certified.';

/** Resolve manifests and read installed bytes without evaluating dependency code. */
export async function verifyRuntimeDependencies(directory) {
  const project = await realpath(directory), resolve = createRequire(path.join(project, 'package.json'));
  const manifests = names.slice(0, 3).map(name => resolve.resolve(`${name}/package.json`));
  manifests.push(createRequire(manifests[1]).resolve('scheduler/package.json'));
  const packages = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index], manifest = await realpath(manifests[index]), root = path.dirname(manifest);
    if (!within(project, root)) throw new Error('Runtime dependencies must be independently installed inside the comparison application.');
    const metadata = JSON.parse(await readFile(manifest, 'utf8'));
    if (metadata.name !== name || typeof metadata.version !== 'string' || !metadata.version) throw new Error('Invalid runtime dependency manifest.');
    const entries = [];
    let bytes = 0, directories = 0;
    async function visit(folder, prefix = '', depth = 0) {
      if (++directories > 4096 || depth > 32) throw new Error('Runtime dependency inventory exceeds its bounded directory budget.');
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        // Nested dependencies have their own identity. In particular scheduler
        // is resolved from react-dom, so a nested copy cannot shadow its proof.
        if (!prefix && entry.name === 'node_modules') continue;
        const file = path.join(folder, entry.name), relative = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error('Runtime dependency files must not be linked.');
        if (entry.isDirectory()) { await visit(file, relative + '/', depth + 1); continue; }
        const stat = await lstat(file);
        if (!stat.isFile() || !within(root, await realpath(file))) throw new Error('Invalid runtime dependency file.');
        if (entries.length >= 4096 || bytes + stat.size > 64 * 1024 ** 2) throw new Error('Runtime dependency inventory exceeds its bounded file or byte budget.');
        const contents = await readFile(file);
        if (contents.length !== stat.size) throw new Error('Runtime dependency changed during inventory.');
        bytes += contents.length;
        entries.push([relative, contents.length, digest(contents)]);
      }
    }
    await visit(root);
    packages.push({ name, version: metadata.version, sha256: digest(JSON.stringify(entries)), files: entries.length, bytes });
  }
  return { version: 1, scope: runtimeDependencyScope, packages, sha256: digest(JSON.stringify(packages)) };
}

export function validateRuntimeDependencies(value) {
  if (!value || value.version !== 1 || value.scope !== runtimeDependencyScope || !Array.isArray(value.packages) || value.packages.length !== names.length || value.packages.some((entry, index) => !entry || entry.name !== names[index] || typeof entry.version !== 'string' || !entry.version || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isInteger(entry.files) || entry.files < 1 || entry.files > 4096 || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 64 * 1024 ** 2) || value.sha256 !== digest(JSON.stringify(value.packages))) throw new Error('Exact installed React and scheduler dependency identities are required.');
}

export function assertMatchingRuntimeDependencies(baseline, candidate) {
  validateRuntimeDependencies(baseline); validateRuntimeDependencies(candidate);
  if (baseline.sha256 !== candidate.sha256) throw new Error('Comparison applications have different installed React or scheduler dependency bytes.');
}
