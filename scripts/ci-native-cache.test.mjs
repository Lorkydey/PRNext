import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeFingerprint, sealNative, verifyNative } from './ci-native-cache.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-native-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const put = async (name, value) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  for (const name of ['Cargo.toml', 'Cargo.lock', 'scripts/cargo.mjs', 'scripts/ci-native-cache.mjs', '.github/workflows/ci-platform.yml', '.github/workflows/npm-platform.yml']) await put(name, name);
  await put('crates/app/main.rs', 'const DATA: &str = include_str!("../../data.json");');
  await put('package.json', JSON.stringify({ scripts: { 'build:native': 'node scripts/cargo.mjs build --release' } }));
  await put('data.json', '{"workers":2}');
  return { root, put, fingerprint: (environment = {}) => nativeFingerprint({ root, compiler: 'rustc exact fixture', environment }) };
}

test('native identity reuses only identical compilation inputs, including embedded data and flags', async t => {
  const f = await fixture(t), first = await f.fingerprint();
  assert.deepEqual(await f.fingerprint({ NPM_TOKEN: 'never-part-of-native-identity' }), first);
  await f.put('packages/runtime/unrelated.mjs', 'new JavaScript'); assert.deepEqual(await f.fingerprint(), first);
  for (const name of ['data.json', 'Cargo.lock', 'crates/app/main.rs', 'scripts/cargo.mjs']) {
    const original = await readFile(path.join(f.root, name)); await f.put(name, original + '\n');
    assert.notEqual((await f.fingerprint()).key, first.key, name); await f.put(name, original);
  }
  assert.notEqual((await f.fingerprint({ RUSTFLAGS: '-C target-cpu=x86-64-v3' })).key, first.key);
  await assert.rejects(() => f.fingerprint({ RUSTFLAGS: '-C target-cpu=native' }), /Host-specific/);
  assert.notEqual((await f.fingerprint({ ImageVersion: 'different compiler image' })).key, first.key);
});

test('native include escapes and dynamic inputs cannot grant cache reuse', async t => {
  const f = await fixture(t);
  await f.put('crates/app/main.rs', 'include_str!("../../../outside");'); await assert.rejects(f.fingerprint, /escapes/);
  await f.put('crates/app/main.rs', 'include_str!(concat!(env!("HOME"),"/config"));'); await assert.rejects(f.fingerprint, /Unsupported/);
});

test('native receipts reject missing, changed, oversized and mismatched binary evidence', async t => {
  const f = await fixture(t), key = (await f.fingerprint()).key, directory = path.join(f.root, 'cache'), binary = path.join(f.root, 'native');
  await f.put('native', 'owned native bytes'); assert.equal(await verifyNative({ directory, key }), false);
  const receipt = await sealNative({ directory, binary, key }); assert.equal(await verifyNative({ directory, key }), true);
  assert.equal(await verifyNative({ directory, key: 'native-v1-' + '0'.repeat(64) }), false);
  await writeFile(path.join(directory, receipt.executable), 'different bytes'); assert.equal(await verifyNative({ directory, key }), false);
  await sealNative({ directory, binary, key }); await writeFile(path.join(directory, 'receipt.json'), 'x'.repeat(4097)); assert.equal(await verifyNative({ directory, key }), false);
});
