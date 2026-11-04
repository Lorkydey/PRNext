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

test('production preflight selects production configuration, restores env and leaves the project unchanged',async t=>{
  const root=await mkdtemp(path.join(repository,'.prnext-check-production-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),'{}');await mkdir(path.join(root,'pages'));
  await writeFile(path.join(root,'pages/index.jsx'),'export default function Page(){return <main>Public</main>}');
  await writeFile(path.join(root,'.env.production'),'PRNEXT_CHECK_PUBLIC_ORIGIN=https://production.example.test');
  await writeFile(path.join(root,'.env.test'),'PRNEXT_CHECK_PUBLIC_ORIGIN=http://test.example.test');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {server:{publicOrigin:process.env.PRNEXT_CHECK_PUBLIC_ORIGIN,trustedProxies:['0.0.0.0/0']}}`);
  const previous=process.env.NODE_ENV,previousOrigin=process.env.PRNEXT_CHECK_PUBLIC_ORIGIN;process.env.NODE_ENV='test';delete process.env.PRNEXT_CHECK_PUBLIC_ORIGIN;
  const before=(await readdir(root)).sort();
  try{
    const report=await checkProject(root,{production:true,validateDependencies:false,validateEnvironment:false});
    assert.equal(report.mode,'production');assert.equal(report.ok,false);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PRNEXT_CHECK_PUBLIC_ORIGIN,undefined);
    assert.ok(report.diagnostics.some(item=>item.id==='production-proxy-range'&&item.severity==='error'));
    assert.ok(!report.diagnostics.some(item=>item.id==='production-origin-https'));
    assert.deepEqual((await readdir(root)).sort(),before);
    await assert.rejects(checkProject(root,{dev:true,production:true}),/Choose development or production/);
  }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;if(previousOrigin===undefined)delete process.env.PRNEXT_CHECK_PUBLIC_ORIGIN;else process.env.PRNEXT_CHECK_PUBLIC_ORIGIN=previousOrigin;}
});

test('production preflight detects stale artifact origins and development output without leaking manifest contents',async t=>{
  const root=await mkdtemp(path.join(repository,'.prnext-check-artifact-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),'{}');await mkdir(path.join(root,'pages'));await mkdir(path.join(root,'built'));
  await writeFile(path.join(root,'pages/index.jsx'),'export default function Page(){return <main/>}');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {distDir:'built',server:{publicOrigin:'https://new.example.test'},navigationCache:{authCookies:['session']}}`);
  await writeFile(path.join(root,'.prnext-output.json'),' {"distDir":"built"}');
  const run=()=>checkProject(root,{production:true,validateDependencies:false,validateEnvironment:false});
  await writeFile(path.join(root,'built/manifest.json'),JSON.stringify({version:1,routes:[],config:{server:{publicOrigin:'https://old.example.test'}}}));
  const mismatch=await run();assert.equal(mismatch.ok,true);assert.ok(mismatch.diagnostics.some(item=>item.code==='production-artifact-origin'&&item.severity==='warning'));
  assert.ok(mismatch.diagnostics.some(item=>item.code==='production-artifact-auth-cookies'&&item.path==='navigationCache.authCookies'));
  await writeFile(path.join(root,'built/manifest.json'),JSON.stringify({version:1,dev:true,routes:[],config:{server:{publicOrigin:'https://new.example.test'}}}));
  const dev=await run();assert.equal(dev.ok,false);assert.ok(dev.diagnostics.some(item=>item.code==='production-artifact-development'));assert.ok(!dev.diagnostics.some(item=>item.code==='production-artifact-origin'));
  await writeFile(path.join(root,'built/manifest.json'),'private-action-key-do-not-log');
  const corrupt=await run();assert.ok(corrupt.diagnostics.some(item=>item.code==='production-artifact-unreadable'));assert.doesNotMatch(JSON.stringify(corrupt),/private-action-key-do-not-log/);
});
