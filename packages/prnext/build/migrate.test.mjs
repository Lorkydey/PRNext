import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { migrateScript, migrationPackage, migrateProject, parseMigrationArgs } from './migrate.mjs';

const framework = { name: '@thomas.f/prnext', version: '0.1.0-alpha.1', peerDependencies: { 'react-server-dom-webpack': '19.3.0' } };
const initial = () => ({ name: 'next-project', private: true, scripts: { dev: 'next dev --turbopack', build: 'next build', start: 'next start', lint: 'eslint .' }, dependencies: { next: '^16.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', application: '1.2.3' } });
const passed = async () => ({ ok: true, routes: [{ pattern: '/', router: 'app' }], errors: [], notes: [] });
async function fixture(t, data = initial(), format = value => JSON.stringify(value, null, 2) + '\n') {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-migrate-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = format(data);
  await writeFile(path.join(root, 'package.json'), source);
  return { root, source, package: async () => JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) };
}

test('migration converts supported commands and preserves quoted paths, environment prefixes and ports', () => {
  assert.deepEqual(migrateScript('next dev --turbopack -p 4100 -H "0.0.0.0"', 'dev'), { value: 'prn dev --port 4100 --hostname "0.0.0.0"', removed: ['--turbopack'] });
  assert.equal(migrateScript('NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack', 'build').value, 'NEXT_TELEMETRY_DISABLED=1 prn build');
  assert.equal(migrateScript('cross-env NODE_ENV=production next start --port=4101 --hostname=localhost', 'start').value, 'cross-env NODE_ENV=production prn start --port=4101 --hostname=localhost');
  assert.equal(migrateScript('next dev --port 4000 "site with spaces"', 'dev').value, 'prn dev "site with spaces" --port 4000');
  assert.equal(migrateScript('PORT="4102" next start', 'start').value, 'PORT="4102" prn start --port 4102');
  assert.equal(migrateScript('cross-env PORT=4102 next dev -p 4103', 'dev').value, 'cross-env PORT=4102 prn dev --port 4103');
  assert.equal(migrateScript("next start '-p=4104'", 'start').value, "prn start '--port=4104'");
  assert.equal(migrateScript('prn build && custom-after-build', 'build').value, 'prn build && custom-after-build');
  assert.equal(migrateScript('prnext start --workers 2', 'start').value, 'prnext start --workers 2');
});

test('migration rejects custom shell programs and unsupported Next options instead of dropping them', () => {
  for (const script of ['next build && upload', 'echo "next build"', 'next build\nother-command', 'next build --debug', 'node build.js', 'next build $(touch unexpected)', 'next build | tee output']) {
    assert.throws(() => migrateScript(script, 'build'), /manually|unsupported|Adapt/);
  }
  assert.throws(() => migrateScript('next dev --port', 'dev'), /requires a value/);
  assert.throws(() => migrateScript('next start -p --hostname x', 'start'), /requires a value/);
  assert.throws(() => migrateScript('PORT=bad next start', 'start'), /PORT/);
  assert.throws(() => migrateScript('next dev apps/*', 'dev'), /manually/);
});

test('migration upgrades the former rx shortcut while preserving native options and quoted arguments', () => {
  assert.equal(migrateScript('rx start "site with spaces" --profile memory --workers 2', 'start').value, 'prn start "site with spaces" --profile memory --workers 2');
  assert.equal(migrateScript('cross-env NODE_ENV=production npx --no-install rx start --port 4100', 'start').value, 'cross-env NODE_ENV=production prn start --port 4100');
  assert.throws(() => migrateScript('rx build && rx routes', 'build'), /manually/);
});

test('migration keeps dependencies and original commands, handles backup-name conflicts and is idempotent', () => {
  const original = initial();
  original.scripts['dev:next'] = 'custom-next-server';
  original.devDependencies = { [framework.name]: '*', react: '^18', typescript: '^5' };
  original.optionalDependencies = { 'react-dom': '^18', optional: '*' };
  const plan = migrationPackage(original, framework, framework.version);
  assert.equal(original.scripts.dev, 'next dev --turbopack');
  assert.equal(plan.package.scripts.dev, 'prn dev');
  assert.equal(plan.package.scripts['dev:next'], 'custom-next-server');
  assert.equal(plan.package.scripts['dev:next:2'], 'next dev --turbopack');
  assert.equal(plan.package.scripts.lint, 'eslint .');
  assert.equal(plan.package.dependencies.next, '^16.0.0');
  assert.equal(plan.package.dependencies.application, '1.2.3');
  assert.equal(plan.package.dependencies[framework.name], framework.version);
  assert.equal(plan.package.dependencies.prnext, undefined);
  assert.equal(plan.package.dependencies.react, '19.3.0');
  assert.equal(plan.package.dependencies['react-server-dom-webpack'], '19.3.0');
  assert.deepEqual(plan.package.devDependencies, { typescript: '^5' });
  assert.deepEqual(plan.package.optionalDependencies, { optional: '*' });
  assert.deepEqual(migrationPackage(plan.package, framework, framework.version).changes, []);
});

test('argument parsing accepts flags before or after the directory and rejects misspellings', () => {
  const args = parseMigrationArgs(['--dry-run', 'some app', '--json', '--no-install']);
  assert.equal(args.directory, path.resolve('some app'));
  assert.deepEqual(args.options, { dryRun: true, install: false, json: true });
  assert.throws(() => parseMigrationArgs(['--force']), /Unknown/);
  assert.throws(() => parseMigrationArgs(['a', 'b']), /single/);
});

test('migration replaces former local package entries with one scoped runtime dependency', () => {
  const original = initial();
  original.dependencies.prnext = 'file:../prnext/packages/prnext';
  original.devDependencies = { prnext: '*', [framework.name]: '0.0.0-alpha.0', typescript: '^5' };
  original.optionalDependencies = { prnext: '*', optional: '*' };
  const plan = migrationPackage(original, framework, framework.version);
  assert.equal(plan.package.dependencies[framework.name], framework.version);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(plan.package[field].prnext, undefined);
    assert.ok(plan.changes.some(change => change.field === `${field}.prnext` && change.after === null));
  }
  assert.deepEqual(plan.package.devDependencies, { typescript: '^5' });
  assert.deepEqual(plan.package.optionalDependencies, { optional: '*' });
  assert.equal(original.dependencies.prnext, 'file:../prnext/packages/prnext');
  assert.deepEqual(migrationPackage(plan.package, framework, framework.version).changes, []);
});

test('dry-run preflights configuration but leaves files, backups and installation untouched', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
  const entries = await readdir(f.root);
  const result = await migrateProject(f.root, { dryRun: true }, { check: async (_root, options) => { assert.equal(options.validateDependencies, false); return passed(); }, install: () => assert.fail('preview must not install') });
  assert.equal(result.ok, true); assert.equal(result.status, 'preview');
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), f.source);
  assert.deepEqual(await readdir(f.root), entries);
  assert.ok(result.changes.some(change => change.field === `dependencies.${framework.name}` && change.after.startsWith('file:')));
});

test('prepare backs up exact bytes and lockfiles, preserves formatting and changes no source files', async t => {
  const f = await fixture(t, initial(), value => JSON.stringify(value, null, '\t').replaceAll('\n', '\r\n') + '\r\n');
  await mkdir(path.join(f.root, 'app')); await writeFile(path.join(f.root, 'app/page.tsx'), 'original source');
  const lock = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
  await writeFile(path.join(f.root, 'package-lock.json'), lock);
  const result = await migrateProject(f.root, { install: false }, { check: passed });
  assert.equal(result.ok, true); assert.equal(result.status, 'prepared');
  assert.equal(await readFile(result.backups[0], 'utf8'), f.source);
  assert.deepEqual(await readFile(result.backups[1]), lock);
  assert.equal(await readFile(path.join(f.root, 'app/page.tsx'), 'utf8'), 'original source');
  assert.match(await readFile(path.join(f.root, 'package.json'), 'utf8'), /\r\n\t"/);
  const entries = await readdir(f.root);
  const again = await migrateProject(f.root, { install: false }, { check: passed });
  assert.equal(again.ok, true); assert.equal(again.status, 'unchanged');
  assert.deepEqual(again.changes, []); assert.deepEqual(again.backups, []);
  assert.deepEqual(await readdir(f.root), entries);
});

test('existing different backups are never overwritten', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'package.json.prnext-backup'), 'older original');
  const result = await migrateProject(f.root, { install: false }, { check: passed });
  assert.equal(result.ok, true);assert.ok(result.backups[0].endsWith('.prnext-backup.1'));
  assert.equal(await readFile(path.join(f.root, 'package.json.prnext-backup'), 'utf8'), 'older original');
});

test('local file dependencies resolve from the physical project directory through symlinked paths', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'nested/project'), { recursive: true });
  await writeFile(path.join(f.root, 'nested/project/package.json'), f.source);
  const alias = path.join(f.root, 'alias');
  await symlink(path.join(f.root, 'nested/project'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await migrateProject(alias, { install: false }, { check: passed });
  assert.equal(result.ok, true);
  const migrated = JSON.parse(await readFile(path.join(alias, 'package.json'), 'utf8'));
  const installedFrom = path.resolve(await realpath(alias), migrated.dependencies[framework.name].slice('file:'.length));
  assert.equal(JSON.parse(await readFile(path.join(installedFrom, 'package.json'), 'utf8')).name, framework.name);
});

test('default migration installs after writing the manifest and validates installed dependencies afterwards', async t => {
  const f = await fixture(t);const calls = [];
  const result = await migrateProject(f.root, { json: true }, {
    check: async (_root, options) => { calls.push(options?.validateDependencies === false ? 'structure' : 'installed'); return passed(); },
    install: async (root, options) => { calls.push('install');assert.equal(root, f.root);assert.equal(options.json, true);assert.equal((await f.package()).scripts.build, 'prn build'); },
  });
  assert.equal(result.ok, true); assert.equal(result.status, 'migrated');
  assert.deepEqual(calls, ['structure', 'install', 'installed']);
});

test('installation failure is reported as incomplete with the original package backup retained', async t => {
  const f = await fixture(t);
  const result = await migrateProject(f.root, {}, { check: passed, install: async () => { throw new Error('peer dependency conflict'); } });
  assert.equal(result.ok, false);assert.equal(result.status, 'incomplete');
  assert.match(result.error, /peer dependency conflict/);
  assert.equal(await readFile(result.backups[0], 'utf8'), f.source);
});

test('preflight failure, custom scripts and empty projects never rewrite the manifest', async t => {
  for (const variant of ['config', 'empty', 'script']) {
    const input = initial();if (variant === 'script') input.scripts.build = 'generate && next build';
    const f = await fixture(t, input);
    const result = await migrateProject(f.root, {}, { check: async () => variant === 'empty' ? {ok:true,routes:[]} : {ok:false,errors:['unsupported config']}, install: () => assert.fail() });
    assert.equal(result.ok, false);assert.equal(result.status, 'blocked');assert.deepEqual(result.backups, []);
    assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), f.source);
  }
});

test('non-npm locks and workspace installs require prepare-only mode without replacing their package manager', async t => {
  for (const variant of ['yarn', 'pnpm', 'workspace']) {
    const input = initial();
    if (variant === 'pnpm') input.packageManager = 'pnpm@10.0.0';
    if (variant === 'workspace') input.workspaces = ['packages/*'];
    const f = await fixture(t, input);
    if (variant === 'yarn') await writeFile(path.join(f.root, 'yarn.lock'), 'original lock');
    const blocked = await migrateProject(f.root, {}, { check: passed, install: () => assert.fail() });
    assert.equal(blocked.ok, false);assert.match(blocked.error, /--no-install/);
    assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), f.source);
    const result = await migrateProject(f.root, { install: false }, { check: passed });assert.equal(result.ok, true);
    if (variant === 'yarn') assert.equal(await readFile(path.join(f.root, 'yarn.lock'), 'utf8'), 'original lock');
  }
});

test('migration detects concurrent manifest edits rather than overwriting them', async t => {
  const f = await fixture(t);
  const result = await migrateProject(f.root, { install: false }, { check: async () => { await writeFile(path.join(f.root, 'package.json'), '{"new":"user edit"}'); return passed(); } });
  assert.equal(result.ok, false);assert.match(result.error, /changed during migration/);
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), '{"new":"user edit"}');
});

test('migration rejects invalid package fields and symbolic-link package files', async t => {
  for (const input of [{...initial(),scripts:[]},{...initial(),dependencies:'invalid'}]) {
    const f = await fixture(t, input);const result = await migrateProject(f.root, {install:false}, {check:passed});
    assert.equal(result.ok,false);assert.equal(await readFile(path.join(f.root,'package.json'),'utf8'),f.source);
  }
  const f = await fixture(t);await writeFile(path.join(f.root, 'original.json'), f.source);
  await rm(path.join(f.root, 'package.json'));await symlink('original.json', path.join(f.root, 'package.json'));
  const result = await migrateProject(f.root, { install: false }, { check: passed });
  assert.equal(result.ok, false);assert.match(result.error, /regular package.json/);
});
