// Prepare an unpublished alpha without inventing native archive integrity.
// The final native archives are built and tested on each supported platform.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './cargo.mjs';

export async function setReleaseVersion(version, root = repositoryRoot) {
  if (!/^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(version || '')) throw new Error('Expected x.y.z-alpha or x.y.z-alpha.N');
  const files = ['package.json', 'packages/prnext/package.json', 'package-lock.json', 'crates/prnext/Cargo.toml', 'Cargo.lock'];
  const originals = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')));
  const [top, pkg, lock] = originals.slice(0, 3).map(JSON.parse);
  const previous = pkg.version;
  if (version === previous) throw new Error('Version is unchanged');
  if (top.version !== previous || lock.version !== previous || lock.packages['packages/prnext'].version !== previous) throw new Error('Existing npm versions differ');
  const platforms = JSON.parse(await readFile(path.join(root, 'packages/prnext/native/platforms.json'), 'utf8'));
  // Fail before writing anything if a public version would collide.
  for (const name of [pkg.name, ...platforms.map(p => p.package)]) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(15000) });
    if (response.status !== 404) throw new Error(`${name}@${version}: expected unpublished version, registry returned ${response.status}`);
  }
  const optional = Object.fromEntries(platforms.map(p => [p.package, version]));
  top.version = pkg.version = lock.version = lock.packages[''].version = lock.packages['packages/prnext'].version = version;
  pkg.optionalDependencies = lock.packages['packages/prnext'].optionalDependencies = optional;
  for (const target of platforms) {
    const key = `node_modules/${target.package}`, name = target.package.split('/').at(-1);
    // npm accepts optional archives not published yet. Keep their full lock
    // entries so npm ci can verify the dependency graph before building Rust.
    // Never retain the previous version's hash for new bytes.
    lock.packages[key] = { version, resolved: `https://registry.npmjs.org/${target.package}/-/${name}-${version}.tgz`,
      cpu: [target.cpu], optional: true, os: [target.os], ...(target.libc ? { libc: [target.libc] } : {}) };
  }
  const cargoPattern = /^(name = "prnext"\r?\nversion = ")[^"]+("\r?$)/m;
  for (const value of originals.slice(3)) if (!cargoPattern.test(value) || !value.includes(`version = "${previous}"`)) throw new Error('Cargo version does not match npm');
  const values = [top, pkg, lock].map(value => JSON.stringify(value, null, 2)+'\n');
  values.push(...originals.slice(3).map(value => value.replace(cargoPattern, `$1${version}$2`)));
  for (let i=0; i<files.length; i++) await writeFile(path.join(root, files[i]), values[i]);
  console.log(`Prepared ${version}. Native lock entries have no integrity until the real archives are published. See RELEASE.md.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await setReleaseVersion(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
