import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {buildPlanConcurrency, immutableStylePlan, executeStylePlan} from './parallel-plan.mjs';
import {validateProjectConfig} from './config.mjs';
import {createCssModules} from './css-modules.mjs';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('production parallelism has explicit bounded configuration and conservative memory admission', () => {
  const defaults = validateProjectConfig({}).experimental;
  assert.equal(defaults.parallelBuilds, false);
  assert.equal(defaults.nativePprShell, false);
  assert.equal(defaults.streamingRequestBodies, false);
  const options = validateProjectConfig({experimental: {parallelBuilds: true}}).experimental.parallelBuilds;
  assert.deepEqual(options, {maxWorkers: 4, maxMemoryMb: 1024});
  assert.equal(buildPlanConcurrency(options, {cpus: 8, freeBytes: 4 * 1024 ** 3}), 4);
  assert.equal(buildPlanConcurrency({...options, maxMemoryMb: 256}, {cpus: 8, freeBytes: 4 * 1024 ** 3}), 1);
  assert.equal(buildPlanConcurrency(options, {cpus: 2, freeBytes: 4 * 1024 ** 3}), 2);
  assert.equal(buildPlanConcurrency(options, {cpus: 8, freeBytes: 200 * 1024 ** 2}), 1);
  for (const key of ['nativePprShell', 'streamingRequestBodies']) for (const value of [null, 1, 'true', {}, []]) assert.throws(() => validateProjectConfig({cacheComponents: true, experimental: {[key]: value}}), /must be a boolean/);
  assert.throws(() => validateProjectConfig({experimental: {nativePprShell: true}}), /requires cacheComponents/);
  for (const value of [null, 1, [], {maxWorkers: null}, {maxMemoryMb: null}, {maxWorkers: 9}, {maxWorkers: 1.2}, {maxMemoryMb: 1}, {unknown: 2}]) assert.throws(() => validateProjectConfig({experimental: {parallelBuilds: value}}), /parallelBuilds/);
});

test('immutable plans deduplicate work and settle failure before cleanup', async () => {
  const source = ['shared.css'];
  const plan = immutableStylePlan([{id: 'a'}, {id: 'b'}], () => [{path: '', kind: 'layout', styles: source}]);
  source.push('late.css');
  assert.equal(plan.jobs.length, 1);
  assert.deepEqual(plan.jobs[0].styles, ['shared.css']);
  assert.throws(() => plan.routes.push({}), TypeError);
  let calls = 0;
  const result = await executeStylePlan(plan, async job => { calls++; return [...job.styles]; }, {maxWorkers: 2, maxMemoryMb: 512});
  assert.equal(calls, 1);
  assert.deepEqual(result.outputs.get('["shared.css"]'), ['shared.css']);
  const many = immutableStylePlan(['a', 'b', 'c', 'd'].map(id => ({id})), route => [{styles: [route.id]}]);
  let active = 0, peak = 0, settled = 0;
  await assert.rejects(executeStylePlan(many, async job => {
    active++; peak = Math.max(active, peak);
    try { if (job.styles[0] === 'a') { await delay(5); throw Error('transform failed'); } await delay(40); }
    finally { active--; settled++; }
  }, {maxWorkers: 2, maxMemoryMb: 512}), /transform failed/);
  assert.equal(active, 0);
  assert.ok(peak <= 2);
  assert.ok(settled < 4, 'no queued jobs start after failure');
});

test('unproven PostCSS, Sass and custom loader hooks retain sequential execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-parallel-eligibility-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{}');
    const processor = overrides => createCssModules({projectRoot: root, stage: root, ...overrides});
    assert.equal(await processor({}).parallelSafe(), true);
    assert.equal(await processor({dev: true}).parallelSafe(), false);
    assert.equal(await processor({cssEngine: 'postcss'}).parallelSafe(), false);
    assert.equal(await processor({config: {webpack: () => {}}}).parallelSafe(), false);
    assert.equal(await processor({config: {turbopack: {rules: {'*.js': {loaders: ['custom']}}}}}).parallelSafe(), false);
    assert.equal(await processor({sassOptions: {additionalData: value => value}}).parallelSafe(), false);
    await writeFile(path.join(root, 'postcss.config.mjs'), 'export default {}');
    assert.equal(await processor({}).parallelSafe(), false);
    await rm(path.join(root, 'postcss.config.mjs'));
    await writeFile(path.join(root, 'package.json'), '{"postcss":{}}');
    assert.equal(await processor({}).parallelSafe(), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
