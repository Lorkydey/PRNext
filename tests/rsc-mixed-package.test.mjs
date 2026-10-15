import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('mixed npm exports preserve real server React without evaluating unused client hooks', async () => {
  const fixture=await appFixture(); let server;
  try {
    const pkg=path.join(fixture.root,'node_modules/mixed-components');await mkdir(pkg);
    await writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'mixed-components',type:'module',main:'index.js'}));
    await writeFile(path.join(pkg,'index.js'), `import{createElement,useEffect,useState,cache}from'react';export default()=>createElement('h1',null,'server-safe markdown');export function ClientHooks(){useEffect(()=>{},[]);return useState(0)[0]}export const reactCache=cache;`);
    await writeFile(path.join(fixture.root,'app/page.tsx'), `import{cache}from'react';export const dynamic='force-dynamic';export default async()=>{const mod=await import('mixed-components');if(mod.reactCache!==cache)throw new Error('React singleton changed');return <><mod.default/><p>{Object.keys(mod).sort().join(',')}</p></>}`);
    await build(fixture.root);
    server=await startServer(fixture.root);
    const response=await fetch(server.url);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/server-safe markdown/);assert.match(html,/ClientHooks,default,reactCache/);
  } finally {await server?.close();await fixture.remove();}
});
