import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packageRoot, packageManifest, platforms, sourceCheckout } from '../native/resolve.mjs';
import { verifyAiDocumentation } from './ai-docs.mjs';

export async function verifyPackage() {
  const pkg = packageManifest;
  if (pkg.private === true) throw new Error(`${pkg.name} is marked private.`);
  if (!/^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(pkg.version)) throw new Error('This release workflow requires an explicit x.y.z-alpha or x.y.z-alpha.N version.');
  if (pkg.publishConfig?.tag !== 'alpha' || pkg.publishConfig?.access !== 'public') throw new Error('Alpha releases require publishConfig.tag=alpha and access=public.');
  if (pkg.bin?.prn !== './cli.mjs' || pkg.bin?.prnext !== './cli.mjs') throw new Error('Both prn and prnext must point to cli.mjs.');
  const expected = Object.fromEntries(platforms.map(item => [item.package, pkg.version]));
  if (JSON.stringify(Object.entries(pkg.optionalDependencies || {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('All native optional dependencies must match the framework version and platform manifest exactly.');
  for (const [name, value] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (/^(?:file:|link:|portal:|workspace:|\.|\/)/.test(value)) throw new Error(`Local dependency cannot be published: ${name}=${value}`);
  }
  const rsc = pkg.peerDependencies['react-server-dom-webpack'];
  if (pkg.peerDependencies.react !== rsc || pkg.peerDependencies['react-dom'] !== rsc) throw new Error('React, React DOM and the RSC runtime must have the same exact version.');
  // Repository advisories may precede npm audit's database. Do not publish the
  // known-vulnerable RSC line even if all three peers have matching versions.
  const reactVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(rsc)?.slice(1).map(Number);
  if (!reactVersion || reactVersion[0] < 19 || (reactVersion[0] === 19 && (reactVersion[1] < 3 || (reactVersion[1] === 3 && reactVersion[2] < 1)))) throw new Error('React Server Components must include the October 14, 2026 fixes (19.3.1 or later).');
  async function exported(value) {
    if (typeof value === 'string') { await access(path.join(packageRoot, value)); return; }
    for (const target of Object.values(value)) await exported(target);
  }
  await exported(pkg.exports);
  await verifyAiDocumentation(packageRoot, pkg);
  await access(path.join(packageRoot, 'runtime/profiles.json'));
  for (const name of ['index.node.mjs', 'resvg.wasm', 'hb.wasm', 'Geist-Regular.ttf', 'LICENSE', 'LICENSE.fflate', 'LICENSE.Geist', 'LICENSE.harfbuzzjs', 'LICENSE.satori', 'NOTICE.txt']) await access(path.join(packageRoot, 'runtime/og', name));
  if (pkg.dependencies['@vercel/og'] || (await readFile(path.join(packageRoot, 'runtime/og/index.node.mjs'), 'utf8')).includes('fflate@0.7.3')) throw new Error('OG renderer still depends on vulnerable upstream fflate. Run scripts/prepare-og.mjs.');
  const source = sourceCheckout();
  if (source) {
    const cargo = await readFile(path.join(source, 'crates/prnext/Cargo.toml'), 'utf8');
    if (!cargo.includes(`version = "${pkg.version}"`)) throw new Error('Cargo and npm versions differ. Update crates/prnext/Cargo.toml and Cargo.lock before building release binaries.');
    const top = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'), 'utf8'));
    const cargoLock = (await readFile(path.join(source, 'Cargo.lock'), 'utf8')).replaceAll('\r\n', '\n');
    if ([top.version, lock.version, lock.packages[''].version, lock.packages['packages/prnext'].version].some(version => version !== pkg.version) ||
        !cargoLock.includes(`name = "prnext"\nversion = "${pkg.version}"`)) throw new Error('Workspace and lockfile versions differ; run scripts/release-version.mjs before building.');
    for (const target of platforms) {
      const native = lock.packages[`node_modules/${target.package}`];
      if (native?.version !== pkg.version || native.optional !== true || lock.packages['packages/prnext'].optionalDependencies[target.package] !== pkg.version) throw new Error(`Missing or stale native lock entry: ${target.package}`);
    }
  }
}

export async function verifyPublishedNatives({ registry = 'https://registry.npmjs.org/', fetcher = fetch } = {}) {
  // A successful npm install may silently omit a failed optional dependency.
  // Do not release the JS wrapper until every advertised native is available.
  const problems = [];
  for (const target of platforms) {
    try {
      const url = new URL(`${encodeURIComponent(target.package)}/${encodeURIComponent(packageManifest.version)}`, registry);
      const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
      const pkg = await response.json();
      if (pkg.name !== target.package || pkg.version !== packageManifest.version || !pkg.dist?.integrity || !pkg.dist?.tarball ||
          JSON.stringify(pkg.os) !== JSON.stringify([target.os]) || JSON.stringify(pkg.cpu) !== JSON.stringify([target.cpu]) ||
          (target.libc && JSON.stringify(pkg.libc) !== JSON.stringify([target.libc]))) throw new Error('published metadata does not match the release');
    } catch (error) { problems.push(`${target.package}@${packageManifest.version}: ${error.message}`); }
  }
  if (problems.length) throw new Error(`Publish the native packages first, then publish ${packageManifest.name}:\n${problems.join('\n')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyPackage();
    if (!process.argv.includes('--local')) {
      if (process.env.npm_config_tag && process.env.npm_config_tag !== 'alpha') throw new Error('Publish this prerelease with --tag alpha.');
      await verifyPublishedNatives();
    }
    console.log('PRNext release checks passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
