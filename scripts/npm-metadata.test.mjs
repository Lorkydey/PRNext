import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { packageManifest, platforms, nativePlatform } from '../packages/prnext/native/resolve.mjs';
import { archiveDigest, archiveFilename, archiveNames, compareMetadataArchives, expectedMetadata, metadataBaseName, metadataProofName, readArchive, verifyArtifacts, verifyExactArtifacts, verifyLifecycleArtifacts, releaseLifecycleTests, globalInstallationCheck, projectCreationCheck, reactCompilerInstallationCheck, packageInstallationCheckCount } from './verify-npm-artifacts.mjs';
import { publishedNative, registryPackageName } from './test-package.mjs';
import { diagnosticLimits, safeExecFailure, summarizeNpmLog, collectNpmLogMetadata, createPackageDiagnostics, observePackageCommand } from './test-package-diagnostics.mjs';

const entry = (data, mode = 0o644) => ({ type: '0', mode, data: Buffer.from(data) });
const pkg = { name: packageManifest.name, version: packageManifest.version, description: 'Old description', bin: { prn: 'cli.mjs' }, dependencies: { react: '19.3.0' } };
const baseEntries = () => new Map([
  ['package/package.json', entry(JSON.stringify(pkg))],
  ['package/README.md', entry('Old README')],
  ['package/cli.mjs', entry('console.log("original runtime");', 0o755)]
]);

test('release lifecycle proof requires all three Node majors and exact archive/executable identities', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-lifecycle-proof-'));
  const target=nativePlatform();
  const main=archive(baseEntries());
  const binarySha256=archiveDigest(Buffer.from('candidate')).sha256;
  const native=archive(new Map([
    ['package/package.json',entry(JSON.stringify({name:target.package,version:packageManifest.version}))],
    ['package/native.json',entry(JSON.stringify({sha256:binarySha256}))],
  ]));
  const make=major=>({platform:target.id,node:`v${major}.0.0`,passed:true,code:0,signal:null,tests:releaseLifecycleTests,
    mainArchiveSha256:archiveDigest(main).sha256,nativeArchiveSha256:archiveDigest(native).sha256,binarySha256});
  const report=major=>path.join(directory,`lifecycle-${target.id}-node${major}.json`);
  try {
    await writeFile(path.join(directory,archiveFilename()),main);
    await writeFile(path.join(directory,archiveFilename(target.package)),native);
    await writeFile(report(22),JSON.stringify(make(22)));
    await assert.rejects(verifyLifecycleArtifacts({directory,hostOnly:true}),{code:'ENOENT'});
    await writeFile(report(24),JSON.stringify(make(24)));
    await assert.rejects(verifyLifecycleArtifacts({directory,hostOnly:true}),{code:'ENOENT'});
    await writeFile(report(26),JSON.stringify(make(26)));
    await verifyLifecycleArtifacts({directory,hostOnly:true});
    for(const bad of [{passed:false},{code:1},{signal:'SIGTERM'},{node:'v24.0.0'},{tests:[]},
      {mainArchiveSha256:'stale'},{nativeArchiveSha256:'stale'},{binarySha256:'stale'}]) {
      await writeFile(report(22),JSON.stringify({...make(22),...bad}));
      await assert.rejects(verifyLifecycleArtifacts({directory,hostOnly:true}));
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('lockfile includes every optional native package with matching version and platform', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const optional = packageManifest.optionalDependencies;
  assert.deepEqual(lock.packages['packages/prnext'].optionalDependencies, optional);
  for (const target of platforms) {
    const record = lock.packages[`node_modules/${target.package}`];
    assert.ok(record, `${target.package} is missing from the lockfile; regenerate it without node_modules`);
    assert.equal(record.version, optional[target.package]);
    assert.equal(record.optional, true);
    assert.deepEqual(record.os, [target.os]);
    assert.deepEqual(record.cpu, [target.cpu]);
    if (target.libc) assert.deepEqual(record.libc, [target.libc]);
    const name = target.package.split('/').at(-1);
    assert.equal(record.resolved, `https://registry.npmjs.org/${target.package}/-/${name}-${packageManifest.version}.tgz`);
    // A not-yet-published native has no known integrity. Never carry an old
    // hash forward or fabricate archives; publication checks all six targets.
    if (record.integrity !== undefined) assert.match(record.integrity, /^sha512-/);
  }
  assert.equal(lock.version, packageManifest.version);
  assert.equal(lock.packages[''].version, packageManifest.version);
  assert.equal(lock.packages['packages/prnext'].version, packageManifest.version);
});
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
    const required = [globalInstallationCheck, projectCreationCheck, reactCompilerInstallationCheck];
    const checks = [...Array.from({ length: packageInstallationCheckCount - required.length }, (_, index) => `synthetic fixture ${index}`), ...required];
    const report = { version: packageManifest.version, platform: target.id, strategy, checks, sha256: {}, archives: [] };
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
    const reportFile=path.join(baseDirectory,`verified-${platforms[0].id}.json`);
    const originalReport=await readFile(reportFile);
    const missingGlobal=JSON.parse(originalReport);
    missingGlobal.checks=missingGlobal.checks.map(check=>check===globalInstallationCheck?'unrelated check':check);
    await writeFile(reportFile,JSON.stringify(missingGlobal));
    await assert.rejects(verifyExactArtifacts({directory:baseDirectory,checkMetadata:false}),/global installation was not verified/);
    await writeFile(reportFile,originalReport);
    for (const [check, expected] of [
      [projectCreationCheck, /project creation was not verified/],
      [reactCompilerInstallationCheck, /React Compiler installation was not verified/],
    ]) {
      const missing = JSON.parse(originalReport);
      missing.checks = missing.checks.map(value => value === check ? 'unrelated check' : value);
      await writeFile(reportFile, JSON.stringify(missing));
      await assert.rejects(verifyExactArtifacts({ directory: baseDirectory, checkMetadata: false }), expected);
    }
    const incomplete = JSON.parse(originalReport);
    incomplete.checks.pop();
    await writeFile(reportFile, JSON.stringify(incomplete));
    await assert.rejects(verifyExactArtifacts({ directory: baseDirectory, checkMetadata: false }), /incomplete package checks/);
    const duplicated = JSON.parse(originalReport);
    duplicated.checks[1] = duplicated.checks[0];
    await writeFile(reportFile, JSON.stringify(duplicated));
    await assert.rejects(verifyExactArtifacts({ directory: baseDirectory, checkMetadata: false }), /duplicate package checks/);
    await writeFile(reportFile, originalReport);
    const mainFile = path.join(baseDirectory, archiveFilename());
    const unreadableCli = readArchive(await readFile(mainFile));
    unreadableCli.get('package/cli.mjs').mode = 0o711;
    await writeFile(mainFile, archive(unreadableCli));
    await assert.rejects(verifyExactArtifacts({ directory: baseDirectory, checkMetadata: false }), /readable and executable.*0755/);
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

// Failure-only diagnostics: redaction, bounds and exact original-error preservation.
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-package-diagnostic-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('prnext-package-diagnostic-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('diagnostic observation preserves exact success and original failure even when observers throw', async () => {
  const original = Object.assign(new Error('original'), { code: 7 });
  let attempts = 0;
  for (const diagnostics of [
    { beginCommand() { throw Error('observer failed'); } },
    { beginCommand() { return () => { throw Error('finish failed'); }; } },
  ]) {
    assert.equal(await observePackageCommand(diagnostics, 'npm-install', {}, async () => 42), 42);
    await assert.rejects(observePackageCommand(diagnostics, 'npm-install', {}, async () => { attempts++; throw original; }), error => error === original);
  }
  assert.equal(attempts, 2, 'No command is retried');
});

test('exec diagnostics omit arbitrary messages, paths, credentials and hostile property getters', () => {
  const marker = 'private-bearer-value';
  const error = Object.assign(new Error(marker), { name: marker, code: 'EPRIVATE_BEARER_VALUE', signal: marker, stdout: marker, stderr: marker, env: { NPM_TOKEN: marker } });
  const summary = safeExecFailure(error);
  assert.equal(summary.code, null); assert.equal(summary.signal, null); assert.equal(summary.name, 'Error');
  assert.equal(summary.stdoutBytes, Buffer.byteLength(marker));
  assert.doesNotMatch(JSON.stringify(summary), /private|bearer|TOKEN|message|stack|env/i);
  assert.equal(safeExecFailure(Object.assign(new Error(), { code: 7, signal: 'SIGTERM', killed: true })).code, 7);
  assert.equal(safeExecFailure({ get code() { throw Error(marker); } }).code, null);
});

test('npm log parsing keeps only known numerical timing, version, error and public origin metadata', () => {
  const marker = 'private-bearer-value';
  const lines = [
    '0 info using npm@10.9.9', '1 info using node@v22.23.4',
    '2 timing idealTree Completed in 23ms', `3 timing ${marker} Completed in 99ms`,
    '4 http fetch GET 200 https://registry.npmjs.org/react 24ms (cache miss)',
    `5 http fetch GET 200 https://user:${marker}@registry.npmjs.org/react 25ms`,
    `6 http fetch GET 200 https://registry.npmjs.org/react?token=${marker} 25ms`,
    `7 http fetch GET 200 https://${marker}.invalid/react 25ms`,
    `8 verbose stack Error: ${marker}`, `9 error code ${marker}`,
    '10 error code ETIMEDOUT', '11 http fetch GET 200 http://127.0.0.1:1234/@scope/package 8ms',
    `12 silly config load:file:C:/Users/${marker}/.npmrc`,
  ];
  const result = summarizeNpmLog(lines.join('\n'));
  assert.equal(result.npm, '10.9.9'); assert.equal(result.node, 'v22.23.4');
  assert.deepEqual(result.timings, [{ phase: 'idealTree', elapsedMs: 23 }]);
  assert.deepEqual(result.codes, ['ETIMEDOUT']);
  assert.deepEqual(result.fetches.map(item => item.origin), ['public-npm', 'loopback']);
  assert.doesNotMatch(JSON.stringify(result), /private|bearer|token|scope|package|Users|npmrc|https?:|127\.0\.0\.1/i);
  const repeated = summarizeNpmLog(Array.from({ length: 100 }, () => '0 timing reify Completed in 1ms\n1 http fetch GET 200 https://registry.npmjs.org/react 1ms').join('\n'));
  assert.equal(repeated.timings.length, diagnosticLimits.timings); assert.equal(repeated.fetches.length, diagnosticLimits.fetches);
});

test('failure artifact bounds logs, commands and registry requests while excluding config and raw content', async t => {
  const root = await temporary(t), cache = path.join(root, 'cache'), logs = path.join(cache, '_logs'), output = path.join(root, 'diagnostics');
  await mkdir(logs, { recursive: true });
  const marker = 'private-bearer-value';
  for (let index = 0; index < 5; index++) await writeFile(path.join(logs, `2026-11-05T03_00_00_00${index}Z-debug-0.log`), `${marker}${'x'.repeat(60000)}\n0 info using npm@10.9.9\n1 timing idealTree Completed in 17ms\n`);
  await writeFile(path.join(logs, '2026-11-05T04_00_00_000Z-timing.json'), JSON.stringify({ metadata: { command: marker, config: marker, filler: marker.repeat(Math.ceil(148 * 1024 / marker.length)) }, timers: { npm: 80, reify: 40, [marker]: 13 }, unfinishedTimers: { idealTree: [1, 2], [marker]: 3 } }));
  await writeFile(path.join(logs, '.npmrc'), marker);
  let clock = 10;
  const diagnostics = createPackageDiagnostics({ strategy: 'nested', platform: 'win32-x64-msvc', nodeVersion: 'v22.23.4', allowedPackages: ['@thomas.f/prnext'], now: () => clock });
  for (let index = 0; index < 100; index++) {
    const finish = diagnostics.registry('GET', index % 2 ? '@thomas.f/prnext' : marker); clock++;
    if (index === 99) { finish('aborted', 499); clock++; finish('closed', 200); finish('finished', 200); }
    else if (index === 98) { finish('closed', 200); clock++; finish('aborted', 499); }
    else { finish('finished', 200); finish('closed', 499); }
  }
  for (let index = 0; index < 30; index++) { const finish = diagnostics.beginCommand('npm-install', { timeout: 180000, maxBuffer: 2097152 }); clock++; finish(); }
  diagnostics.completed(1);
  const original = Object.assign(new Error(marker), { code: null, signal: 'SIGTERM', killed: true, stderr: marker });
  assert.equal(await diagnostics.persistFailure({ error: original, cache, directory: output }), true);
  const folders = await readdir(output); assert.equal(folders.length, 1);
  const bytes = await readFile(path.join(output, folders[0], 'diagnostic.json'));
  assert.ok(bytes.length <= diagnosticLimits.outputBytes);
  assert.doesNotMatch(bytes.toString(), /private|bearer|token|npmrc|metadata|commandLine|Users|https?:|127\.0\.0\.1/i);
  const report = JSON.parse(bytes); assert.equal(report.phase, 'after-check-1'); assert.equal(report.failure.signal, 'SIGTERM');
  assert.equal(report.registryRequestCount, 100); assert.equal(report.registryRequests.length, diagnosticLimits.requests); assert.equal(report.registryRequestsOmitted, 36);
  assert.deepEqual(report.registryRequests.slice(-2).map(item => [item.state, item.status, item.elapsedMs]), [['closed', 200, 1], ['aborted', 499, 1]], 'The first terminal event wins');
  assert.ok(report.registryRequests.slice(0, -2).every(item => item.state === 'finished' && item.status === 200));
  assert.equal(report.commandCount, 30); assert.equal(report.commands.length, diagnosticLimits.commands); assert.equal(report.commandsOmitted, 6);
  assert.ok(report.commands.every(item => item.timeoutMs === 180000 && item.maxBuffer === 2097152));
  assert.equal(report.npmLogs.length, diagnosticLimits.logs); assert.ok(report.npmLogs.every(item => item.inspectedBytes <= (item.kind === 'timing' ? diagnosticLimits.timingBytes : diagnosticLimits.logBytes)));
  const timing = report.npmLogs.find(item => item.kind === 'timing'); assert.deepEqual(timing.summary.unfinished, ['idealTree']);
  assert.ok(timing.totalBytes >= 148 * 1024 && timing.totalBytes < diagnosticLimits.timingBytes); assert.equal(timing.inspectedBytes, timing.totalBytes);
  assert.deepEqual(timing.summary.timings, [{ phase: 'npm', elapsedMs: 80 }, { phase: 'reify', elapsedMs: 40 }]);
  assert.ok(report.npmLogs.filter(item => item.kind === 'debug').every(item => item.tailOnly === true));
});

test('unavailable diagnostic storage and malformed timing metadata never replace original command failure', async t => {
  const root = await temporary(t), cache = path.join(root, 'cache'), logs = path.join(cache, '_logs'), blocked = path.join(root, 'file');
  await mkdir(logs, { recursive: true }); await writeFile(blocked, 'not a directory');
  await writeFile(path.join(logs, '2026-11-05T03_00_00_000Z-timing.json'), '{broken');
  await writeFile(path.join(logs, '2026-11-05T04_00_00_000Z-timing.json'), JSON.stringify({ timers: { npm: 1 }, metadata: 'x'.repeat(diagnosticLimits.timingBytes) }));
  assert.deepEqual(await collectNpmLogMetadata(cache), []);
  const diagnostics = createPackageDiagnostics({ strategy: 'nested', platform: 'win32-x64-msvc' });
  const original = Object.assign(new Error('original failure'), { code: 7 });
  await assert.rejects(async () => {
    try { await observePackageCommand(diagnostics, 'npm-install', { timeout: 180000 }, async () => { throw original; }); }
    catch (error) { assert.equal(await diagnostics.persistFailure({ error, cache, directory: blocked }), false); throw error; }
  }, error => error === original);
});
