import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { packageManifest, platforms } from '../packages/prnext/native/resolve.mjs';
import { archiveDigest, archiveFilename, archiveNames, compareMetadataArchives, expectedMetadata, metadataBaseName, metadataProofName, readArchive, verifyArtifacts, verifyExactArtifacts } from './verify-npm-artifacts.mjs';
import { publishedNative, registryPackageName } from './test-package.mjs';

const entry = (data, mode = 0o644) => ({ type: '0', mode, data: Buffer.from(data) });
const pkg = { name: packageManifest.name, version: packageManifest.version, description: 'Old description', bin: { prn: 'cli.mjs' }, dependencies: { react: '19.3.0' } };
const baseEntries = () => new Map([
  ['package/package.json', entry(JSON.stringify(pkg))],
  ['package/README.md', entry('Old README')],
  ['package/cli.mjs', entry('console.log("original runtime");', 0o755)]
]);
const updatedEntries = (base, main = true, readme = Buffer.from('Current README')) => {
  const result = new Map(base);
  result.set('package/package.json', entry(JSON.stringify({ ...JSON.parse(base.get('package/package.json').data), ...expectedMetadata(main) })));
  if (main) result.set('package/README.md', entry(readme));
  return result;
};
// Minimal USTAR fixture writer, used only to exercise the archive reader and
// tampering defenses without depending on any real release artifacts.
function archive(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const header = Buffer.alloc(512);
    const octal = (number, start, size) => header.write(number.toString(8).padStart(size - 1, '0') + '\0', start, size);
    header.write(name, 0, 100); octal(value.mode, 100, 8);
    octal(0, 108, 8); octal(0, 116, 8); octal(value.data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write(value.type || '0', 156, 1); header.write('ustar\0', 257, 6);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, value.data, Buffer.alloc((512 - value.data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('metadata refresh allows only descriptive fields and the exact source README', () => {
  const base = baseEntries(), current = updatedEntries(base), readme = Buffer.from('Current README');
  assert.deepEqual(compareMetadataArchives(readArchive(archive(base)), readArchive(archive(current)), { main: true, readme }), ['package/package.json', 'package/README.md']);
  assert.throws(() => compareMetadataArchives(base, current, { main: true, readme: Buffer.from('Another README') }), /README differs/);
});

test('native archive metadata strips repository.directory and preserves native description', () => {
  const base = baseEntries(), current = updatedEntries(base, false);
  const currentPkg = JSON.parse(current.get('package/package.json').data);
  assert.equal(currentPkg.repository.directory, undefined);
  assert.equal(currentPkg.description, pkg.description);
  compareMetadataArchives(base, current, { main: false });
  currentPkg.description = 'changed native description';
  current.set('package/package.json', entry(JSON.stringify(currentPkg)));
  assert.throws(() => compareMetadataArchives(base, current, { main: false }), /functional package.json/);
});

test('runtime, dependencies, scripts, executable permissions and added files cannot be refreshed', () => {
  const base = baseEntries(), options = { main: true, readme: Buffer.from('Current README') };
  for (const mutate of [
    map => map.set('package/cli.mjs', entry('different runtime', 0o755)),
    map => map.set('package/cli.mjs', entry(base.get('package/cli.mjs').data, 0o644)),
    map => map.set('package/new.mjs', entry('extra file')),
    map => { const p = JSON.parse(map.get('package/package.json').data); p.dependencies.react = '20.0.0'; map.set('package/package.json', entry(JSON.stringify(p))); },
    map => { const p = JSON.parse(map.get('package/package.json').data); p.name = '@another-scope/prnext'; map.set('package/package.json', entry(JSON.stringify(p))); },
    map => { const p = JSON.parse(map.get('package/package.json').data); p.scripts = { postinstall: 'unexpected command' }; map.set('package/package.json', entry(JSON.stringify(p))); }
  ]) {
    const current = updatedEntries(base); mutate(current);
    assert.throws(() => compareMetadataArchives(base, current, options));
  }
});

test('archive reader refuses traversal, symbolic links, duplicate names and damaged headers', () => {
  for (const [name, type] of [['package/../../escape', '0'], ['package/link', '2']]) {
    const entries = baseEntries(); entries.set(name, { ...entry('x'), type });
    assert.throws(() => readArchive(archive(entries)), /Unsafe archive path|Unsupported tar entry type/);
  }
  assert.throws(() => readArchive(archive([...baseEntries(), ['package/cli.mjs', entry('duplicate')]])), /Duplicate archive entry/);
  const bytes = archive(baseEntries()); bytes[bytes.length - 6] ^= 1;
  assert.throws(() => readArchive(bytes));
});

async function proofFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-metadata-test-'));
  const baseDirectory = path.join(directory, metadataBaseName);
  await mkdir(baseDirectory);
  const readme = await readFile(new URL('../packages/prnext/README.md', import.meta.url));
  const proof = { kind: 'prnext-metadata-only-v1', version: packageManifest.version, baseDirectory: metadataBaseName, archives: [] };
  for (const filename of archiveNames()) {
    const main = filename === archiveFilename();
    const base = baseEntries();
    const name = main ? packageManifest.name : platforms.find(target => archiveFilename(target.package) === filename).package;
    base.set('package/package.json', entry(JSON.stringify({ ...pkg, name })));
    const current = updatedEntries(base, main, readme);
    const originalBytes = archive(base), currentBytes = archive(current);
    await writeFile(path.join(baseDirectory, filename), originalBytes);
    await writeFile(path.join(directory, filename), currentBytes);
    proof.archives.push({ filename, original: archiveDigest(originalBytes), current: archiveDigest(currentBytes), changedEntries: compareMetadataArchives(base, current, { main, readme }) });
  }
  for (const target of platforms) for (const strategy of ['hoisted', 'nested']) {
    const names = [archiveFilename(), archiveFilename(target.package)];
    const report = { version: packageManifest.version, platform: target.id, strategy, checks: Array(10).fill('synthetic fixture'), sha256: {}, archives: [] };
    for (const name of names) {
      const original = proof.archives.find(record => record.filename === name).original;
      report.archives.push({ filename: name, size: original.size, integrity: original.integrity });
      report.sha256[name] = original.sha256;
    }
    const filename = `verified-${target.id}${strategy === 'nested' ? '-nested' : ''}.json`;
    for (const folder of [directory, baseDirectory]) await writeFile(path.join(folder, filename), JSON.stringify(report));
  }
  await writeFile(path.join(directory, metadataProofName), JSON.stringify(proof));
  return { directory, baseDirectory, proof };
}

test('derived archives verify preserved original reports and reject forged metadata proof for runtime changes', async () => {
  const { directory, baseDirectory, proof } = await proofFixture();
  try {
    const verified = await verifyArtifacts({ directory });
    assert.equal(verified.metadataOnly, true);
    assert.deepEqual([...verified.keys()].sort(), platforms.map(target => target.package).sort());
    await assert.rejects(verifyExactArtifacts({ directory: baseDirectory }), /metadata is stale/);
    const record = proof.archives[0], entries = readArchive(await readFile(path.join(directory, record.filename)));
    entries.set('package/cli.mjs', entry('tampered runtime', 0o755));
    const bytes = archive(entries);
    await writeFile(path.join(directory, record.filename), bytes);
    record.current = archiveDigest(bytes); record.changedEntries.push('package/cli.mjs');
    await writeFile(path.join(directory, metadataProofName), JSON.stringify(proof));
    await assert.rejects(verifyArtifacts({ directory }), /runtime or native bytes changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exact archive proofs return every native integrity, including scoped filenames', async () => {
  const { directory, baseDirectory, proof } = await proofFixture();
  try {
    const verified = await verifyExactArtifacts({ directory: baseDirectory, checkMetadata: false });
    assert.deepEqual([...verified.keys()].sort(), platforms.map(target => target.package).sort());
    for (const target of platforms) {
      const record = proof.archives.find(item => item.filename === archiveFilename(target.package));
      assert.equal(verified.get(target.package), record.original.integrity);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('derived proof cannot rewrite an execution report or tamper with original archive bytes', async () => {
  const { directory, baseDirectory, proof } = await proofFixture();
  try {
    const report = path.join(directory, `verified-${platforms[0].id}.json`);
    const original = await readFile(report);
    await writeFile(report, Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(verifyArtifacts({ directory }), /original test evidence was modified/);
    await writeFile(report, original);
    await writeFile(path.join(baseDirectory, proof.archives[0].filename), Buffer.from('not the original archive'));
    await assert.rejects(verifyArtifacts({ directory }), /changed since/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scoped package names map to npm archive filenames and both registry URL forms', () => {
  assert.equal(archiveFilename('@thomas.f/prnext', '0.1.0-alpha.1'), 'thomas.f-prnext-0.1.0-alpha.1.tgz');
  assert.equal(archiveFilename('prnext-linux-x64-gnu', '0.1.0-alpha.1'), 'prnext-linux-x64-gnu-0.1.0-alpha.1.tgz');
  assert.equal(archiveFilename('@thomas.f/prnext-win32-x64-msvc', '0.1.1-alpha'), 'thomas.f-prnext-win32-x64-msvc-0.1.1-alpha.tgz');
  for (const pathname of ['/\u0040thomas.f%2fprnext', '/%40thomas.f%2Fprnext', '/@thomas.f/prnext/-/thomas.f-prnext-0.1.0-alpha.1.tgz', '/%40thomas.f%2Fprnext/-/thomas.f-prnext-0.1.0-alpha.1.tgz']) {
    assert.equal(registryPackageName(pathname), '@thomas.f/prnext');
  }
  assert.equal(registryPackageName('/prnext-linux-x64-gnu/-/native.tgz'), 'prnext-linux-x64-gnu');
});

function publishedFixture() {
  const target = platforms.find(item => item.id === 'linux-x64-gnu');
  const binary = Buffer.from('synthetic native executable');
  const manifest = { name: target.package, version: packageManifest.version, os: [target.os], cpu: [target.cpu], libc: [target.libc] };
  const entries = new Map([
    ['package/package.json', entry(JSON.stringify(manifest))],
    ['package/native.json', entry(JSON.stringify({ ...target, version: packageManifest.version, sha256: archiveDigest(binary).sha256 }))],
    ['package/bin/prnext', entry(binary, 0o755)]
  ]);
  const bytes = archive(entries);
  const metadata = { ...manifest, dist: { tarball: `https://registry.npmjs.org/${target.package}/-/${archiveFilename(target.package)}`, integrity: archiveDigest(bytes).integrity } };
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    return new Response(url.endsWith('.tgz') ? bytes : JSON.stringify(metadata), { status: 200 });
  };
  return { target, bytes, metadata, fetcher, requests };
}

test('published native reuse preserves exact registry tarball bytes and refuses overwriting a different archive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-published-native-test-'));
  const fixture = publishedFixture();
  try {
    const packed = await publishedNative({ out: directory, target: fixture.target, fetcher: fixture.fetcher });
    assert.ok((await readFile(packed.tarball)).equals(fixture.bytes));
    assert.equal(packed.integrity, fixture.metadata.dist.integrity);
    assert.equal(packed.published.tarball, fixture.metadata.dist.tarball);
    assert.equal(fixture.requests.length, 2);
    await publishedNative({ out: directory, target: fixture.target, fetcher: fixture.fetcher });
    await writeFile(packed.tarball, 'previous differently packed native');
    await assert.rejects(publishedNative({ out: directory, target: fixture.target, fetcher: fixture.fetcher }), /differs from the exact published archive/);
    assert.equal(await readFile(packed.tarball, 'utf8'), 'previous differently packed native');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('published native download rejects integrity, platform and unexpected registry origin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-published-native-invalid-'));
  try {
    for (const [mutate, message] of [
      [fixture => { fixture.metadata.dist.integrity = archiveDigest(Buffer.from('wrong bytes')).integrity; }, /integrity mismatch/],
      [fixture => { fixture.metadata.cpu = ['arm64']; }, /CPU mismatch/],
      [fixture => { fixture.metadata.dist.tarball = 'https://example.invalid/native.tgz'; }, /must come from the npm registry/]
    ]) {
      const fixture = publishedFixture(); mutate(fixture);
      await assert.rejects(publishedNative({ out: directory, target: fixture.target, fetcher: fixture.fetcher }), message);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
