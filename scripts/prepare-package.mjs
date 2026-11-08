import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packNative } from './package-native.mjs';
import { publishedNative } from './test-package.mjs';
import { executeNpm } from '../packages/prnext/native/npm.mjs';
import { packageManifest, nativePlatform } from '../packages/prnext/native/resolve.mjs';
import { repositoryRoot } from './cargo.mjs';
import { archiveDigest, archiveFilename } from './verify-npm-artifacts.mjs';
import { readPreparedArchives } from './package-prepared.mjs';

export async function preparePackage({ out, binary, published = false }) {
  if (!out || binary && published) throw new Error('Choose an output and either a binary or a published native');
  out = path.resolve(out); await mkdir(out, { recursive: true });
  const native = await (published ? publishedNative({ out }) : packNative({ out, binary }));
  await executeNpm(['pack', '--workspace', packageManifest.name, '--json', '--ignore-scripts', '--pack-destination', out], { cwd: repositoryRoot, timeout: 60000 });
  const seal = { schemaVersion: 1, version: packageManifest.version, platform: nativePlatform().id, ...(native.published ? { publishedNative: native.published } : {}), archives: [] };
  for (const name of [packageManifest.name, nativePlatform().package]) {
    const filename = archiveFilename(name);
    seal.archives.push({ name, filename, ...archiveDigest(await readFile(path.join(out, filename))) });
  }
  await writeFile(path.join(out, 'prepared.json'), JSON.stringify(seal, null, 2) + '\n', { flag: 'wx' });
  await readPreparedArchives(out);
  return seal;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === '--published-native' && !options.published) options.published = true;
      else if (['--out', '--binary'].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') && !options[flag.slice(2)]) options[flag.slice(2)] = process.argv[++i];
      else throw new Error('Invalid archive preparation arguments');
    }
    console.log(JSON.stringify(await preparePackage(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
