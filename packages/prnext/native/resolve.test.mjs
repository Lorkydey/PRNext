import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { nativePlatform, nativeBinaryName, resolveNativeBinary, sourceCheckout, packageManifest, platforms } from './resolve.mjs';
import { verifyPackage, verifyPublishedNatives } from '../release/verify.mjs';

async function fixture(t, platform = { platform: 'darwin', arch: 'arm64' }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-installed-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'node_modules', packageManifest.name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: packageManifest.name, version: packageManifest.version }));
  const options = { root, env: {}, platform };
  async function native(version = packageManifest.version) {
    const folder = path.join(directory, 'node_modules', nativePlatform(platform).package);
    await mkdir(path.join(folder, 'bin'), { recursive: true });
    await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: nativePlatform(platform).package, version }));
    const file = path.join(folder, 'bin', nativeBinaryName(platform.platform));
    await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return file;
  }
  return { directory, root, options, native };
}

test('native target selection distinguishes architectures and refuses incompatible libc', () => {
  assert.equal(nativePlatform({ platform: 'linux', arch: 'x64', libc: 'glibc' }).package, 'prnext-linux-x64-gnu');
  assert.equal(nativePlatform({ platform: 'linux', arch: 'arm64', libc: 'glibc' }).package, 'prnext-linux-arm64-gnu');
  assert.equal(nativePlatform({ platform: 'darwin', arch: 'x64' }).package, 'prnext-darwin-x64');
  for (const settings of [{ platform: 'linux', arch: 'x64', libc: 'musl' }, { platform: 'win32', arch: 'ia32' }, { platform: 'linux', arch: 'ia32', libc: 'glibc' }]) assert.throws(() => nativePlatform(settings), /no prebuilt server/);
});

test('installed native is resolved beside the package without a repository or compiler', async t => {
  const f = await fixture(t);
  assert.equal(sourceCheckout(f.root), null);
  const file = await f.native();
  assert.equal(await realpath(await resolveNativeBinary(f.options)), await realpath(file));
});

test('missing optional dependency has recovery instructions and never runs cargo', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveNativeBinary(f.options), /prnext-darwin-arm64.*optional dependencies/);
  // Even a Rust consumer with the same root package name is not a checkout.
  await mkdir(path.join(f.directory, 'crates/prnext'), { recursive: true });
  await writeFile(path.join(f.directory, 'crates/prnext/Cargo.toml'), '[package]');
  await writeFile(path.join(f.directory, 'package.json'), '{"name":"prnext-monorepo","private":true}');
  assert.equal(sourceCheckout(f.root), null);
});

test('native version mismatch is rejected before startup', async t => {
  const f = await fixture(t);
  await f.native('0.0.0-alpha.0');
  await assert.rejects(resolveNativeBinary(f.options), /version mismatch/);
});

test('explicit native override is validated and never silently falls back', async t => {
  const f = await fixture(t);
  const file = await f.native();
  assert.equal(await resolveNativeBinary({ ...f.options, env: { PRNEXT_BINARY: file }, platform: { platform: 'unsupported' } }), file);
  await assert.rejects(resolveNativeBinary({ ...f.options, env: { PRNEXT_BINARY: path.join(f.directory, 'missing') } }), /PRNEXT_BINARY is not an executable/);
  await assert.rejects(resolveNativeBinary({ ...f.options, env: { PRNEXT_BINARY: f.directory } }), /PRNEXT_BINARY is not an executable/);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(resolveNativeBinary(f.options), /not executable/);
  }
});

test('release checks validate exports and refuse missing or mismatched native publications', async () => {
  await verifyPackage();
  await assert.rejects(verifyPublishedNatives({ fetcher: async () => ({ ok: false, status: 404 }) }), /Publish the native packages first/);
  const metadata = target => ({ name: target.package, version: packageManifest.version, os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}), dist: { integrity: 'sha512-example', tarball: 'https://registry.npmjs.org/example.tgz' } });
  const fetcher = async url => ({ ok: true, json: async () => metadata(platforms.find(target => url.pathname.startsWith(`/${target.package}/`))) });
  await verifyPublishedNatives({ fetcher });
  await assert.rejects(verifyPublishedNatives({ fetcher: async url => ({ ok: true, json: async () => ({ ...await (await fetcher(url)).json(), version: '0.0.0' }) }) }), /metadata does not match/);
});

for (const arch of ['x64', 'arm64']) test(`Windows ${arch} resolves the packaged .exe without compiling`, async t => {
  const f = await fixture(t, { platform: 'win32', arch });
  assert.equal(nativePlatform(f.options.platform).package, `prnext-win32-${arch}-msvc`);
  const file = await f.native();
  assert.ok(file.endsWith('prnext.exe'));
  assert.equal(await realpath(await resolveNativeBinary(f.options)), await realpath(file));
  await rm(file);
  await assert.rejects(resolveNativeBinary(f.options), /native executable is missing/);
});
