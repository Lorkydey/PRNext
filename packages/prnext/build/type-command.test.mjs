import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTypeCommand } from './type-command.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(repository, '.prnext-type-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pages/users'), { recursive: true });
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'package.json'), '{"name":"type-command-app","type":"module"}');
  await writeFile(path.join(root, 'prnext.config.mjs'), 'export default {typescript:{tsconfigPath:"config/check.json",ignoreBuildErrors:true}}');
  await writeFile(path.join(root, 'config/base.json'), '{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","jsx":"react-jsx","skipLibCheck":true,"esModuleInterop":true},"include":["../pages/**/*.tsx"]}');
  await writeFile(path.join(root, 'config/check.json'), '{// preserve selected config\n"extends":"./base.json",}');
  await writeFile(path.join(root, 'pages/users/[id].tsx'), 'export default function Page(){return <p>User</p>}');
  await writeFile(path.join(root, 'pages/index.tsx'), `import Link from 'next/link';export default function Page(){return <Link href="/users/alice"/>}`);
  return root;
}

test('standalone typegen works on clean custom/inherited JSONC config and reports exact changes', async t => {
  const root = await fixture(t), base = await readFile(path.join(root, 'config/base.json'), 'utf8');
  const result = JSON.parse((await execute(process.execPath, [cli, 'typegen', root, '--json'])).stdout);
  assert.equal(result.ok, true); assert.equal(result.routes, 2);
  assert.deepEqual(result.configUpdates, ['config/check.json','prnext-env.d.ts']);
  assert.match(await readFile(path.join(root, 'config/check.json'), 'utf8'), /preserve selected config/);
  assert.equal(await readFile(path.join(root, 'config/base.json'), 'utf8'), base);
  assert.match(await readFile(path.join(root, '.prnext-types/routes.d.ts'), 'utf8'), /users\/\[id\]/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.prnext-build') || name === '.prnext'), []);
  assert.deepEqual((await runTypeCommand(root)).updated, []);
});

test('standalone typecheck generates first, rejects invalid routes and genuine TS errors despite build opt-out', async t => {
  const root = await fixture(t);
  assert.equal((await runTypeCommand(root, { check: true })).ok, true);
  await writeFile(path.join(root, 'pages/index.tsx'), `import Link from 'next/link';export default function Page(){return <Link href="/missing"/>}`);
  let report = await runTypeCommand(root, { check: true });
  assert.equal(report.ok, false); assert.match(report.errors.join('\n'), /TS2322/);
  await writeFile(path.join(root, 'pages/index.tsx'), 'const count:number="wrong";export default function Page(){return <p>{count}</p>}');
  await assert.rejects(execute(process.execPath, [cli, 'typecheck', root, '--json']), error => {
    assert.equal(error.code, 1); assert.match(JSON.parse(error.stdout).errors[0], /TS2322/); return true;
  });
  await writeFile(path.join(root, 'pages/index.tsx'), `import Link from 'next/link';export default function Page(){return <Link href="/users/alice"/>}`);
  await rm(path.join(root, 'pages/users/[id].tsx'));
  report = await runTypeCommand(root, { check: true });
  assert.equal(report.ok, false); assert.match(report.errors.join('\n'), /TS2322/);
  assert.doesNotMatch(await readFile(path.join(root, '.prnext-types/routes.d.ts'), 'utf8'), /users/);
});

test('type commands fail on missing tsconfig rather than claim generated-route validation', async t => {
  const root = await fixture(t); await rm(path.join(root, 'config/check.json'));
  const result = await runTypeCommand(root, { check: true });
  assert.equal(result.ok, false); assert.match(result.errors[0], /tsconfigPath does not exist/);
});

test('an empty generated page registry rejects internal links, and explicit opt-out remains respected', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'pages'), {recursive:true});
  await mkdir(path.join(root, 'pages/api'), {recursive:true});
  await writeFile(path.join(root, 'pages/api/status.ts'), 'export default function handler(_request:unknown,response:{end:(value:string)=>void}){response.end("ok")}');
  await writeFile(path.join(root, 'config/base.json'), '{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler","skipLibCheck":true},"include":["../source.ts"]}');
  await writeFile(path.join(root, 'source.ts'), `import {route} from '@thomas.f/prnext/route';route('/missing',{});`);
  let report = await runTypeCommand(root, {check:true});
  assert.equal(report.ok, false); assert.match(report.errors.join('\n'), /TS2345/);
  await writeFile(path.join(root, 'prnext.config.mjs'), 'export default {typedRoutes:false,typescript:{tsconfigPath:"config/check.json"}}');
  report = await runTypeCommand(root, {check:true}); assert.equal(report.ok, true); assert.equal(report.typedRoutes, false);
});
