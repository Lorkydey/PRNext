import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { cacheComponentsFixture } from './cache-components-fixture.mjs';
import { startServer } from './support.mjs';

test('custom cache modules ship with builds, share values between instances and propagate tag/path invalidation', async () => {
  const fixture = await cacheComponentsFixture();
  let first, second;
  try {
    const files = {
      'app/layout.jsx': `import{Suspense}from'react';export default({children})=><html><body><Suspense fallback={<p>Loading</p>}>{children}</Suspense></body></html>`,
      'prnext.config.mjs': `export default {cacheComponents:true,cacheLife:{test:{stale:0,revalidate:30,expire:60}},cacheHandlers:{remote:'./handler.ts',analytics:'./handler.ts'}}`,
      'handler.ts': `import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';import{createHash,randomUUID}from'node:crypto';import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../../.test-shared-cache/',import.meta.url));
const file=(key:string)=>root+createHash('sha256').update(key).digest('hex')+'.json';
async function read(key:string){try{return JSON.parse(await readFile(file(key),'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}}
async function write(key:string,value:unknown){await mkdir(root,{recursive:true});const temporary=file(key)+randomUUID();await writeFile(temporary,JSON.stringify(value));await rename(temporary,file(key))}
async function expiration(tags:string[]){return Math.max(0,...await Promise.all(tags.map(async tag=>await read('tag:'+tag)||0)))}
export default {
async refreshTags(){},getExpiration:expiration,
async get(key:string,softTags:string[]){const value=await read('entry:'+key);if(!value||await expiration([...value.tags,...softTags])>=value.timestamp)return;const bytes=Buffer.from(value.bytes,'base64');return {...value,value:new ReadableStream({start(c){c.enqueue(bytes);c.close()}})}},
async set(key:string,pending:Promise<any>){const entry=await pending;const bytes=Buffer.from(await new Response(entry.value).arrayBuffer()).toString('base64');await write('entry:'+key,{...entry,value:undefined,bytes})},
async updateTags(tags:string[],duration?:{expire?:number}){for(const tag of tags)await write('tag:'+tag,Date.now())}
};`,
      'app/shared/data.ts': `import{randomUUID}from'node:crypto';import{cacheTag,cacheLife}from'next/cache';export async function data(id:string){'use cache: remote';cacheTag('shared:'+id);cacheLife('hours');return {id,value:randomUUID()}}`,
      'app/shared/route.ts': `import{data}from'./data';export async function GET(request){return Response.json(await data(new URL(request.url).searchParams.get('id')||'a'))}`,
      'app/named/route.ts': `import{randomUUID}from'node:crypto';async function data(){'use cache: analytics';return randomUUID()}export async function GET(){return Response.json({value:await data()})}`,
      'app/shared-page/page.jsx': `import{data}from'../shared/data';export default async()=> <p data-testid="shared">{(await data('page')).value}</p>`,
      'app/shared-partial/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import{data}from'../shared/data';async function Visitor(){return <p data-testid="visitor">{(await cookies()).get('name')?.value||'guest'}</p>}export default async()=> <><p data-testid="shared">{(await data('partial')).value}</p><Suspense fallback={<p>Waiting visitor</p>}><Visitor/></Suspense></>`,
      'app/shared-ui/page.jsx': `import{randomUUID}from'node:crypto';import Counter from'../counter';export default async function Page(){'use cache: remote';return <section><p data-testid="shared">{randomUUID()}</p><Counter/></section>}`,
      'app/clear-path/route.ts': `import{revalidatePath}from'next/cache';export async function POST(request){revalidatePath(new URL(request.url).searchParams.get('path')||'/shared');return Response.json({ok:true})}`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    const manifest = await fixture.build();
    assert.ok(manifest.config.cacheHandlers.remote.startsWith('server/'));
    assert.ok(!manifest.prerendered.some(seed => seed.path === '/shared-page'), 'external invalidations must not be hidden behind native HTML cache');
    for (const file of await readdir(path.join(fixture.root, '.prnext/assets'))) if (file.endsWith('.js')) assert.doesNotMatch(await readFile(path.join(fixture.root, '.prnext/assets', file), 'utf8'), /test-shared-cache/);
    // Application source handlers are not needed after compilation.
    await writeFile(path.join(fixture.root, 'handler.ts'), 'throw new Error("source handler should not execute")');
    first = await startServer(fixture.root);
    second = await startServer(fixture.root);
    const get = async (server, route) => { const response = await fetch(server.url + route); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
    const clear = async (server, route) => { const response = await fetch(server.url + route, { method: 'POST' }); assert.equal(response.status, 200, await response.text()); };
    const one = await get(first, '/shared?id=a');
    assert.deepEqual(await get(second, '/shared?id=a'), one);
    assert.notEqual((await get(second, '/shared?id=b')).value, one.value);
    await clear(second, '/clear?tag=shared:a');
    const two = await get(first, '/shared?id=a');
    assert.notEqual(two.value, one.value);
    assert.deepEqual(await get(second, '/shared?id=a'), two);
    await clear(first, '/clear-path?path=/shared');
    assert.notEqual((await get(second, '/shared?id=a')).value, two.value);
    assert.deepEqual(await get(first, '/named'), await get(second, '/named'));
    const page = async server => { const response = await fetch(server.url + '/shared-page'); assert.equal(response.status, 200); return /data-testid="shared">([^<]+)/.exec(await response.text())?.[1]; };
    const original = await page(first); assert.ok(original);
    assert.equal(await page(second), original);
    await clear(second, '/clear?tag=shared:page');
    assert.notEqual(await page(first), original);
    const ui = async server => { const response = await fetch(server.url + '/shared-ui'); assert.equal(response.status, 200); const html = await response.text(); assert.match(html, /Count /); return /data-testid="shared">([^<]+)/.exec(html)?.[1]; };
    const sharedUi = await ui(first); assert.ok(sharedUi);
    assert.equal(await ui(second), sharedUi, 'React cache entries with client references survive transfer between workers');
    const partial = async (server, visitor) => {
      const response = await fetch(server.url + '/shared-partial', { headers: { cookie: 'name=' + visitor } });
      assert.equal(response.headers.get('x-prnext-prerender'), 'partial');
      const html = await response.text();
      assert.match(html, new RegExp('data-testid="visitor">' + visitor + '<'));
      return /data-testid="shared">([^<]+)/.exec(html)?.[1];
    };
    const partialValue = await partial(first, 'First'); assert.ok(partialValue);
    assert.equal(await partial(second, 'Second'), partialValue);
    await clear(second, '/clear?tag=shared:partial');
    const freshPartial = await partial(first, 'AfterInvalidation');
    assert.notEqual(freshPartial, partialValue);
    assert.equal(await partial(second, 'Independent'), freshPartial);
    await first.close(); first = await startServer(fixture.root);
    assert.deepEqual(await get(first, '/named'), await get(second, '/named'), 'external handler survives worker restarts');
  } finally { await first?.close(); await second?.close(); await fixture.remove(); }
});
