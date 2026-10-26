import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from './check.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));

test('preflight collects config, React and environment errors without writing or building', async t => {
  const root = await mkdtemp(path.join(repository, '.prnext-check-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'prnext.config.mjs'), 'export default {unsupportedOption:true}');
  await mkdir(path.join(root, 'node_modules/react'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/react/package.json'), '{"version":"0.0.0"}');
  const before = await readdir(root), original = await readFile(path.join(root, 'package.json'), 'utf8');
  const report = await checkProject(root, {}, { environmentDiagnostics: async () => [
    { id: 'node', severity: 'error', message: 'unsupported node', action: 'Upgrade Node' },
    { id: 'native', severity: 'error', message: 'missing native', action: 'Install optional dependencies' },
  ] });
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(value => value.id === 'config'));
  assert.ok(report.diagnostics.some(value => value.id === 'native'));
  assert.ok(report.diagnostics.some(value => value.id === 'node'));
  assert.ok(report.errors.length >= 3);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), original);
});
