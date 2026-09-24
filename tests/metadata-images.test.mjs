import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/rustyx/build/index.mjs';
import { appFixture, startServer } from './support.mjs';
import { imagePNG } from './images-fixture.mjs';

test('metadata images and split sitemaps emit scoped tags and native cached routes, including ImageResponse', async () => {
  const fixture = await appFixture();
  let server;
  const put = async (name, content) => { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    await rm(path.join(fixture.root, 'proxy.ts'), { force: true });
    await put('rustyx.config.mjs', `export default{basePath:'/docs'}`);
    await put('app/layout.jsx', `export const metadata={metadataBase:new URL('https://example.com')};export default({children})=><html><body>{children}</body></html>`);
    await put('app/page.jsx', `export default()=> <h1>Image files</h1>`);
    await put('app/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="red"/></svg>');
    await put('app/opengraph-image.png', imagePNG(120, 60));
    await put('app/opengraph-image.alt.txt', 'A & B');
    await put('app/apple-icon.png', imagePNG(48, 48));
    await put('app/(campaign)/campaign/page.jsx', `export default()=> <h1>Campaign</h1>`);
    await put('app/(campaign)/icon.png', imagePNG(32, 32));
    await put('app/blog/page.jsx', `export default()=> <h1>Blog</h1>`);
    await put('app/blog/twitter-image.png', imagePNG(60, 30));
    await put('app/blog/opengraph-image.tsx', `import {ImageResponse} from 'next/og';export const size={width:80,height:40};export const contentType='image/png';export const alt='Generated image';export default()=>new ImageResponse(<div style={{display:'flex',width:80,height:40,background:'red'}}>Hi</div>,size);`);
    await put('app/blog/icon.tsx', `import {ImageResponse} from 'next/og';export function generateImageMetadata(){return[{id:'small',size:{width:24,height:24},contentType:'image/png'},{id:'large',size:{width:48,height:48},contentType:'image/png'}]}export default async({id})=>{const n=(await id)==='small'?24:48;return new ImageResponse(<div style={{display:'flex',width:n,height:n,background:'blue'}}/>,{width:n,height:n})}`);
    await put('app/products/sitemap.ts', `export function generateSitemaps(){return[{id:0},{id:1}]}export default async({id})=>[{url:'https://example.com/products/'+await id}]`);
    const manifest = await build(fixture.root);
    const html = await readFile(path.join(manifest.outputDirectory, manifest.prerendered.find(item => item.path === '/').file), 'utf8');
    assert.match(html, /rel="icon" href="\/docs\/icon.svg\?[a-f0-9]+" sizes="any" type="image\/svg\+xml"/);
    assert.match(html, /property="og:image" content="https:\/\/example.com\/docs\/opengraph-image.png\?/);
    assert.match(html, /property="og:image:width" content="120"/);
    assert.match(html, /property="og:image:alt" content="A &amp; B"/);
    server = await startServer(fixture.root);
    const get = (url, init) => fetch(server.url + '/docs' + url, init);
    const blog = await (await get('/blog')).text();
    assert.match(blog, /property="og:image" content="https:\/\/example.com\/docs\/blog\/opengraph-image"/);
    assert.match(blog, /name="twitter:image" content="https:\/\/example.com\/docs\/blog\/twitter-image.png\?/);
    assert.match(blog, /href="\/docs\/blog\/icon\/small"/);
    assert.match(blog, /sizes="24x24"/);
    const campaign = await (await get('/campaign')).text();
    const groupedIcon = /rel="icon" href="(\/docs\/icon-[a-z0-9]+\.png\?[a-f0-9]+)"/.exec(campaign)?.[1];
    assert.ok(groupedIcon, 'route group metadata has a distinct URL instead of conflicting with root metadata');
    assert.equal((await fetch(server.url + groupedIcon)).status, 200);
    const missing = await get('/missing-page');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /\/docs\/icon.svg\?/);
    for (const [url, width, height] of [['/opengraph-image.png',120,60],['/blog/opengraph-image',80,40],['/blog/icon/small',24,24],['/blog/icon/large',48,48]]) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), width);
      assert.equal(bytes.readUInt32BE(20), height);
      assert.equal((await get(url, { method: 'HEAD' })).status, 200);
    }
    assert.equal((await get('/blog/icon/unknown')).status, 404);
    assert.match(await (await get('/products/sitemap/1.xml')).text(), /example.com\/products\/1/);
    assert.equal((await get('/products/sitemap/2.xml')).status, 404);
    assert.equal((await get('/products/sitemap/1')).status, 404);
    assert.ok(manifest.prerendered.some(item => item.path === '/blog/icon/small'));
    assert.ok(manifest.prerendered.some(item => item.path === '/products/sitemap/1.xml'));
  } finally { await server?.close(); await fixture.remove(); }
});
