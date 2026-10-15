import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanProject } from './scan.mjs';
import { mergeAppConfig, validateAppConfig, appConfigCacheStats } from './app-config.mjs';

test('maxDuration is inherited, overridden and bounded instead of silently ignored', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-duration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'route.js');
  await writeFile(file, 'export const maxDuration=60');
  assert.equal((await validateAppConfig(file)).maxDuration, 60);
  assert.equal(mergeAppConfig([{ maxDuration: 60 }, {}, { maxDuration: 120 }]).maxDuration, 120);
  for (const value of ['0', '-1', '301', '1.5', '"60"']) {
    await writeFile(file, `export const maxDuration=${value}`);
    await assert.rejects(validateAppConfig(file), /maxDuration/);
  }
});

test('duplicate App conventions use configured Next extension precedence, and warn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-extension-priority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/layout.jsx'), 'export default({children})=><html><body>{children}</body></html>');
  await writeFile(path.join(root, 'app/page.js'), 'export const maxDuration="invalid-unselected";export default()=>null');
  await writeFile(path.join(root, 'app/page.jsx'), 'export default()=>null');
  const warnings = [], previous = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const project = await scanProject(root);
    assert.ok(project.routes.find(route => route.pattern === '/').file.endsWith('page.jsx'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pageExtensions/);
    await writeFile(path.join(root, 'app/page.js'), 'export default()=>null');
    const reversed = await scanProject(root, { pageExtensions: ['js', 'jsx'] });
    assert.ok(reversed.routes.find(route => route.pattern === '/').file.endsWith('page.js'));
  } finally { console.warn = previous; }
});

test('App config parsing reuses bounded results and invalidates equal-size edits with unchanged timestamps', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-config-cache-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file = path.join(root,'page.jsx');
  await writeFile(file, 'export const instant={level:"warning"};export const revalidate=10');
  const stamp = await stat(file), before = appConfigCacheStats();
  await validateAppConfig(file);
  const first = await validateAppConfig(file);first.instant.level='corrupted';
  assert.equal((await validateAppConfig(file)).instant.level,'warning');
  assert.equal(appConfigCacheStats().hits,before.hits+2);
  await writeFile(file, 'export const instant={level:"warning"};export const revalidate=20');
  await utimes(file,stamp.atime,stamp.mtime);
  assert.equal((await validateAppConfig(file)).revalidate,20);
  await writeFile(file,'export const revalidate=-1');
  await assert.rejects(validateAppConfig(file), /revalidate/);
  await writeFile(file,'export const revalidate=30');
  assert.equal((await validateAppConfig(file)).revalidate,30);
  for (let index=0;index<260;index++) {
    const item=path.join(root,`${index}.js`);await writeFile(item,'export const revalidate=30');await validateAppConfig(item);
  }
  assert.ok(appConfigCacheStats().entries<=256);
  assert.ok(appConfigCacheStats().bytes<=1024*1024);
});

test('App scanning rejects unsupported route configuration before producing a misleading build', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-app-config-'));
  try {
    await mkdir(path.join(root, 'app'));
    for (const source of [
      "export const runtime='unknown'", "export const dynamic='unknown'", 'export const revalidate=1.5',
      'export const instant=1', 'export const instant={prefetch:true}', 'export const dynamicParams=1', 'export const revalidate=60*10',
      "const mode='unknown'; export {mode as runtime}", "export {runtime} from './options'", 'export const maxDuration=301',
    ]) {
      await writeFile(path.join(root, 'app/route.ts'), `${source}; export const GET=()=>new Response('ok')`);
      await assert.rejects(scanProject(root), /App Router export .*not supported with this value/);
    }
    await writeFile(path.join(root, 'app/route.ts'), `export const runtime='nodejs' as const;
      export const dynamic='force-dynamic'; export const revalidate=0; export const dynamicParams=true;
      export const fetchCache='force-no-store'; export const GET=()=>new Response('ok');`);
    const configured = (await scanProject(root)).routes[0];
    assert.equal(configured.pattern, '/');
    assert.deepEqual(configured.cacheConfig, { dynamic: 'force-dynamic', revalidate: 0, dynamicParams: true, fetchCache: 'force-no-store', forceNoStore: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Route Handler descriptors preserve explicit static opt-in without inheriting layout policy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-handler-config-'));
  try {
    await mkdir(path.join(root, 'app/plain'), { recursive: true });
    await mkdir(path.join(root, 'app/[id]'), { recursive: true });
    await writeFile(path.join(root, 'app/layout.tsx'), `export const dynamic='force-dynamic';export const revalidate=2;export default({children})=>children`);
    await writeFile(path.join(root, 'app/plain/route.ts'), 'export const GET=()=>new Response("ok")');
    const handler = path.join(root, 'app/[id]/route.ts');
    await writeFile(handler, `export const revalidate=false;export const dynamicParams=false;
      export const generateStaticParams=()=>[{id:'one'}];export const GET=()=>new Response('ok')`);
    const { routes } = await scanProject(root);
    assert.deepEqual(routes.find(route => route.pattern === '/plain').handlerConfig, {});
    const configured = routes.find(route => route.pattern === '/[id]');
    assert.deepEqual(configured.handlerConfig, { revalidate: false, dynamicParams: false, generateStaticParams: true });
    assert.equal(configured.cacheConfig.dynamic, 'auto');
    assert.equal(configured.cacheConfig.revalidate, false);
    assert.equal(configured.segments, undefined);
    for (const source of ["export const dynamic='force-static'", "export const dynamic='error'", 'export const revalidate=60']) {
      await writeFile(handler, `${source};export const GET=()=>new Response('ok')`);
      await assert.doesNotReject(scanProject(root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dynamic layouts carry their fetch policy to child pages without changing separate route handlers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-cache-config-'));
  try {
    await mkdir(path.join(root, 'app/child/api'), { recursive: true });
    await writeFile(path.join(root, 'app/layout.tsx'), `export const dynamic='force-dynamic';export default ({children})=><html><body>{children}</body></html>`);
    await writeFile(path.join(root, 'app/child/page.tsx'), 'export default()=>null');
    await writeFile(path.join(root, 'app/child/api/route.ts'), 'export const GET=()=>new Response("ok")');
    const { routes } = await scanProject(root);
    assert.equal(routes.find(route => route.kind === 'page').cacheConfig.forceNoStore, true);
    assert.equal(routes.find(route => route.kind === 'api').cacheConfig.forceNoStore, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('App static config is literal, keeps generator scopes, and uses the shortest route TTL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-static-config-'));
  try {
    await mkdir(path.join(root, 'app/[team]/[item]'), { recursive: true });
    await writeFile(path.join(root, 'app/layout.tsx'), `export const revalidate=60;export default ({children})=><html><body>{children}</body></html>`);
    await writeFile(path.join(root, 'app/[team]/layout.tsx'), `export const revalidate=15;export const dynamicParams=false;export const generateStaticParams=()=>[{team:'one'}];export default ({children})=>children`);
    const page = path.join(root, 'app/[team]/[item]/page.tsx');
    await writeFile(page, `export const dynamic='force-static';export const revalidate=30;export const generateStaticParams=()=>[{item:'two'}];export default()=>null`);
    const route = (await scanProject(root)).routes[0];
    assert.deepEqual(route.cacheConfig, { dynamic: 'force-static', revalidate: 15, dynamicParams: false, fetchCache: 'auto', forceNoStore: false });
    assert.equal(route.pageConfig.generateStaticParams, true);
    assert.equal(route.segments[1].staticConfig.dynamicParams, false);
    for (const value of ['-1', '1.5', '60 * 10', 'NaN']) {
      await writeFile(page, `export const revalidate=${value};export default()=>null`);
      await assert.rejects(scanProject(root), /revalidate.*not supported with this value/);
    }
    await writeFile(page, `'use client';export const generateStaticParams=()=>[];export default()=>null`);
    await assert.rejects(scanProject(root), /generateStaticParams.*Client Component/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('App segment cache guarantees reject incompatible dynamic and fetch policies', () => {
  assert.equal(mergeAppConfig([{fetchCache:'force-cache'}, {fetchCache:'only-cache'}]).fetchCache, 'force-cache');
  assert.equal(mergeAppConfig([{fetchCache:'only-cache'}, {fetchCache:'auto'}]).fetchCache, 'only-cache');
  assert.equal(mergeAppConfig([{fetchCache:'only-no-store'}, {fetchCache:'auto'}]).fetchCache, 'only-no-store');
  assert.throws(() => mergeAppConfig([{fetchCache:'force-cache'}, {dynamic:'force-dynamic'}]), /Incompatible/);
  assert.throws(() => mergeAppConfig([{fetchCache:'only-cache'}, {fetchCache:'only-no-store'}]), /Incompatible/);
  assert.throws(() => mergeAppConfig([{fetchCache:'default-no-store'}, {fetchCache:'default-cache'}]), /Incompatible/);
  assert.equal(mergeAppConfig([{ instant: true }, { instant: false }]).instant, true);
  assert.equal(mergeAppConfig([{ instant: false }, { instant: true }]).instant, false);
  assert.throws(() => mergeAppConfig([{ dynamic: 'error' }, { revalidate: 0 }]), /Incompatible.*dynamic='error'/);
  assert.throws(() => mergeAppConfig([{ dynamic: 'error', fetchCache: 'force-no-store' }]), /Incompatible/);
  assert.throws(() => mergeAppConfig([{ fetchCache: 'default-no-store' }, { fetchCache: 'auto' }]), /Incompatible/);
  assert.equal(mergeAppConfig([{ dynamic: 'force-dynamic' }, { dynamic: 'force-static' }]).dynamic, 'force-dynamic');
  assert.equal(mergeAppConfig([{ dynamic: 'force-static' }, { dynamic: 'auto' }]).dynamic, 'auto');
});

test('instant accepts documented objects and rejects silent option loss or Client Component exports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-instant-config-'));
  try {
    await mkdir(path.join(root, 'app'));
    const page = path.join(root, 'app/page.tsx');
    await writeFile(path.join(root, 'app/layout.tsx'), `export default({children})=><html><body>{children}</body></html>`);
    await writeFile(page, `export const instant={level:'warning'} as const;export default()=>null`);
    assert.deepEqual((await scanProject(root)).routes[0].cacheConfig.instant, { level: 'warning' });
    for (const config of ["{level:'error'}", "{unstable_disableValidation:false}", "{level:'warning',typo:true}", "{unstable_samples:[]}"]) {
      await writeFile(page, `export const instant=${config};export default()=>null`);
      await assert.rejects(scanProject(root), /instant.*not supported/);
    }
    await writeFile(page, `'use client';export const instant={level:'warning'};export default()=>null`);
    await assert.rejects(scanProject(root), /instant.*Client Component/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
