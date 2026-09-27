import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appFixture, repositoryRoot } from './support.mjs';

export async function draftFixture() {
  const fixture = await appFixture();
  let calls = 0;
  const origin = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ count: ++calls })); });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  try {
    for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { force: true, recursive: true });
    const files = {
      'prnext.config.mjs': `export default {basePath:'/docs',generateBuildId:()=> 'draft-tests',headers:async()=>[{source:'/:path*',headers:[{key:'Cache-Control',value:'public, max-age=3600'}]}]};`,
      'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
      'app/content/page.jsx': `import{draftMode}from'next/headers';import{unstable_cache}from'next/cache';import Link from'next/link';const data=unstable_cache(async()=>{const r=await fetch(${JSON.stringify(originUrl)},{cache:'force-cache'});return r.json()},['draft-data']);export default async function Page(){const draft=await draftMode();const value=await data();return <><h1>App draft:{String(draft.isEnabled)}</h1><p id="count">{value.count}</p><Link href="/content">reload content</Link></>}`,
      'app/toggle/route.js': `import{draftMode}from'next/headers';export async function GET(req){const mode=await draftMode();if(new URL(req.url).searchParams.get('enable')==='0')mode.disable();else mode.enable();return Response.json({enabled:mode.isEnabled},{headers:{'cache-control':'public, max-age=3600'}})}`,
      'app/cached/route.js': `import{draftMode}from'next/headers';export const dynamic='force-static';export async function GET(){return Response.json({enabled:(await draftMode()).isEnabled})}`,
      'app/edit/page.jsx': `import{draftMode}from'next/headers';export default async function Page(){async function toggle(){'use server';const mode=await draftMode();if(mode.isEnabled)mode.disable();else mode.enable()}return <><h1>Editor draft:{String((await draftMode()).isEnabled)}</h1><form action={toggle}><button>Toggle draft</button></form></>}`,
      'app/request/page.jsx': `import{connection}from'next/server';let count=0;export default async function Page(){await connection();return <h1>Request:{++count}</h1>}`,
      'pages/page.jsx': `import{useRouter}from'next/router';import Link from'next/link';export default function Page(props){return <><h1>Pages draft:{String(props.draft)}</h1><p id="count">{props.count}</p><p id="router-preview">{String(useRouter().isPreview)}</p><Link href="/page">reload page</Link></>}export async function getStaticProps({draftMode}){const data=await fetch(${JSON.stringify(originUrl)}).then(r=>r.json());return {props:{draft: draftMode,...data},revalidate:false}}`,
      'pages/api/toggle.js': `export default function(req,res){res.setDraftMode({enable:req.query.enable!=='0'});res.json({draft:req.draftMode})}`,
      'pages/api/clear.js': `export default function(req,res){res.clearPreviewData();res.end('cleared')}`,
      'pages/api/preview.js': `export default function(req,res){if(req.query.enable==='1')res.setPreviewData({title:'private preview'},{maxAge:60,path:'/docs'});res.json({preview:req.preview,data:req.previewData})}`,
      'pages/preview.jsx': `export function getStaticProps({preview,previewData}){return{props:{preview,title:previewData?.title||'published'}}}export default({preview,title})=><h1>{title}:{String(preview)}</h1>`,
      'public/robots.txt': 'User-agent: *\n',
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    return { ...fixture, get calls() { return calls; }, async build() {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    }, async remove() { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); } };
  } catch (error) { origin.closeAllConnections(); origin.close(); await fixture.remove(); throw error; }
}
