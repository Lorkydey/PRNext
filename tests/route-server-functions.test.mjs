import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('Route Handlers call shared server functions without importing the RSC renderer', async () => {
  const fixture=await appFixture(); let server;
  try {
    await mkdir(path.join(fixture.root,'app/invoke'),{recursive:true});
    await writeFile(path.join(fixture.root,'app/shared.ts'), `'use server';import{cookies}from'next/headers';export async function greet(value:string){return 'SERVER_FUNCTION_PRIVATE_VALUE:'+value+':'+((await cookies()).get('user')?.value||'none')}`);
    await writeFile(path.join(fixture.root,'app/client.tsx'), `'use client';import{greet}from'./shared';export default()=> <form action={greet}><button>Action</button></form>`);
    await writeFile(path.join(fixture.root,'app/page.tsx'), `import Client from './client';import{greet}from'./shared';export const dynamic='force-dynamic';export default async()=> <><h1>{await greet('page')}</h1><Client/></>`);
    await writeFile(path.join(fixture.root,'app/invoke/route.ts'), `import{greet}from'../shared';export async function GET(){async function nested(value:string){'use server';const suffix='nested';return value+':'+suffix}return Response.json({value:await greet(await nested('route'))})}`);
    const manifest=await build(fixture.root);
    assert.ok(Object.keys(manifest.app.actions).length>=1);
    for(const file of await readdir(path.join(fixture.root,'.prnext/assets'))) if(file.endsWith('.js')) assert.doesNotMatch(await readFile(path.join(fixture.root,'.prnext/assets',file),'utf8'),/SERVER_FUNCTION_PRIVATE_VALUE/);
    server=await startServer(fixture.root,['--workers','1']);
    const response=await fetch(server.url+'/invoke',{headers:{cookie:'user=alice'}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{value:'SERVER_FUNCTION_PRIVATE_VALUE:route:nested:alice'});
    const page=await fetch(server.url,{headers:{cookie:'user=bob'}});
    assert.equal(page.status,200); assert.match(await page.text(),/SERVER_FUNCTION_PRIVATE_VALUE:page:bob/);
  } finally { await server?.close(); await fixture.remove(); }
});
