import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {frameworkImportName, frameworkImportPattern} from './framework-imports.mjs';
import {validateTurbopack, validateWebpackResolution} from './module-resolution.mjs';
import {validateProjectConfig} from './config.mjs';
import {transformDynamicImports} from './dynamic.mjs';
import {build} from './index.mjs';
import {fontBytes} from '../../../tests/font-fixture.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(t, files) {
  const root = await mkdtemp(path.join(repo, '.prnext-scoped-imports-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), {recursive: true});
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test('scoped framework imports preserve subpaths and cannot bypass framework alias restrictions', () => {
  for (const prefix of ['next', 'prnext', '@thomas.f/prnext']) {
    assert.equal(frameworkImportName(`${prefix}/compat/router.js`), 'compat/router');
    assert.equal(frameworkImportName(`${prefix}/dist/shared/lib/router-context.shared-runtime`), 'next-router-context');
    for (const name of [prefix, `${prefix}/headers`]) {
      assert.ok(frameworkImportPattern.test(name));
      assert.throws(() => validateTurbopack({resolveAlias: {[name]: './replacement'}}), /framework aliases/);
      assert.throws(() => validateWebpackResolution({alias: {[name + '$']: false}}), /alias key/);
    }
    for (const key of ['transpilePackages', 'serverExternalPackages']) {
      assert.throws(() => validateProjectConfig({[key]: [prefix]}), /excluding framework/);
    }
  }
  for (const name of ['@thomas.f/prnext-other', '@other/prnext', '@thomasXf/prnext']) {
    assert.equal(frameworkImportPattern.test(name), false);
    assert.doesNotThrow(() => validateTurbopack({resolveAlias: {[name]: './replacement'}}));
  }
});

test('scoped dynamic imports receive hydration identities and erase ssr:false loaders', () => {
  for (const binding of [
    "import dynamic from '@thomas.f/prnext/dynamic';",
    "const dynamic=require('@thomas.f/prnext/dynamic.js');",
  ]) {
    const source = `${binding}const Browser=dynamic(()=>import('./browser'),{ssr:false});`;
    const options = {projectRoot: '/project'};
    const browser = transformDynamicImports(source, '/project/page.jsx', options);
    const server = transformDynamicImports(source, '/project/page.jsx', {...options, mode: 'server'});
    assert.match(browser, /dynamic-[a-f\d]{20}/);
    assert.match(browser, /import\(['"]\.\/browser/);
    assert.doesNotMatch(server, /import\(['"]\.\/browser/);
    assert.throws(() => transformDynamicImports(source, '/project/page.jsx', {...options, mode: 'rsc'}), /Server Component/);
  }
});

test('scoped package compiles Pages, App, npm imports, fonts, Edge, proxy and cache handlers', async t => {
  const root = await fixture(t, {
    'next.config.mjs': "import {PHASE_PRODUCTION_BUILD} from '@thomas.f/prnext/constants';export default phase=>({env:{SCOPED_PHASE:String(phase===PHASE_PRODUCTION_BUILD)},cacheHandlers:{custom:'./handler.js'}});",
    'handler.js': "import {revalidatePath} from '@thomas.f/prnext/cache';export default {get(){return null},set(){},revalidateTag:revalidatePath};",
    'proxy.js': "import {NextResponse} from '@thomas.f/prnext/server';export function proxy(){const response=NextResponse.next();response.headers.set('x-scoped-proxy','yes');return response}",
    'fonts/local.ttf': await fontBytes(),
    'pages/legacy.jsx': "import Link from '@thomas.f/prnext/link';import OldLink from 'prnext/link';import NextLink from 'next/link';import dynamic from '@thomas.f/prnext/dynamic';import font from '@thomas.f/prnext/font/local';import {Widget} from 'scoped-widget';const local=font({src:'../fonts/local.ttf',adjustFontFallback:false});const Lazy=dynamic(()=>import('../part'));export default function Page(){return <main className={local.className}><Link href='/app'>Scoped link</Link><OldLink href='/app'>Legacy alias</OldLink><NextLink href='/app'>Next alias</NextLink><Widget/><Lazy/><p>{process.env.SCOPED_PHASE}</p></main>}",
    'part.jsx': "export default function Part(){return <p>Scoped dynamic content</p>}",
    'node_modules/scoped-widget/package.json': '{"name":"scoped-widget","main":"index.js"}',
    'node_modules/scoped-widget/index.js': "const React=require('react');const Link=require('@thomas.f/prnext/link');exports.Widget=()=>React.createElement(Link,{href:'/app'},'Scoped npm widget');",
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/app/page.jsx': "import Link from '@thomas.f/prnext/link';import Client from './client';export default function Page(){return <main><h1>Scoped App page</h1><Link href='/legacy'>Pages</Link><Client/></main>}",
    'app/app/client.jsx': "'use client';import {usePathname} from '@thomas.f/prnext/navigation';export default function Client(){return <p>Path: {usePathname()}</p>}",
    'app/edge/route.js': "import {NextResponse} from '@thomas.f/prnext/server';export const runtime='edge';export function GET(request){return NextResponse.json({scoped:new URL(request.url).searchParams.get('value')})}",
  });
  const built = await build(root);
  const html = async route => {
    const entry = built.prerendered.find(entry => entry.path === route);
    assert.ok(entry, `${route} was prerendered`);
    return readFile(path.join(built.outputDirectory, entry.file), 'utf8');
  };
  assert.match(await html('/legacy'), /Scoped link.*Legacy alias.*Next alias.*Scoped npm widget.*Scoped dynamic content.*true/s);
  assert.match(await html('/app'), /Scoped App page.*Path:.*\/app/s);
  const appSeed = built.prerendered.find(entry => entry.path === '/app');
  assert.match(await readFile(path.join(built.outputDirectory, appSeed.dataFile), 'utf8'), /Scoped App page/);
  assert.ok((await readdir(path.join(built.outputDirectory, 'assets'))).some(name => /^font-.*\.ttf$/.test(name)));
  const load = file => import(pathToFileURL(path.join(built.outputDirectory, file)).href);
  const edge = await load(built.routes.find(route => route.pattern === '/edge').module);
  assert.deepEqual(await (await edge.GET(new Request('https://example.test/edge?value=42'))).json(), {scoped: '42'});
  const proxy = await load(built.middleware.module);
  assert.equal(proxy.proxy().headers.get('x-scoped-proxy'), 'yes');
  const handler = await load('server/cache-handler-custom.mjs');
  assert.equal(handler.default.get(), null);
  assert.equal(typeof handler.default.revalidateTag, 'function');
});

test('scoped server imports still fail when reached from a Client Component', async t => {
  const root = await fixture(t, {
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.jsx': "'use client';import {headers} from '@thomas.f/prnext/headers';export default function Page(){return <p>{String(headers())}</p>}",
  });
  await assert.rejects(build(root), /server-only.*Client Component/);
});
