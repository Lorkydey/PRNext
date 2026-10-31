import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrationScenarios } from './migration-scenarios.mjs';
import { parseMigrationArgs } from './migrate.mjs';

test('browser execution is explicit and missing local Playwright does not install or load scenarios', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-browser-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{"name":"scenario-app","type":"module"}');
  await writeFile(path.join(directory, 'scenarios.mjs'), "throw new Error('MUST NOT LOAD WITHOUT PLAYWRIGHT');");
  assert.throws(() => parseMigrationArgs(['--browser-scenarios', 'scenarios.mjs']), /requires/);
  const parsed = parseMigrationArgs(['--check', directory, '--against', 'http://127.0.0.1:1', '--candidate', 'http://127.0.0.1:2', '--browser-scenarios', 'scenarios.mjs']);
  assert.equal(parsed.options.browserScenarios, 'scenarios.mjs');
  const result = await runMigrationScenarios({ directory, against: 'http://127.0.0.1:1', candidate: 'http://127.0.0.1:2', scenarios: 'scenarios.mjs' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'playwright-unavailable');
  assert.equal(result.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /MUST NOT LOAD|C:\\|password/i);
  assert.deepEqual((await readdir(directory)).sort(), ['package.json', 'scenarios.mjs']);
  await assert.rejects(runMigrationScenarios({ directory, against: 'http://name:password@localhost', candidate: 'http://localhost', scenarios: 'scenarios.mjs' }), /without credentials/);
});

test('an asynchronously suspended scenario module is bounded before a browser can launch', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-browser-module-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{"name":"scenario-app","type":"module"}');
  await mkdir(path.join(directory, 'node_modules/playwright'), { recursive: true });
  await writeFile(path.join(directory, 'node_modules/playwright/package.json'), '{"name":"playwright","type":"module","exports":"./index.js"}');
  await writeFile(path.join(directory, 'node_modules/playwright/index.js'), 'export const chromium = {};');
  await writeFile(path.join(directory, 'scenarios.mjs'), 'await new Promise(()=>{}); export default [];');
  const result = await runMigrationScenarios({ directory, against: 'http://127.0.0.1:1', candidate: 'http://127.0.0.1:2', scenarios: 'scenarios.mjs', timeout: 100 });
  assert.equal(result.reason, 'scenario-module-timeout');
  assert.equal(result.state, 'unknown');
  assert.equal(result.ok, false);
});
