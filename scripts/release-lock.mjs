// Run only after publishing all six real native packages. Read-only on npm.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from './cargo.mjs';
import { platforms, packageManifest } from '../packages/prnext/native/resolve.mjs';
import { verifyPublishedNatives } from '../packages/prnext/release/verify.mjs';

try {
  await verifyPublishedNatives();
  const file = path.join(repositoryRoot, 'package-lock.json');
  const lock = JSON.parse(await readFile(file, 'utf8'));
  for (const target of platforms) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(target.package)}/${packageManifest.version}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Registry failed for ${target.package}`);
    const value = await response.json();
    const entry = lock.packages[`node_modules/${target.package}`];
    if (entry?.version !== packageManifest.version || value.version !== packageManifest.version || !/^sha512-/.test(value.dist?.integrity || '') || new URL(value.dist.tarball).origin !== 'https://registry.npmjs.org') throw new Error(`Invalid native metadata: ${target.package}`);
    entry.resolved = value.dist.tarball; entry.integrity = value.dist.integrity;
  }
  await writeFile(file, JSON.stringify(lock, null, 2)+'\n');
  console.log('Native lock entries now use published archive URLs and integrity. Run npm ci and release:check.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
