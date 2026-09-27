import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appFixture } from './support.mjs';

export async function fontBytes() {
  const require = createRequire(import.meta.url);
  const assets = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/vite/recorder/assets');
  const font = (await readdir(assets)).find(file => /^codicon-.*\.ttf$/.test(file));
  if (!font) throw new Error('Playwright test font is missing');
  return readFile(path.join(assets, font));
}

export async function mockGoogleFonts(run) {
  const bytes = await fontBytes(), requests = [], original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://fonts.googleapis.com/css2?')) {
      requests.push(url);
      return new Response(`/* latin-ext */\n@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url(https://fonts.gstatic.com/s/inter/test-ext.ttf) format('truetype');unicode-range:U+0100-02FF;}\n/* latin */\n@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url(https://fonts.gstatic.com/s/inter/test-latin.ttf) format('truetype');unicode-range:U+0000-00FF,U+EA60-EA7F;}`, { headers: { 'content-type': 'text/css' } });
    }
    if (url.startsWith('https://fonts.gstatic.com/s/inter/test-')) {
      requests.push(url);
      return new Response(bytes, { headers: { 'content-type': 'font/ttf' } });
    }
    return original(input, init);
  };
  try { return await run(requests); }
  finally { globalThis.fetch = original; }
}

export async function fontFixture() {
  const fixture = await appFixture();
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true, force: true });
    await rm(path.join(fixture.root, 'pages'), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources'}`,
      'fonts/local.ttf': await fontBytes(),
      'fonts/shared.js': `import localFont from 'next/font/local';export const body=localFont({src:'./local.ttf',variable:'--font-body',weight:'400',style:'normal',fallback:['Arial']});`,
      'pages/pages.jsx': `import {useState} from 'react';import {body} from '../fonts/shared';import Link from 'next/link';export default function Page(){const [count,setCount]=useState(0);return <main className={body.variable}><p data-testid="font" className={body.className}>\uea60 Font page</p><p data-testid="font-style" style={body.style}>\uea60 Font style</p><p data-testid="variable" style={{fontFamily:'var(--font-body)'}}>\uea60 Variable</p><button onClick={()=>setCount(count+1)}>count {count}</button><Link href="/other">other</Link></main>};export const getServerSideProps=()=>({props:{}});`,
      'pages/other.jsx': `import localFont from 'prnext/font/local';import Link from 'next/link';const other=localFont({src:'../fonts/local.ttf',adjustFontFallback:false,preload:false});export default()=> <main><p data-testid="font" className={other.className}>\uea60 Other font</p><Link href="/pages">pages</Link></main>`,
      'app/layout.jsx': `import {body} from '../fonts/shared';export default({children})=><html><body className={body.variable}>{children}</body></html>`,
      'app/app/page.jsx': `import Probe from '../probe';export default()=> <Probe/>`,
      'app/probe.jsx': `'use client';import {useState} from 'react';import {body} from '../fonts/shared';import {Inter} from 'prnext/font/google';const remote=Inter({subsets:['latin'],variable:'--font-google',axes:['opsz']});export default function Probe(){const [count,setCount]=useState(0);return <main><p data-testid="font" className={body.className}>\uea60 App font</p><p data-testid="font-style" style={body.style}>\uea60 App style</p><p data-testid="google" className={remote.className}>\uea60 Google font</p><p data-testid="variable" style={{fontFamily:'var(--font-body)'}}>\uea60 Variable</p><button onClick={()=>setCount(count+1)}>count {count}</button></main>}`,
    };
    for (const [name, content] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
    return { ...fixture, build: async () => {
      const script = `import {mockGoogleFonts} from ${JSON.stringify(import.meta.url)};import {build} from ${JSON.stringify(new URL('../packages/prnext/build/index.mjs', import.meta.url).href)};const result=await mockGoogleFonts(async requests=>({manifest:await build(process.argv[1]),requests}));console.log(JSON.stringify(result));`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, fixture.root], { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout.trim());
    } };
  } catch (error) { await fixture.remove(); throw error; }
}
