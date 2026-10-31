import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkReleaseRegression, medianInterval, releaseRoutes } from './release-regression.mjs';
import { createProductionFixture, productionFixtureFiles } from './production-fixture.mjs';
import { verifyReleaseInstallation, runReleaseRegression } from './release-regression-runner.mjs';
import { nativePlatform } from '../../packages/prnext/native/resolve.mjs';
import { createHash } from 'node:crypto';
import { runtimeDependencyScope } from './release-regression-dependencies.mjs';

function load(route, seconds, multiplier = 1) {
  const started = Math.round(100 * multiplier * seconds), within = Math.round(90 * multiplier * seconds);
  return { config: { url: 'http://127.0.0.1:12345', route, seconds, connections: 2, mode: 'closed', encoding: 'identity' }, durationSeconds: seconds, elapsedSeconds: seconds + 0.05, started, completed: started, usefulCompleted: started, completedWithinWindow: within, usefulWithinWindow: within, errors: 0, transportErrors: 0, httpErrors: 0, validationErrors: 0, overflow: 0, dropped: 0, failures: {}, statuses: { 200: started }, perRoute: { [route]: started }, rps: within / seconds, p95: 10 / multiplier, generatorCpuPercent: 25, generatorCpuSeconds: 0.25 * seconds };
}
function report() {
  const controls = { platform: 'win32', affinity: { state: 'not-verified' }, quota: { state: 'not-imposed' }, memoryLimit: { state: 'not-verified' } };
  const environment = { platform: 'win32', arch: 'x64', release: 'test', cpuModel: 'fixture-cpu', logicalCpus: 8, totalMemoryBytes: 16e9, node: 'v22.23.4', nodeSha256: 'a'.repeat(64), controls };
  const packages = ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler'].map(name => ({ name, version: name === 'scheduler' ? '0.28.0' : '19.3.1', sha256: '9'.repeat(64), files: 2, bytes: 100 }));
  const runtimeDependencies = { version: 1, scope: runtimeDependencyScope, packages, sha256: createHash('sha256').update(JSON.stringify(packages)).digest('hex') };
  const artifact = () => ({ source: { declaredCommit: 'a'.repeat(40), associationVerifiedByHarness: false }, installationVerified: true, binarySha256: 'b'.repeat(64), archives: [{ name: '@thomas.f/prnext', version: '0.1.18-alpha', sha256: 'c'.repeat(64), bytes: 100 }, { name: '@thomas.f/prnext-win32-x64-msvc', version: '0.1.18-alpha', sha256: 'd'.repeat(64), bytes: 100 }], runtimeDependencies: structuredClone(runtimeDependencies) });
  const workload = { seconds: 2, warmupSeconds: 1, connections: 2, workers: 2, repetitions: 6, routes: [...releaseRoutes], fixtureSha256: 'e'.repeat(64), generatorSha256: 'f'.repeat(64) };
  const result = { version: 1, complete: true, environment, workload, budgets: { throughputDropPercent: 10, p95IncreasePercent: 15, maxNoisePercent: 15, maxGeneratorCpuPercent: 85 }, artifacts: { baseline: artifact(), candidate: artifact() }, samples: [] };
  for (let repetition = 0; repetition < workload.repetitions; repetition++) {
    const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const variant of order) for (const route of releaseRoutes.map((_, index) => releaseRoutes[(index + repetition) % releaseRoutes.length])) result.samples.push({ repetition, variant, route, environment: structuredClone(environment), controlsBefore: controls, controlsAfter: controls, warmup: load(route, 1), measurement: load(route, 2), serverCpuSeconds: null, serverMemoryBytes: null });
  }
  return result;
}

test('paired release gate passes stable equal workloads and preserves exact source/archive provenance', () => {
  const input = report(), result = checkReleaseRegression(input);
  assert.equal(result.status, 'passed');
  assert.equal(result.scenarios.length, 3);
  assert.ok(result.scenarios.every(value => value.throughputRatio.median === 1 && value.p95Ratio.median === 1));
  assert.equal(input.artifacts.baseline.source.associationVerifiedByHarness, false);
  assert.match(result.limitation, /Server CPU and memory are not measured/);
});

test('a cold warmup can drain valid responses after its window without weakening measured throughput checks', () => {
  const input = report(), warmup = input.samples[0].warmup;
  warmup.usefulWithinWindow = 0; warmup.completedWithinWindow = 0; warmup.rps = 0;
  assert.equal(checkReleaseRegression(input).status, 'passed');
  const measured = input.samples[0].measurement;
  measured.usefulWithinWindow = 0; measured.completedWithinWindow = 0; measured.rps = 0;
  assert.throws(() => checkReleaseRegression(input), /Incomplete/);
});

test('paired release gate rejects incomplete measurements, errors, unmatched routes and machine controls', () => {
  for (const mutate of [
    value => { value.complete = false; }, value => { value.samples.pop(); },
    value => { value.samples[0].measurement.errors = 1; },
    value => { value.samples[0].measurement.validationErrors = 1; },
    value => { value.samples[0].measurement.p95 = null; },
    value => { value.samples[0].measurement.rps = 100000; },
    value => { value.samples[0].measurement.config.route = '/heavy'; },
    value => { value.samples[0].measurement.config.connections = 3; },
    value => { value.samples[0].measurement.config.url = 'https://example.test'; },
    value => { value.samples[0].environment.cpuModel = 'another-cpu'; },
    value => { value.samples[0].controlsAfter = { quota: 'different' }; },
    value => { value.artifacts.candidate.installationVerified = false; },
    value => { delete value.artifacts.candidate.runtimeDependencies; },
    value => { value.artifacts.candidate.runtimeDependencies.packages[0].sha256 = '8'.repeat(64); },
    value => { const identity = value.artifacts.candidate.runtimeDependencies; identity.packages[0].sha256 = '8'.repeat(64); identity.sha256 = createHash('sha256').update(JSON.stringify(identity.packages)).digest('hex'); },
    value => { value.samples[0].serverMemoryBytes = 100; },
    value => { [value.samples[0], value.samples[1]] = [value.samples[1], value.samples[0]]; },
  ]) {
    const input = report(); mutate(input); assert.throws(() => checkReleaseRegression(input));
  }
});

test('a repeatable useful-throughput or p95 regression fails the relative release budget', () => {
  for (const field of ['rps', 'p95']) {
    const input = report();
    for (const sample of input.samples) if (sample.variant === 'candidate') {
      if (field === 'rps') {
        sample.measurement = load(sample.route, input.workload.seconds, 0.7);
        sample.measurement.p95 = 10;
      } else sample.measurement.p95 = 15;
    }
    assert.equal(checkReleaseRegression(input).status, 'regressed');
  }
});

test('noise, intervals crossing the budget and a saturated generator remain inconclusive rather than passing', () => {
  const noisy = report();
  for (const sample of noisy.samples) if (sample.variant === 'candidate') sample.measurement = load(sample.route, 2, sample.repetition % 2 ? 1.3 : 0.7);
  assert.equal(checkReleaseRegression(noisy).status, 'inconclusive');
  const crossing = report();
  for (const sample of crossing.samples) if (sample.variant === 'candidate' && sample.repetition === 0) { sample.measurement = load(sample.route, 2, 0.85); sample.measurement.p95 = 10; }
  assert.equal(checkReleaseRegression(crossing).status, 'inconclusive');
  const saturated = report(); saturated.samples[0].measurement.generatorCpuPercent = 95;
  const result = checkReleaseRegression(saturated);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.generatorSaturated, true);
});

test('median intervals require enough repetitions and report their statistical assumption', () => {
  assert.throws(() => medianInterval([1, 1, 1, 1, 1]), /six/);
  assert.deepEqual(medianInterval([6, 2, 4, 1, 5, 3]).median, 3.5);
  const result = medianInterval([1, 1, 1, 1, 1, 1]);
  assert.ok(result.coverage >= 0.95);
  assert.match(result.assumption, /Independent/);
});

test('the shared production fixture remains executable and refuses existing destinations', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-production-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await createProductionFixture(directory);
  assert.equal(result.files, Object.keys(productionFixtureFiles).length);
  assert.equal(await readFile(path.join(directory, 'app/ssr/page.jsx'), 'utf8'), productionFixtureFiles['app/ssr/page.jsx']);
  assert.ok((await readdir(directory)).includes('.benchmark-fixture.json'));
  await assert.rejects(createProductionFixture(directory), /nonempty/);
});

function archive(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write('package/' + name, 0, 100);
    const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
    header.write(octal(0o644, 8), 100, 8); header.write(octal(0, 8), 108, 8); header.write(octal(0, 8), 116, 8);
    header.write(octal(bytes.length, 12), 124, 12); header.write(octal(0, 12), 136, 12);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('archive validation verifies every installed byte and rejects extra sources, symlinks and modified runtime files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-exact-perf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'application');
  await createProductionFixture(directory);
  const target = nativePlatform(), executable = `bin/prnext${process.platform === 'win32' ? '.exe' : ''}`;
  const specifications = [
    { 'package.json': JSON.stringify({ name: '@thomas.f/prnext', version: '0.1.18-alpha', type: 'module' }), 'cli.mjs': 'export const verified = true;' },
    { 'package.json': JSON.stringify({ name: target.package, version: '0.1.18-alpha', os: [process.platform], cpu: [process.arch] }), [executable]: 'fixture-native-bytes' },
  ];
  const archives = [];
  for (let index = 0; index < specifications.length; index++) {
    const files = specifications[index], metadata = JSON.parse(files['package.json']), file = path.join(root, `${index}.tgz`);
    await writeFile(file, archive(files)); archives.push(file);
    const packageRoot = path.join(directory, 'node_modules', metadata.name);
    for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true }); await writeFile(path.join(packageRoot, name), value); }
  }
  const specification = { directory, archives, source: '1'.repeat(40) };
  for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler']) {
    const packageRoot = path.join(directory, 'node_modules', name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: name === 'scheduler' ? '0.28.0' : '19.3.1' }));
  }
  const verified = await verifyReleaseInstallation(specification);
  assert.equal(verified.provenance.installationVerified, true);
  assert.equal(verified.provenance.archives.length, 2);
  assert.equal(verified.provenance.source.associationVerifiedByHarness, false);
  await writeFile(path.join(directory, 'app/ssr/layout.jsx'), 'export default ({children})=>children;');
  await assert.rejects(verifyReleaseInstallation(specification), /Additional workload/);
  await rm(path.join(directory, 'app/ssr/layout.jsx'));
  const installedCli = path.join(directory, 'node_modules/@thomas.f/prnext/cli.mjs');
  await writeFile(installedCli, 'changed');
  await assert.rejects(verifyReleaseInstallation(specification), /bytes differ/);
  await writeFile(installedCli, specifications[0]['cli.mjs']);
  await writeFile(path.join(directory, 'node_modules/@thomas.f/prnext/extra.mjs'), 'extra runtime');
  await assert.rejects(verifyReleaseInstallation(specification), /extra files/);
  await rm(path.join(directory, 'node_modules/@thomas.f/prnext/extra.mjs'));
  const packageRoot = path.join(directory, 'node_modules/@thomas.f/prnext'), moved = path.join(root, 'linked-framework');
  assert.ok(packageRoot.startsWith(root + path.sep) && moved.startsWith(root + path.sep));
  await rename(packageRoot, moved);
  await symlink(moved, packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyReleaseInstallation(specification), /checkout or workspace links/);
});

test('runner rejects unknown or unsafe run settings before building applications', async () => {
  await assert.rejects(runReleaseRegression({ baseline: {}, candidate: {}, workload: { repetitions: 2 } }), /6–20/);
  await assert.rejects(runReleaseRegression({ url: 'https://example.test' }), /configuration fields/);
  await assert.rejects(runReleaseRegression({ workload: { duration: 10 } }), /Unknown/);
  await assert.rejects(runReleaseRegression({ budgets: { throughputDropPercent: 99 } }), /budgets/);
});

test('the executable run entry reaches argument validation without an import cycle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-perf-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = path.join(root, 'invalid.json');
  await writeFile(configuration, '{"url":"https://example.test"}');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./release-regression.mjs', import.meta.url)), 'run', configuration, path.join(root, 'result.json')]), error => error.code === 1 && /configuration fields/.test(error.stderr) && !/unsettled top-level await/.test(error.stderr));
});
