import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { validateProjectConfig } from './config.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
test('compound pageExtensions compile Pages, App, API and proxy conventions while excluding colocated files', async () => {
  const root = await mkdtemp(path.join(repository, '.rustyx-extensions-'));
  try {
    const files = {
      'next.config.mjs': `export default {pageExtensions:['page.tsx','route.ts']}`,
      'pages/_app.page.tsx': `export default({Component,pageProps})=><><header>Custom App</header><Component {...pageProps}/></>`,
      'pages/index.page.tsx': `import {label} from './helper';export default()=> <h1>{label}</h1>`,
      'pages/helper.ts': `export const label='Custom extension page'`,
      'pages/component.test.tsx': `this is intentionally not valid JavaScript`,
      'pages/api/data.route.ts': `export default(_,res)=>res.json({ok:true})`,
      'app/layout.page.tsx': `export default({children})=><html><body>{children}</body></html>`,
      'app/landing/page.page.tsx': `export default()=> <h1>App custom extension</h1>`,
      'app/ignored/page.tsx': `throw new Error('Unconfigured page compiled')`,
      'app/health/route.route.ts': `export const GET=()=>Response.json({healthy:true})`,
      'proxy.route.ts': `import {NextResponse} from 'next/server';export function proxy(){return NextResponse.next()}export const config={matcher:'/landing'}`,
      'proxy.ts': `throw new Error('Unconfigured proxy compiled')`,
    };
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source);
    }
    const result = await build(root);
    assert.deepEqual(result.routes.filter(route => !route.internal).map(route => route.pattern).sort(), ['/', '/api/data', '/health', '/landing']);
    assert.equal(result.middleware.convention, 'proxy');
    for (const [pathname, expected] of [['/', /Custom extension page/], ['/landing', /App custom extension/]]) {
      const seed = result.prerendered.find(item => item.path === pathname);
      assert.ok(seed);
      assert.match(await readFile(path.join(result.outputDirectory, seed.file), 'utf8'), expected);
    }
    const pages = result.prerendered.find(item => item.path === '/');
    assert.match(await readFile(path.join(result.outputDirectory, pages.file), 'utf8'), /Custom App/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pageExtensions rejects empty or path-containing suffix lists', () => {
  for (const pageExtensions of [[], 'tsx', ['.tsx'], ['../tsx'], [''], [null]]) assert.throws(() => validateProjectConfig({ pageExtensions }), /pageExtensions/);
});
