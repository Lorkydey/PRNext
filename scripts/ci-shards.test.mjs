import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserFileFilter, createPlan, discoverTestFiles, launchPlan, main, parseArguments, prepareOutputPath, readWeights, runnerArguments, validatePlan } from './ci-shards.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const weights = (values = {}) => ({ unit: 'reported-test-milliseconds', weights: values });
const inputFiles = names => names.map((file, index) => ({ file, sourceBytes: 10 + index }));
const testSource = "import { test } from 'node:test'; test('fixture', () => {});\n";

async function fixture(t, files = ['tests/a.test.mjs', 'tests/b.test.mjs']) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-ci-shards-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  async function put(file, content) { await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), content); }
  await put('package.json', '{}\n');
  await put('scripts/ci-shard-weights.json', JSON.stringify({ schemaVersion: 1, suites: { integration: weights(), browser: { unit: 'source-bytes', weights: {} } } }));
  for (const file of files) await put(file, testSource);
  return { directory, put };
}

test('CLI requires one supported suite and one of exactly two shards', () => {
  assert.deepEqual(parseArguments(['--suite', 'integration', '--shard', '1/2', '--list']), { suite: 'integration', shard: 1, list: true });
  assert.equal(parseArguments(['--shard', '2/2', '--suite', 'browser', '--plan-output', 'artifacts/plan.json']).planOutput, 'artifacts/plan.json');
  for (const args of [[], ['--suite', 'unit', '--shard', '1/2'], ['--suite', 'browser'], ['--suite', 'browser', '--shard'], ['--suite', 'browser', '--shard', '1/2', '--list', '--list'], ['--suite', 'browser', '--shard', '1/2', '--shard', '2/2'], ['--suite', 'browser', '--shard', '1/2', '--unknown']]) assert.throws(() => parseArguments(args));
  for (const shard of ['0/2', '3/2', '1/1', '1/3', '01/2', '1.5/2', '-1/2', '1/02', '1/2/3']) assert.throws(() => parseArguments(['--suite', 'browser', '--shard', shard]), /shard/);
});

test('discovery covers the integration glob and recursive default browser extensions', async t => {
  const expectedBrowser = ['tests/browser/a.spec.mjs', 'tests/browser/nested/b.test.tsx', 'tests/browser/.hidden/c.spec.cjsx', 'tests/browser/d.test.mtsx'];
  const f = await fixture(t, ['tests/z.test.mjs', 'tests/a.test.mjs', 'tests/nested/not-in-integration.test.mjs', ...expectedBrowser, 'tests/browser/helper.mjs', 'tests/browser/node_modules/ignored.spec.mjs']);
  assert.deepEqual((await discoverTestFiles(f.directory, 'integration')).map(entry => entry.file), ['tests/a.test.mjs', 'tests/z.test.mjs']);
  assert.deepEqual((await discoverTestFiles(f.directory, 'browser')).map(entry => entry.file), expectedBrowser.sort());
});

test('source-size balancing is stable across Git LF and CRLF checkouts', async t => {
  const f = await fixture(t, ['tests/browser/a.spec.mjs', 'tests/browser/b.spec.mjs']);
  await f.put('tests/browser/a.spec.mjs', 'one\ntwo\n');
  await f.put('tests/browser/b.spec.mjs', 'one\r\ntwo\r\n');
  const files = await discoverTestFiles(f.directory, 'browser');
  assert.deepEqual(files.map(entry => entry.sourceBytes), [8, 8]);
});

test('weighted plans are deterministic, balanced, disjoint and exhaustive', () => {
  const files = inputFiles(['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs', 'tests/d.test.mjs']);
  const measured = weights(Object.fromEntries(files.map(({ file }, index) => [file, [100, 80, 60, 40][index]])));
  const first = createPlan({ suite: 'integration', shard: 1, files, weights: measured });
  const second = createPlan({ suite: 'integration', shard: 2, files: [...files].reverse(), weights: measured });
  assert.deepEqual(first.shards, second.shards);
  assert.deepEqual(first.shards.map(entry => entry.estimatedWeight), [140, 140]);
  assert.equal(first.files.some(file => second.files.includes(file)), false);
  assert.deepEqual([...first.files, ...second.files].sort(), files.map(entry => entry.file));
});

test('new test files are discovered and receive nonzero fallback weight without editing a manifest', async t => {
  const f = await fixture(t);
  const measured = weights({ 'tests/a.test.mjs': 10, 'tests/b.test.mjs': 20, 'tests/old-removed.test.mjs': 30 });
  await f.put('tests/new.test.mjs', '');
  const files = await discoverTestFiles(f.directory, 'integration');
  const plan = createPlan({ suite: 'integration', shard: 1, files, weights: measured });
  assert.equal(plan.fallbackWeight, 20);
  assert.equal(plan.shards.flatMap(shard => shard.files).filter(file => file === 'tests/new.test.mjs').length, 1);
  assert.equal(plan.shards.reduce((sum, shard) => sum + shard.estimatedWeight, 0), 50);
  await f.put('tests/browser/empty.spec.mjs', '');
  await f.put('tests/browser/other.test.js', 'abc');
  const browser = createPlan({ suite: 'browser', shard: 2, files: await discoverTestFiles(f.directory, 'browser'), weights: { unit: 'source-bytes', weights: {} } });
  assert.deepEqual(browser.shards.map(shard => shard.estimatedWeight).sort((a, b) => a - b), [1, 3]);
  await f.put('tests/browser/new.spec.mjs', '');
  const historicalBrowser = createPlan({ suite: 'browser', shard: 1, files: await discoverTestFiles(f.directory, 'browser'), weights: weights({ 'tests/browser/empty.spec.mjs': 10, 'tests/browser/other.test.js': 20, 'tests/browser/removed.spec.mjs': 30 }) });
  assert.equal(historicalBrowser.fallbackWeight, 20);
  assert.equal(historicalBrowser.shards.reduce((sum, shard) => sum + shard.estimatedWeight, 0), 50);
  assert.equal(historicalBrowser.shards.flatMap(shard => shard.files).filter(file => file === 'tests/browser/new.spec.mjs').length, 1);
});

test('validation rejects missing, duplicate, unknown, empty and inconsistent selections', () => {
  const files = inputFiles(['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']);
  const plan = createPlan({ suite: 'integration', shard: 1, files, weights: weights() });
  const available = files.map(entry => entry.file);
  const cases = [
    changed => changed.shards[0].files.push(changed.shards[1].files[0]),
    changed => changed.shards[0].files.pop(),
    changed => changed.shards[0].files.push('tests/unknown.test.mjs'),
    changed => { changed.shards[1].files = []; },
    changed => { changed.files = []; },
    changed => { changed.totalFiles++; },
    changed => { changed.shard = 3; },
    changed => { changed.shards[0].estimatedWeight = 0; },
  ];
  for (const mutate of cases) { const changed = structuredClone(plan); mutate(changed); assert.throws(() => validatePlan(changed, available)); }
  assert.throws(() => validatePlan(plan, [...available, available[0]]), /discovered/);
  assert.throws(() => createPlan({ suite: 'integration', shard: 1, files: [], weights: weights() }), /empty/);
});

test('the checked-in manifest and both current suites produce complete two-shard plans', async () => {
  const manifest = await readWeights(root);
  for (const suite of ['integration', 'browser']) {
    const files = await discoverTestFiles(root, suite);
    const first = createPlan({ suite, shard: 1, files, weights: manifest.suites[suite] });
    const second = createPlan({ suite, shard: 2, files, weights: manifest.suites[suite] });
    assert.deepEqual(first.shards, second.shards);
    assert.deepEqual([...first.files, ...second.files].sort(), files.map(entry => entry.file));
    assert.equal(new Set([...first.files, ...second.files]).size, files.length);
  }
});

test('list mode emits only a JSON plan and never starts a runner', async t => {
  const f = await fixture(t);
  let output;
  assert.equal(await main(['--suite', 'integration', '--shard', '2/2', '--list', '--plan-output', 'artifacts/plans/integration-2.json'], { root: f.directory, stdout: text => { output = text; } }), 0);
  const plan = JSON.parse(output);
  assert.equal(plan.shard, 2);
  assert.equal(plan.totalFiles, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'artifacts/plans/integration-2.json'), 'utf8')), plan);
  await assert.rejects(() => main(['--suite', 'integration', '--shard', '2/2', '--list', '--plan-output', 'artifacts/plans/integration-2.json'], { root: f.directory }), /already exists/);
});

test('result paths reject source files and preserve existing artifacts', async t => {
  const f = await fixture(t);
  for (const output of ['tests/report.json', 'artifacts/../report.json', 'artifacts/report.mjs', '../outside.json']) await assert.rejects(() => prepareOutputPath(f.directory, output), /under artifacts/);
  await f.put('artifacts/existing.json', 'preserved');
  await assert.rejects(() => prepareOutputPath(f.directory, 'artifacts/existing.json'), /already exists/);
  assert.equal(await readFile(path.join(f.directory, 'artifacts/existing.json'), 'utf8'), 'preserved');
});

test('an artifact directory link cannot create results outside the artifact tree', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, 'outside'));
  await mkdir(path.join(f.directory, 'artifacts'));
  await symlink(path.join(f.directory, 'outside'), path.join(f.directory, 'artifacts/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareOutputPath(f.directory, 'artifacts/link/new/report.json'), /resolving links/);
  await assert.rejects(() => lstat(path.join(f.directory, 'outside/new')), { code: 'ENOENT' });
});

test('browser file filters match exactly, including regex metacharacters and either separator', () => {
  const file = 'tests/browser/a+(bracket)[case].spec.mjs';
  const absolute = path.resolve(root, file);
  const matcher = new RegExp(browserFileFilter(root, file));
  assert.equal(matcher.test(absolute), true);
  assert.equal(matcher.test(absolute.replaceAll('\\', '/')), true);
  assert.equal(matcher.test(absolute + '.other'), false);
  assert.equal(matcher.test(absolute.replace('.spec.', 'XspecX')), false);
});

test('real node:test children preserve success and failure without running the other shard', async t => {
  const f = await fixture(t);
  await f.put('tests/a.test.mjs', "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('expected failure', () => assert.fail('fixture failure'));\n");
  const files = await discoverTestFiles(f.directory, 'integration');
  const measured = weights({ 'tests/a.test.mjs': 2, 'tests/b.test.mjs': 1 });
  assert.equal(await launchPlan(createPlan({ suite: 'integration', shard: 1, files, weights: measured }), { root: f.directory, stdio: 'ignore' }), 1);
  assert.equal(await launchPlan(createPlan({ suite: 'integration', shard: 2, files, weights: measured }), { root: f.directory, stdio: 'ignore' }), 0);
});

test('a local browser CLI receives exact file regexes, one worker, optional JSON and forwards exit 7', async t => {
  const f = await fixture(t, ['tests/browser/a+(bracket)[case].spec.mjs', 'tests/browser/b.spec.mjs']);
  await f.put('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', exports: { './cli': './cli.js' } }));
  await f.put('node_modules/@playwright/test/cli.js', "const fs = require('node:fs'); fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), planPresent: fs.existsSync(process.env.TEST_PLAN_PATH) })); process.exit(7);\n");
  const planPath = path.join(f.directory, 'artifacts/plan.json');
  const code = await main(['--suite', 'browser', '--shard', '1/2', '--plan-output', 'artifacts/plan.json'], { root: f.directory, stdout: () => {}, stdio: 'ignore', env: { ...process.env, TEST_PLAN_PATH: planPath, PLAYWRIGHT_JSON_OUTPUT_FILE: 'artifacts/browser.json' } });
  assert.equal(code, 7);
  const result = JSON.parse(await readFile(path.join(f.directory, 'artifacts/browser.json'), 'utf8'));
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(result.planPresent, true);
  assert.equal(realpathSync.native(result.cwd), realpathSync.native(f.directory));
  assert.deepEqual(result.args, ['test', '--config', path.join(f.directory, 'playwright.config.mjs'), '--workers=1', '--reporter=line,json', ...plan.files.map(file => browserFileFilter(f.directory, file))]);
});

test('actual Playwright collection preserves the exact disjoint union of spec IDs', async t => {
  const require = createRequire(import.meta.url);
  let cli;
  try { cli = require.resolve('@playwright/test/cli'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; t.skip('Playwright is not installed in the lightweight scope job; the installed platform jobs exercise this collector'); return; }
  const f = await fixture(t, []);
  await f.put('playwright.config.mjs', "export default { testDir: './tests/browser', workers: 1 };\n");
  const importUrl = pathToFileURL(path.join(path.dirname(cli), 'index.mjs')).href;
  for (const name of ['a+(bracket)[case]', 'b', 'c', 'nested/d']) await f.put(`tests/browser/${name}.spec.mjs`, `import {test} from ${JSON.stringify(importUrl)}; test('same title', () => {});\n`);
  const files = await discoverTestFiles(f.directory, 'browser');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  async function collect(args) {
    const { stdout } = await execute(process.execPath, [...args, '--list', '--reporter=json'], { cwd: f.directory, env, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    assert.deepEqual(report.errors, []);
    const ids = [];
    function visit(suite) { for (const spec of suite.specs ?? []) ids.push(spec.id); for (const child of suite.suites ?? []) visit(child); }
    for (const suite of report.suites) visit(suite);
    return ids.sort();
  }
  const all = await collect([cli, 'test', '--config', path.join(f.directory, 'playwright.config.mjs')]);
  assert.equal(all.length, 4);
  const selected = [];
  for (const shard of [1, 2]) {
    const plan = createPlan({ suite: 'browser', shard, files, weights: { unit: 'source-bytes', weights: {} } });
    const ids = await collect(runnerArguments(plan, { root: f.directory, playwrightCli: cli }));
    assert.ok(ids.length > 0 && ids.length < all.length);
    selected.push(...ids);
  }
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), all);
});

test('a file removed or added after planning fails before spawning tests', async t => {
  const f = await fixture(t, ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']);
  const files = await discoverTestFiles(f.directory, 'integration');
  const plan = createPlan({ suite: 'integration', shard: 1, files, weights: weights() });
  await f.put('tests/new.test.mjs', testSource);
  await assert.rejects(() => launchPlan(plan, { root: f.directory, stdio: 'ignore' }), /missing from shard plan/);
  await rm(path.join(f.directory, 'tests/new.test.mjs'));
  await rm(path.join(f.directory, 'tests/c.test.mjs'));
  await assert.rejects(() => launchPlan(plan, { root: f.directory, stdio: 'ignore' }), /unknown test/);
});

test('the executable CLI exits nonzero for an empty suite and malformed arguments', async t => {
  const f = await fixture(t, []);
  await mkdir(path.join(f.directory, 'tests'));
  const script = path.join(f.directory, 'scripts/ci-shards.mjs');
  await copyFile(new URL('./ci-shards.mjs', import.meta.url), script);
  for (const args of [['--suite', 'integration', '--shard', '1/2'], ['--suite', 'browser', '--shard', '9/2']]) {
    await assert.rejects(() => execute(process.execPath, [script, ...args], { cwd: f.directory, windowsHide: true }), error => error.code === 1 && /CI sharding:/.test(error.stderr));
  }
});

test('the executable CLI through a directory symlink validates arguments and prints its actual plan', async t => {
  const f = await fixture(t);
  await copyFile(new URL('./ci-shards.mjs', import.meta.url), path.join(f.directory, 'scripts/ci-shards.mjs'));
  const alias = path.join(f.directory, 'script-alias');
  await symlink(path.join(f.directory, 'scripts'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const script = path.join(alias, 'ci-shards.mjs');
  for (const nodeArgs of [[], ['--preserve-symlinks-main']]) {
    const { stdout } = await execute(process.execPath, [...nodeArgs, script, '--suite', 'integration', '--shard', '1/2', '--list'], { cwd: f.directory, windowsHide: true });
    const plan = JSON.parse(stdout);
    assert.equal(plan.totalFiles, 2);
    assert.equal(plan.files.length, 1);
    await assert.rejects(() => execute(process.execPath, [...nodeArgs, script, '--suite', 'browser', '--shard', '9/2'], { cwd: f.directory, windowsHide: true }), error => error.code === 1 && /CI sharding:/.test(error.stderr));
  }
});

test('invalid weights cannot silently remove a test or introduce zero-cost work', async t => {
  const f = await fixture(t);
  for (const bad of [{ 'tests/a.test.mjs': 0 }, { 'tests/a.test.mjs': -1 }, { '../outside.test.mjs': 2 }, { 'tests/a.test.mjs': 1.5 }]) {
    await f.put('scripts/ci-shard-weights.json', JSON.stringify({ schemaVersion: 1, suites: { integration: weights(bad), browser: { unit: 'source-bytes', weights: {} } } }));
    await assert.rejects(() => readWeights(f.directory), /Invalid shard weight/);
  }
});
