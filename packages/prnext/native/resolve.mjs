import { readFileSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
export const platforms = JSON.parse(readFileSync(new URL('./platforms.json', import.meta.url), 'utf8'));
export const nativeBinaryName = (platform = process.platform) => platform === 'win32' ? 'prnext.exe' : 'prnext';

// A dependency installed in node_modules must never mistake its consumer for
// the framework checkout, even if that consumer also has a Cargo workspace.
export function sourceCheckout(root = packageRoot) {
  try {
    const repository = path.resolve(root, '../..');
    const manifest = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
    if (manifest.name !== 'prnext-monorepo' || manifest.private !== true) return null;
    if (realpathSync(root) !== realpathSync(path.join(repository, 'packages/prnext'))) return null;
    readFileSync(path.join(repository, 'crates/prnext/Cargo.toml'));
    return repository;
  } catch { return null; }
}

export function nativePlatform({ platform = process.platform, arch = process.arch, libc } = {}) {
  if (platform === 'linux' && libc === undefined) {
    libc = process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  const result = platforms.find(item => item.os === platform && item.cpu === arch && (!item.libc || item.libc === libc));
  if (!result) throw new Error(`PRNext has no prebuilt server for ${platform}/${arch}${libc ? `/${libc}` : ''}. Supported targets are Windows (MSVC), macOS and Linux glibc on arm64/x64. Use a supported system, or set PRNEXT_BINARY to your own compatible build.`);
  return result;
}

async function executableFile(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Native executable is not a file: ${file}`);
  await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  return file;
}

let compiling;
export async function resolveNativeBinary({ env = process.env, root = packageRoot, allowBuild = true, platform } = {}) {
  if (env.PRNEXT_BINARY) {
    const file = path.resolve(env.PRNEXT_BINARY);
    try { return await executableFile(file); }
    catch (cause) { throw new Error(`PRNEXT_BINARY is not an executable file: ${file}`, { cause }); }
  }
  const checkout = sourceCheckout(root);
  if (checkout) {
    const binary = path.join(checkout, 'target/release', nativeBinaryName());
    try { return await executableFile(binary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!allowBuild) throw new Error('Native server missing from this checkout. Run npm run build:native.');
    compiling ||= (async () => {
      const { cargo } = await import(pathToFileURL(path.join(checkout, 'scripts/cargo.mjs')).href);
      console.error('Compiling native PRNext server for this source checkout…');
      await new Promise((resolve, reject) => {
        const child = cargo(['build', '--release', '--locked']);
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Native build failed (${signal || code}).`)));
      });
    })().finally(() => { compiling = undefined; });
    await compiling;
    return executableFile(binary);
  }
  const target = nativePlatform(platform);
  const manifest = root === packageRoot ? packageManifest : JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const require = createRequire(path.join(root, 'package.json'));
  let nativeManifestFile;
  try { nativeManifestFile = require.resolve(`${target.package}/package.json`); }
  catch (cause) {
    throw new Error(`Missing PRNext native package ${target.package}@${manifest.version}. Reinstall with optional dependencies enabled (npm install --include=optional), or install ${target.package}@${manifest.version} explicitly. Do not copy node_modules between operating systems.`, { cause });
  }
  const native = JSON.parse(readFileSync(nativeManifestFile, 'utf8'));
  if (native.name !== target.package || native.version !== manifest.version) {
    throw new Error(`PRNext native version mismatch: expected ${target.package}@${manifest.version}, found ${native.name}@${native.version}. Reinstall matching versions.`);
  }
  const binary = path.join(path.dirname(nativeManifestFile), 'bin', nativeBinaryName(target.os));
  try { return await executableFile(binary); }
  catch (cause) { throw new Error(`PRNext native executable is missing or not executable in ${target.package}. Reinstall the package.`, { cause }); }
}
