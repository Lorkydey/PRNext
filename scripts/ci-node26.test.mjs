import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertQualificationNode, qualificationNode, qualificationSuites, qualificationPlan, parseQualificationArgs, verifyQualificationFiles, cleanQualificationSource } from './ci-node26.mjs';

test('qualification refuses the generator/default Node version and unqualified patches', () => {
  assert.doesNotThrow(() => assertQualificationNode(`v${qualificationNode}`));
  for (const version of ['v22.23.4', 'v24.22.1', 'v26.12.1', 'v26.13.1', 'v27.0.0', qualificationNode]) assert.throws(() => assertQualificationNode(version));
});

test('every planned test exists and critical paths cannot silently disappear', async () => {
  // Change-scope validation runs before npm ci. Runtime qualification retains
  // the default installed-tool check; this pure plan checks repository inputs.
  for (const suite of qualificationSuites) assert.ok(Object.keys(await verifyQualificationFiles(suite, undefined, { includeInstalledTools: false })).length);
  const runtime = qualificationPlan('runtime').flatMap(row => row.args);
  for (const file of ['app-prewarm', 'cache-rsc', 'cache-components-rsc', 'cache-result', 'flight-delta', 'flight-diagnostics', 'rsc-flight-diagnostics', 'flight-tap', 'html-envelope', 'native-ppr', 'request-stream', 'worker-prewarm']) assert.ok(runtime.includes(`packages/prnext/runtime/${file}.test.mjs`));
  for (const file of ['flight-summary', 'inspection-summary', 'source-analysis', 'source-summary', 'transform-cache', 'native-discovery']) assert.ok(runtime.includes(`packages/prnext/build/${file}.test.mjs`));
  for (const file of ['app', 'streaming', 'cache', 'render-readiness', 'inspector']) assert.ok(runtime.includes(`tests/${file}.test.mjs`));
  const browser = qualificationPlan('browser')[0].args;
  assert.equal(browser[0], 'node_modules/@playwright/test/cli.js');
  for (const file of ['hydration', 'streaming', 'flight-delta', 'isr', 'partial', 'deployment-coherence']) assert.ok(browser.includes(`tests/browser/${file}.spec.mjs`));
  assert.deepEqual(qualificationPlan('reference')[0].args, ['tests/reference/run.mjs']);
});

test('package qualification installs both layouts before checking the actual packaged native lifecycle', () => {
  const plan = qualificationPlan('package');
  assert.equal(plan.length, 3);
  assert.ok(!plan[0].args.includes('--nested') && plan[1].args.includes('--nested'));
  assert.ok(plan.slice(0, 2).every(row => row.args.includes('--binary') && !row.args.includes('--published-native')));
  assert.equal(plan[2].args[0], 'scripts/test-release-lifecycle.mjs');
  assert.equal(plan[2].args[1], plan[0].args[2]);
});

test('CLI listing is non-writing and rejects ambiguous or incomplete invocations', () => {
  assert.deepEqual(parseQualificationArgs(['--suite', 'runtime', '--list']), { suite: 'runtime', output: undefined, list: true });
  for (const args of [[], ['--suite', 'wrong', '--list'], ['--suite', 'runtime'], ['--suite', 'runtime', '--list', '--output', 'artifacts/a.json'], ['--suite', 'runtime', '--suite', 'package', '--list'], ['--suite', 'runtime', '--unknown']]) assert.throws(() => parseQualificationArgs(args));
});

test('missing selected source fails rather than qualifying an empty subset', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-node26-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(verifyQualificationFiles('runtime', root), { code: 'ENOENT' });
  await mkdir(path.join(root, 'tests/reference'), { recursive: true });
  await writeFile(path.join(root, 'tests/reference/run.mjs'), 'export {};\n');
  assert.match((await verifyQualificationFiles('reference', root))['tests/reference/run.mjs'], /^[a-f0-9]{64}$/);
});

test('pure plans need no npm install while actual browser qualification requires its real CLI', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-node26-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of qualificationPlan('browser')[0].args.filter(name => name.startsWith('tests/'))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'export {};\n');
  }
  assert.equal(Object.keys(await verifyQualificationFiles('browser', root, { includeInstalledTools: false })).length, 6);
  await assert.rejects(verifyQualificationFiles('browser', root), { code: 'ENOENT' });
  await mkdir(path.join(root, 'node_modules/@playwright/test'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/@playwright/test/cli.js'), '// owned metadata fixture; never executed\n');
  const checked = await verifyQualificationFiles('browser', root);
  assert.equal(Object.keys(checked).length, 7);
  assert.match(checked['node_modules/@playwright/test/cli.js'], /^[a-f0-9]{64}$/);
});

test('a dirty helper outside the selected entrypoints cannot claim the committed source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-node26-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)('git', ['init', '--quiet', root]);
  await mkdir(path.join(root, 'tests/reference'), { recursive: true });
  await writeFile(path.join(root, 'tests/reference/fixture.mjs'), 'export const altered = true;\n');
  await assert.rejects(cleanQualificationSource(root), /Commit the candidate/);
});

test('Node26 CI shares the qualified native build and stays inside the main CI result dependency', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workflow = await readFile(path.join(root, '.github/workflows/ci-platform.yml'), 'utf8');
  const section = workflow.slice(workflow.indexOf('\n  node26:'));
  assert.ok(section.startsWith('\n  node26:'));
  assert.match(section, /needs: native/);
  assert.match(section, /node-version: '26\.13\.0'/);
  for (const suite of qualificationSuites) assert.match(section, new RegExp(`\\b${suite}\\b`));
  assert.match(section, /name: ci-native-\$\{\{ inputs\.runner \}\}/);
  assert.doesNotMatch(section, /cargo |build:native/);
  assert.match(await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'), /needs: \[scope, test\]/);
});

test('manual Node comparison retains exact owned cgroup names and the controlled route budgets', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workflow = await readFile(path.join(root, '.github/workflows/node-performance.yml'), 'utf8');
  const names = [...workflow.matchAll(/scope="([^"]+)"/g)].map(match => match[1].replace('${GITHUB_RUN_ID}', '123').replace('${GITHUB_RUN_ATTEMPT}', '1'));
  assert.deepEqual(names, ['prnext-performance-123-1-probe.scope', 'prnext-performance-123-1.scope']);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /node-version: '26\.13\.0'/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /workflow_call:/);
  const caller = await readFile(path.join(root, '.github/workflows/performance-qualification.yml'), 'utf8');
  assert.match(caller, /compare_node26:[\s\S]*?default: false\s+type: boolean/);
  assert.match(caller, /if: github\.event_name == 'workflow_dispatch' && inputs\.compare_node26 == true\s+uses: \.\/\.github\/workflows\/node-performance\.yml/);
  assert.match(caller, /if: inputs\.compare_node26 != true &&/);
  assert.ok(caller.includes("inputs.compare_node26 == true && 'node26' || 'source'"));
  for (const name of ['CPUQuota=200%', 'MemoryMax=5368709120', 'AllowedCPUs=', 'cgroup-accounting-probe.mjs', 'release-regression.mjs run']) assert.ok(workflow.includes(name));
  const prepare = await readFile(path.join(root, 'tests/performance/prepare-candidate-comparison.mjs'), 'utf8');
  assert.match(prepare, /seconds:15,warmupSeconds:2/);
  assert.match(prepare, /repetitions:12,workers:2/);
  assert.match(prepare, /throughputDropPercent:10,p95IncreasePercent:15,maxNoisePercent:15,maxGeneratorCpuPercent:85/);
});
