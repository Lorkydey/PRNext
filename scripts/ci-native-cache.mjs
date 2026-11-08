import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './cargo.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyPattern = /^native-v1-[a-f0-9]{64}$/;
const executable = process.platform === 'win32' ? 'prnext.exe' : 'prnext';
function compilerIdentity() {
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 16384, windowsHide: true };
  const rust = execFileSync('rustc', ['-vV'], options), tools = {};
  for (const [name, args] of [['nasm', ['-v']], [process.platform === 'win32' ? 'cl' : 'cc', process.platform === 'win32' ? [] : ['--version']], ['pkg-config', ['--version']]]) {
    try { tools[name] = execFileSync(name, args, options).slice(0, 4096); }
    catch (error) { tools[name] = String(error.stdout || '') + String(error.stderr || '') || 'unavailable'; tools[name] = tools[name].slice(0, 4096); }
  }
  return JSON.stringify({ rust, tools });
}
export async function nativeFingerprint({ root = repositoryRoot, compiler, environment = process.env } = {}) {
  assert.ok(typeof compiler === 'string' && compiler.length > 0 && compiler.length < 16384);
  const files = new Map();
  async function add(relative) {
    const absolute = path.resolve(root, relative), local = path.relative(root, absolute);
    assert.ok(local && !local.startsWith('..') && !path.isAbsolute(local), 'Native input escapes repository');
    if (files.has(local)) return;
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 ** 2, 'Native input must be a bounded regular file');
    const bytes = await readFile(absolute); files.set(local, hash(bytes));
    if (local.endsWith('.rs')) {
      const source = bytes.toString('utf8');
      const literals = [...source.matchAll(/include(?:_str|_bytes)?!\(\s*"([^"\\]+)"\s*\)/g)];
      assert.equal(literals.length, [...source.matchAll(/include(?:_str|_bytes)?!\(/g)].length, 'Unsupported native include; build without binary reuse');
      for (const [, filename] of literals) await add(path.relative(root, path.resolve(path.dirname(absolute), filename)));
    }
  }
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (['target', '.git'].includes(entry.name)) continue;
      assert.ok(!entry.isSymbolicLink(), 'Native input links are not reusable');
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name); else await add(name);
    }
  }
  for (const name of ['Cargo.toml', 'Cargo.lock', 'scripts/cargo.mjs', 'scripts/ci-native-cache.mjs', '.github/workflows/ci-platform.yml', '.github/workflows/npm-platform.yml']) await add(name);
  await visit('crates');
  try { await visit('.cargo'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(typeof packageJson.scripts?.['build:native'] === 'string', 'Native build command is missing');
  const invocation = packageJson.scripts['build:native'];
  const relevant = Object.fromEntries(Object.entries(environment).filter(([name]) => /^(?:RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|MACOSX_DEPLOYMENT_TARGET|CC|CXX|CFLAGS|CXXFLAGS|CPPFLAGS|AR|SOURCE_DATE_EPOCH|ImageOS|ImageVersion|CARGO_BUILD_TARGET|CARGO_TARGET_.+|CARGO_PROFILE_RELEASE_.+)$/.test(name)).sort(([a], [b]) => a.localeCompare(b)));
  assert.ok(!/(?:target-cpu(?:=|\s+)native|m(?:arch|tune)=native)/.test(Object.values(relevant).join(' ')), 'Host-specific flags require a source build without binary reuse');
  const inputs = [...files].map(([name, digest]) => [name.split(path.sep).join('/'), digest]).sort(([a], [b]) => a.localeCompare(b));
  return { key: 'native-v1-' + hash(JSON.stringify({ platform: process.platform, arch: process.arch, compiler, invocation, environment: relevant, inputs })), files: inputs.length };
}

export async function sealNative({ directory, binary, key }) {
  assert.match(key, keyPattern); await mkdir(directory, { recursive: true });
  const info = await lstat(binary); assert.ok(info.isFile() && !info.isSymbolicLink());
  const bytes = await readFile(binary); assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024 ** 2);
  const destination = path.join(directory, executable);
  if (path.resolve(binary) !== path.resolve(destination)) await copyFile(binary, destination);
  const receipt = { schemaVersion: 1, key, executable, bytes: bytes.length, sha256: hash(bytes) };
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt) + '\n');
  return receipt;
}

export async function verifyNative({ directory, key }) {
  assert.match(key, keyPattern);
  try {
    const receiptFile = path.join(directory, 'receipt.json'), info = await lstat(receiptFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return false;
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.key !== key || receipt.executable !== executable) return false;
    const binary = path.join(directory, executable), binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || binaryInfo.size <= 0 || binaryInfo.size > 256 * 1024 ** 2 || binaryInfo.size !== receipt.bytes) return false;
    return hash(await readFile(binary)) === receipt.sha256;
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2), options = { directory: path.join(repositoryRoot, 'artifacts/ci-native-cache'), binary: path.join(repositoryRoot, 'target/release', executable) };
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]; assert.ok(['--directory', '--binary', '--key'].includes(flag) && !seen.has(flag) && args[i + 1] && !args[i + 1].startsWith('--'), 'Invalid native cache arguments');
      seen.add(flag); options[flag.slice(2)] = args[i + 1];
    }
    let result;
    if (mode === 'key') {
      try { result = { ...await nativeFingerprint({ compiler: compilerIdentity() }), cacheable: true }; }
      catch (error) { console.error('Native binary reuse disabled: ' + String(error.message).slice(0, 512)); result = { key: '', cacheable: false, files: 0 }; }
    } else if (mode === 'seal') {
      const current = await nativeFingerprint({ compiler: compilerIdentity() });
      assert.equal(current.key, options.key, 'Native inputs changed during compilation');
      result = await sealNative(options);
    }
    else if (mode === 'restore') {
      result = { valid: await verifyNative(options) };
      if (result.valid) { await mkdir(path.dirname(options.binary), { recursive: true }); await copyFile(path.join(options.directory, executable), options.binary); }
    } else throw new Error('Expected native cache key, seal or restore');
    if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries(result)) if (['key', 'valid', 'cacheable'].includes(name)) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
