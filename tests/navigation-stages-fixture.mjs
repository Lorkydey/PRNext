import { appFixture, repositoryRoot } from './support.mjs';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export async function navigationStagesFixture(options) {
  const fixture = await appFixture(options), counts = new Map();
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://local').pathname.slice(1);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (key === 'navigation') await new Promise(resolve => setTimeout(resolve, 500));
    response.end(key);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${origin.address().port}`;
  try {
    for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const content = `import{Suspense}from'react';import{cookies}from'next/headers';import{navigation,prefetch,cacheLife}from'next/cache';async function Read(stage){'use cache: private';cacheLife('minutes');return(await fetch(${JSON.stringify(address)}+'/'+stage,{cache:'no-store'})).text()}async function Part({stage}){if(stage==='prefetch')await prefetch();if(stage==='navigation')await navigation();const tenant=(await cookies()).get('tenant')?.value||'public';const text=await Read(stage);return <p data-testid={stage}>{text+':'+tenant}</p>}export default()=> <main><h1>Navigation stages</h1>{['shell','prefetch','navigation'].map(stage=><Suspense key={stage} fallback={<p>Waiting {stage}</p>}><Part stage={stage}/></Suspense>)}</main>`;
    const files = {
      'prnext.config.mjs': `export default {cacheComponents:true,partialPrefetching:true}`,
      'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx': `import Links from './links';export default()=> <><h1>Start</h1><Links/></>`,
      'app/links.jsx': `'use client';import Link from 'next/link';import{useRouter}from'next/navigation';import{useEffect}from'react';export default function Links(){const router=useRouter();useEffect(()=>{window.__stagesRouter=router},[router]);return <Link href="/stages" prefetch={true}>Open stages</Link>}`,
      'app/stages/page.jsx': content,
      'app/ensure-shell/page.jsx': `export const ensureStatic='shell';${content}`,
      'app/ensure-prefetch/page.jsx': `export const ensureStatic='prefetch';${content}`,
      'app/static/page.jsx': `import{navigation,prefetch}from'next/cache';export const ensureStatic='navigation';export default async()=>{await prefetch();await navigation();return <h1>Fully static gates</h1>}`,
    };
    const write = async (name, source) => { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); };
    for (const [name, source] of Object.entries(files)) await write(name, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    return { ...fixture, write, build, counts, reset: () => counts.clear(), remove: async () => { await new Promise(resolve => origin.close(resolve)); await fixture.remove(); } };
  } catch (error) { await new Promise(resolve => origin.close(resolve)); await fixture.remove(); throw error; }
}
