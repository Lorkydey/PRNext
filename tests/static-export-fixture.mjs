import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { appFixture, repositoryRoot } from './support.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function staticExportFixture() {
  const f = await appFixture();
  try {
    for (const name of ['app', 'pages', 'proxy.ts', 'public', 'components']) await rm(path.join(f.root, name), { recursive: true, force: true });
    const files = {
      'next.config.mjs': `export default {output:'export',trailingSlash:true,images:{unoptimized:true},turbopack:{resolveAlias:{'site-title':'./title.js','site-counter':'./app/counter.jsx'}}}`,
      'title.js': `export default 'Export home'`,
      'app/layout.jsx': `import Counter from 'site-counter';export default({children})=><html><body><Counter/>{children}</body></html>`,
      'app/counter.jsx': `'use client';import{useState}from'react';export default function Counter(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>counter {n}</button>}`,
      'app/page.jsx': `import Link from'next/link';import title from'site-title';export default()=> <main><h1>{title}</h1><Link href='/posts/one'>Post one</Link></main>`,
      'app/posts/[id]/page.jsx': `import Link from'next/link';export function generateStaticParams(){return[{id:'one'},{id:'two'}]}export default async function Page({params}){return <main><h1>Post {(await params).id}</h1><Link href='/'>Home</Link></main>}`,
      'pages/legacy.jsx': `export function getStaticProps(){return{props:{value:'exported props'}}}export default({value})=><h1>{value}</h1>`,
      'public/plain.txt': 'public export',
    };
    for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(f.root, name)), { recursive: true }); await writeFile(path.join(f.root, name), value); }
    return { ...f, build: async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', f.root]);
      return JSON.parse(await readFile(path.join(f.root, '.rustyx/manifest.json'), 'utf8'));
    } };
  } catch (error) { await f.remove(); throw error; }
}
export async function serveStatic(directory) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = path.resolve(directory, '.' + pathname);
      if (!filename.startsWith(path.resolve(directory) + path.sep) && filename !== path.resolve(directory)) throw new Error('path');
      let file;
      for (const candidate of [filename, path.join(filename, 'index.html'), filename + '.html']) {
        try { if ((await stat(candidate)).isFile()) { file = candidate; break; } } catch {}
      }
      if (!file) { response.writeHead(404); response.end('missing'); return; }
      response.setHeader('content-type', ({ '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.txt': 'text/plain', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(400); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
