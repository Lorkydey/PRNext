import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { imagesFixture } from './images-fixture.mjs';
import { startServer } from './support.mjs';
const endpoint = (server, source, width = 128, quality = 75, alias = '_prnext') => `${server.url}/docs/${alias}/image?${new URLSearchParams({url: source, w: width, q: quality})}`;

test('native image optimization: transforms, persistence, input policy and imports', async t => {
  const fixture = await imagesFixture(); let server;
  try {
    const manifest = await fixture.build(); server = await startServer(fixture.root, ['--workers', '1']);
    await t.test('static imports emit dimensions, blur and shared real assets in both routers', async () => {
      const files = await readdir(path.join(fixture.root, '.prnext/assets')); assert.equal(files.filter(name => /^image-.*\.png$/.test(name)).length, 1);
      for (const route of ['/gallery', '/gallery-app']) { const response = await fetch(server.url + '/docs' + route); const html = await response.text(); assert.equal(response.status, 200, html); assert.match(html, /data:image\/webp;base64/); assert.match(html, /width="160" height="80"/); assert.match(html, /\/docs\/_prnext\/image\?url=/); }
      assert.equal(manifest.config.images.path, '/docs/_prnext/image');
    });
    await t.test('WebP and AVIF negotiate real output with conditional requests and HEAD', async () => {
      const url = endpoint(server, '/docs/photo.png');
      for (const mime of ['image/webp', 'image/avif']) { const response = await fetch(url, {headers:{accept:mime}}); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),mime); assert.equal(response.headers.get('vary'),'Accept'); assert.match(response.headers.get('content-disposition'),/^attachment;/); assert.ok(bytes.length<fixture.photo.length); if(mime==='image/webp')assert.equal(bytes.toString('ascii',8,12),'WEBP');else assert.match(bytes.toString('ascii',4,40),/ftypavif/);
        const again = await fetch(url,{headers:{accept:mime,'if-none-match':response.headers.get('etag')}});assert.equal(again.status,304);assert.equal(again.headers.get('x-nextjs-cache'),'HIT');
        const head = await fetch(url,{method:'HEAD',headers:{accept:mime}});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);
      }
      const alias = await fetch(endpoint(server,'/docs/photo.png',128,75,'_next'),{headers:{accept:'image/webp'}});assert.equal(alias.status,200);assert.equal(alias.headers.get('x-nextjs-cache'),'HIT');await alias.arrayBuffer();
    });
    await t.test('remote misses coalesce, preserve upstream TTL and do not forward browser secrets', async () => {
      const source = fixture.originURL + '/allowed/coalesced'; const release = fixture.hold('/allowed/coalesced');
      const requests = Array.from({length:8},()=>fetch(endpoint(server,source),{headers:{accept:'image/webp',cookie:'secret=private',authorization:'Bearer private'}}));
      await new Promise(resolve=>setTimeout(resolve,100));release();const responses=await Promise.all(requests);await Promise.all(responses.map(response=>response.arrayBuffer()));assert.equal(fixture.counts.get('/allowed/coalesced'),1);assert.ok(responses.every(response=>response.status===200));
      const upstream=fixture.seen.find(item=>item.path==='/allowed/coalesced');assert.equal(upstream.headers.cookie,undefined);assert.equal(upstream.headers.authorization,undefined);
      await server.close();server=await startServer(fixture.root,['--workers','1']);const response=await fetch(endpoint(server,source),{headers:{accept:'image/webp'}});assert.equal(response.headers.get('x-nextjs-cache'),'HIT');await response.arrayBuffer();assert.equal(fixture.counts.get('/allowed/coalesced'),1);
    });
    await t.test('rejects invalid widths, qualities, recursion, source formats, bounds and unlisted hosts', async () => {
      const sources=[fixture.originURL+'/denied/photo.png',fixture.originURL+'/allowed/large',fixture.originURL+'/allowed/invalid',fixture.originURL+'/allowed/loop','/docs/vector.svg','/docs/_prnext/image?url=x','//evil.example/photo'];
      for(const source of sources){const response=await fetch(endpoint(server,source));assert.equal(response.status,400,source+': '+await response.text());}
      for(const url of [endpoint(server,'/docs/photo.png',123),endpoint(server,'/docs/photo.png',128,80),endpoint(server,'/docs/photo.png')+'&w=128']){const response=await fetch(url);assert.equal(response.status,400);await response.text();}
      const method=await fetch(endpoint(server,'/docs/photo.png'),{method:'POST'});assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'GET, HEAD');
      const redirected=await fetch(endpoint(server,fixture.originURL+'/allowed/redirect'),{headers:{accept:'image/webp'}});assert.equal(redirected.status,200);await redirected.arrayBuffer();
    });
    await t.test('dynamic local sources use normal routing while private remote addresses are denied by default', async () => {
      const response=await fetch(endpoint(server,'/docs/api/photo'),{headers:{accept:'image/webp'}});assert.equal(response.status,200,await response.clone().text());await response.arrayBuffer();
      await server.close();const file=path.join(fixture.root,'.prnext/manifest.json');const config=JSON.parse(await readFile(file,'utf8'));config.config.images.dangerouslyAllowLocalIP=false;await writeFile(file,JSON.stringify(config));server=await startServer(fixture.root,['--workers','1']);
      const denied=await fetch(endpoint(server,fixture.originURL+'/allowed/private-fresh'));assert.equal(denied.status,400);assert.match(await denied.text(),/private or reserved/);
    });
  } finally {await server?.close();await fixture.remove();}
});
