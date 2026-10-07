import { mkdir, readFile, writeFile, copyFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativePlatform, nativeBinaryName, packageManifest, platforms, resolveNativeBinary } from '../packages/prnext/native/resolve.mjs';
import { executeNpm } from '../packages/prnext/native/npm.mjs';
import { verifyPackage } from '../packages/prnext/release/verify.mjs';
import { repositoryRoot, cargo } from './cargo.mjs';

const execute = promisify(execFile);
export async function packNative({ binary, out = path.join(repositoryRoot, 'artifacts/npm'), id = nativePlatform().id } = {}) {
  await verifyPackage();
  const target = platforms.find(item => item.id === id);
  if (!target) throw new Error(`Unknown native target ${id}`);
  if (target.id !== nativePlatform().id) throw new Error('Package and test the binary on its target OS/architecture; cross-labelled releases are refused.');
  if (!binary) {
    await new Promise((resolve, reject) => {
      const child = cargo(['build', '--release', '--locked']);
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native build failed: ${code}`)));
    });
    binary = await resolveNativeBinary({ env: {}, allowBuild: false });
  }
  binary = path.resolve(binary);
  const { stdout } = await execute(binary, ['--version'], { timeout: 15000 });
  if (stdout.trim() !== `prnext ${packageManifest.version}`) throw new Error(`Native version does not match npm: ${stdout.trim()}`);
  const folder = await mkdtemp(path.join(tmpdir(), 'prnext-native-package-'));
  const executable = `bin/${nativeBinaryName(target.os)}`;
  try {
    await mkdir(path.join(folder, 'bin'));
    await copyFile(binary, path.join(folder, executable));
    if (target.os !== 'win32') await chmod(path.join(folder, executable), 0o755);
    await copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(folder, 'LICENSE'));
    const manifest = {
      name: target.package, version: packageManifest.version,
      description: `PRNext experimental alpha native server (${target.id})`,
      os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}),
      files: [executable, 'native.json', 'LICENSE'],
      homepage: packageManifest.homepage,
      repository: { type: packageManifest.repository.type, url: packageManifest.repository.url },
      bugs: packageManifest.bugs,
      author: packageManifest.author,
      keywords: packageManifest.keywords,
      ...(packageManifest.license ? { license: packageManifest.license } : {}),
      publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' }
    };
    await writeFile(path.join(folder, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(folder, 'native.json'), JSON.stringify({ ...target, version: manifest.version, sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }, null, 2) + '\n');
    await writeFile(path.join(folder, 'README.md'), `# ${target.package}\n\nNative server for ${packageManifest.name}@${manifest.version}. Installed automatically by PRNext on ${target.id}.\n\nExperimental alpha: for testing, not production. Node.js 22+ is required for dynamic applications.\n`);
    await mkdir(out, { recursive: true });
    const result = await executeNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', path.resolve(out)], { cwd: folder, timeout: 60000 });
    const packed = JSON.parse(result.stdout)[0];
    return { ...packed, tarball: path.join(path.resolve(out), packed.filename), target: target.id };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = { '--binary': 'binary', '--out': 'out', '--target': 'id' }[process.argv[i]];
      if (!key || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('Usage: node scripts/package-native.mjs [--binary file] [--out directory] [--target id]');
      options[key] = process.argv[i + 1];
    }
    const result = await packNative(options);
    console.log(JSON.stringify({ file: result.tarball, integrity: result.integrity, bytes: result.size, target: result.target }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
