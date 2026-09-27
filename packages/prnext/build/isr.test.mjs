import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from './index.mjs';

async function fixture(files, callback) {
  const root = await mkdtemp(path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.prnext-isr-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Pages builds seed ISR HTML/data pairs, cache policy, and an empty-props fallback shell', async () => {
  await fixture({
    'pages/_app.jsx': `export default function App({Component,pageProps}){return <section data-app="preserved"><Component {...pageProps}/></section>}`,
    'pages/index.jsx': `export const getStaticProps=({revalidateReason})=>({props:{reason:revalidateReason},revalidate:60});export default function Home({reason}){return <h1>{reason}</h1>}`,
    'pages/zero.jsx': `export const getStaticProps=()=>({props:{},revalidate:0});export default function Page(){return <h1>Zero</h1>}`,
    'pages/forever.jsx': `export const getStaticProps=()=>({props:{}});export default function Page(){return <h1>Forever</h1>}`,
    'pages/plain.jsx': `export default function Page(){return <h1>Plain automatic static</h1>}`,
    'pages/server.jsx': `export const getServerSideProps=()=>({props:{}});export default function Page(){return <h1>Server</h1>}`,
    'pages/blog/[id].jsx': `import {appendFileSync} from 'node:fs';import {useRouter} from 'next/router';
      export const getStaticPaths=()=>({paths:['/blog/hello','/blog/missing','/blog/redirect'],fallback:true});
      export const getStaticProps=({params,revalidateReason})=>{
        appendFileSync(new URL('../../calls.txt',import.meta.url),params.id+'\\n');
        if(params.id==='missing')return {notFound:true,revalidate:7};
        if(params.id==='redirect')return {redirect:{destination:'/',permanent:false},revalidate:8};
        return {props:{id:params.id,reason:revalidateReason},revalidate:9};};
      export default function Page({id}){return useRouter().isFallback?<h1>Fallback shell</h1>:<h1>{id}</h1>}`,
  }, async root => {
    // The server bundle lives under the staging directory: its ../../calls.txt is project-local.
    const started = Date.now();
    const result = await build(root);
    const routes = new Map(result.routes.map(route => [route.pattern, route]));
    for (const pattern of ['/', '/zero', '/forever', '/blog/[id]']) assert.equal(routes.get(pattern).ssg, true);
    for (const pattern of ['/plain', '/server']) assert.equal(routes.get(pattern).ssg, undefined);
    const seeds = new Map(result.prerendered.map(seed => [seed.path, seed]));
    assert.equal(seeds.has('/server'), false);
    assert.equal(seeds.get('/plain').dataFile, undefined);
    assert.equal(seeds.get('/plain').revalidate, undefined);
    for (const [pathname, ttl] of [['/', 60], ['/zero', 0], ['/forever', false], ['/blog/hello', 9], ['/blog/missing', 7], ['/blog/redirect', 8]]) {
      const seed = seeds.get(pathname);
      assert.equal(seed.revalidate, ttl);
      assert.ok(seed.generatedAt >= started && seed.generatedAt <= Date.now());
      assert.equal(typeof await readFile(path.join(result.outputDirectory, seed.file), 'utf8'), 'string');
      const data = JSON.parse(await readFile(path.join(result.outputDirectory, seed.dataFile), 'utf8'));
      if (pathname === '/blog/missing') {
        assert.equal(seed.status, 404);
        assert.deepEqual(data, { notFound: true });
      } else {
        assert.equal(data.__N_SSG, true);
        assert.equal(data.__PRNEXT_ROUTER__.isFallback, false);
        if (pathname === '/blog/redirect') {
          assert.equal(seed.status, 307);
          assert.equal(seed.headers.location, '/');
          assert.equal(data.pageProps.__N_REDIRECT, '/');
          assert.equal(data.pageProps.__N_REDIRECT_STATUS, 307);
        } else if (pathname === '/blog/hello') {
          assert.deepEqual(data.pageProps, { id: 'hello', reason: 'build' });
          assert.deepEqual(data.__PRNEXT_ROUTER__.query, { id: 'hello' });
        }
      }
    }
    const dynamic = routes.get('/blog/[id]');
    assert.equal(dynamic.fallback, true);
    const shell = await readFile(path.join(result.outputDirectory, dynamic.fallbackFile), 'utf8');
    assert.match(shell, /Fallback shell/);
    assert.match(shell, /data-app="preserved"/);
    const context = { window: {} };
    vm.runInNewContext(/<script>(window\.__PRNEXT_DATA__=.*?)<\/script>/.exec(shell)[1], context);
    assert.equal(context.window.__PRNEXT_DATA__.router.isFallback, true);
    assert.equal(context.window.__PRNEXT_DATA__.router.pathname, '/blog/[id]');
    assert.equal(context.window.__PRNEXT_DATA__.buildId, result.buildId);
    assert.equal(Object.keys(context.window.__PRNEXT_DATA__.props).length, 0);
    assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'hello\nmissing\nredirect\n');
  });
});

test('invalid static cache policy or fallback values fail without replacing the last build', async () => {
  await fixture({ 'pages/[id].jsx': `export const getStaticPaths=()=>({paths:['/seed'],fallback:true});export const getStaticProps=()=>({props:{},revalidate:1});export default function Page(){return <h1>Page</h1>}` }, async root => {
    const valid = await build(root);
    const manifest = await readFile(path.join(valid.outputDirectory, 'manifest.json'), 'utf8');
    for (const [fallback, revalidate, expected] of [[true, -1, /revalidate/], ['invalid', 1, /fallback/]]) {
      await writeFile(path.join(root, 'pages/[id].jsx'), `export const getStaticPaths=()=>({paths:['/seed'],fallback:${JSON.stringify(fallback)}});export const getStaticProps=()=>({props:{},revalidate:${revalidate}});export default function Page(){return null}`);
      await assert.rejects(build(root), expected);
      assert.equal(await readFile(path.join(valid.outputDirectory, 'manifest.json'), 'utf8'), manifest);
    }
  });
});
