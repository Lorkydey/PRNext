import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function dynamicFixture() {
  const fixture = await appFixture();
  const counts = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://origin').pathname.slice(1);
    counts.set(key, (counts.get(key) || 0) + 1);
    await gates.get(key)?.promise;
    if (!response.destroyed) response.end(key);
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const write = async (name, source) => {
    const filename = path.join(fixture.root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  };
  try {
    for (const name of ['app', 'pages', 'components']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    await rm(path.join(fixture.root, 'proxy.ts'), { force: true });
    const files = {
      'prnext.config.mjs': 'export default {compress:true}',
      'app/layout.jsx': `import Shell from '../components/Shell';export default function Layout({children}){return <html><body><Shell/>{children}</body></html>}`,
      'components/Shell.jsx': `'use client';import{useState}from'react';import Link from'next/link';export default function Shell(){const[n,setN]=useState(0);return <><button data-testid="layout-count" onClick={()=>setN(n+1)}>layout {n}</button><Link href="/app-dynamic" data-testid="to-dynamic">Dynamic</Link><Link href="/app-other" data-testid="to-other">Other</Link></>}`,
      'app/page.jsx': `export default function Page(){return <h1>Dynamic fixture</h1>}`,
      'app/app-other/page.jsx': `export default function Page(){return <h1>Other application page</h1>}`,
      'app/app-dynamic/page.jsx': `import Shelf from '../../components/AppShelf';export const dynamic='force-dynamic';export default function Page(){return <><h1>App dynamic page</h1><Shelf/></>}`,
      'components/AppShelf.jsx': `'use client';import dynamic from'next/dynamic';import{useState}from'react';
        const Initial=dynamic(()=>import('./AppInitial'),{loading:()=> <p data-testid="app-initial-loading">Initial loading</p>});
        const Conditional=dynamic(()=>import('./AppConditional').then(module=>module.Named),{loading:()=> <p data-testid="app-conditional-loading">Conditional loading</p>});
        const Browser=dynamic(()=>import('dynamic-browser-package'),{ssr:false,loading:()=> <p data-testid="app-browser-loading">Browser loading</p>});
        export default function Shelf(){const[show,setShow]=useState(false);return <><Initial/><button data-testid="show-app" onClick={()=>setShow(true)}>Show application widget</button>{show&&<Conditional label="app"/>}<Browser label="app"/></>}`,
      'components/AppInitial.jsx': `'use client';import{useState}from'react';export default function Initial(){const[n,setN]=useState(0);return <button data-testid="app-initial-count" onClick={()=>setN(n+1)}>APP_DYNAMIC_INITIAL count {n}</button>}`,
      'components/AppConditional.jsx': `'use client';import{useState}from'react';import styles from'./conditional.module.css';if(typeof window!=='undefined')window.__appConditional=(window.__appConditional||0)+1;export function Named({label}){const[n,setN]=useState(0);return <button className={styles.widget} data-testid="app-conditional-count" onClick={()=>setN(n+1)}>APP_DYNAMIC_CONDITIONAL {label} {n}</button>}`,
      'components/conditional.module.css': '.widget { color: rgb(13, 47, 91); border: 3px solid rgb(91, 47, 13); }',
      'node_modules/dynamic-browser-package/package.json': JSON.stringify({ name: 'dynamic-browser-package', type: 'module', main: 'index.jsx' }),
      'node_modules/dynamic-browser-package/index.jsx': `import{useState}from'react';const host=window.location.hostname;window.__browserDynamic=(window.__browserDynamic||0)+1;export default function Browser({label}){const[n,setN]=useState(0);return <button data-testid={label+'-browser-count'} onClick={()=>setN(n+1)}>BROWSER_DYNAMIC_ONLY {host} {label} {n}</button>}`,
      'pages/dynamic-pages.jsx': `import dynamic from'next/dynamic';import{useState}from'react';
        const Initial=dynamic(()=>import('../components/PagesInitial'));
        const Conditional=dynamic(()=>import('../components/PagesConditional').then(module=>module.Named),{delay:0,loading:()=> <p data-testid="pages-conditional-loading">Pages widget loading</p>});
        const Browser=dynamic(()=>import('dynamic-browser-package'),{ssr:false,loading:()=> <p data-testid="pages-browser-loading">Pages browser loading</p>});
        export const getServerSideProps=({query})=>({props:{name:query.name||'visitor'}});
        export default function Page({name}){const[show,setShow]=useState(false);return <><h1>Pages dynamic {name}</h1><Initial name={name}/><button data-testid="show-pages" onClick={()=>setShow(true)}>Show Pages widget</button>{show&&<Conditional label={name}/>}<Browser label="pages"/></>}`,
      'components/PagesInitial.jsx': `import{useState}from'react';export default function Initial({name}){const[n,setN]=useState(0);return <button data-testid="pages-initial-count" onClick={()=>setN(n+1)}>PAGES_DYNAMIC_INITIAL {name} {n}</button>}`,
      'components/PagesConditional.jsx': `import{useState}from'react';import styles from'./conditional.module.css';if(typeof window!=='undefined')window.__pagesConditional=(window.__pagesConditional||0)+1;export function Named({label}){const[n,setN]=useState(0);return <button className={styles.widget} data-testid="pages-conditional-count" onClick={()=>setN(n+1)}>PAGES_DYNAMIC_CONDITIONAL {label} {n}</button>}`,
      'pages/dynamic-static.jsx': `import dynamic from'prnext/dynamic';const Widget=dynamic({loader:()=>import('../components/PagesInitial')});export function getStaticProps(){return{props:{name:'static'}}}export default function Page({name}){return <Widget name={name}/ >}`,
      'pages/dynamic-nested.jsx': `import dynamic from'next/dynamic';const Outer=dynamic(()=>import('../components/PagesOuter'));export default function Page(){return <Outer/>}`,
      'components/PagesOuter.jsx': `import dynamic from'next/dynamic';const Inner=dynamic(()=>import('./PagesInitial'));export default function Outer(){return <section data-testid="nested-dynamic"><Inner name="nested"/></section>}`,
      'app/server-dynamic/page.jsx': `import load from'next/dynamic';import{Suspense}from'react';const Server=load(()=>import('../../components/ServerWidget'));export const dynamic='force-dynamic';export default function Page(){return <><h1>Server dynamic shell</h1><Suspense fallback={<p data-testid="server-dynamic-loading">Server widget loading</p>}><Server/></Suspense></>}`,
      'components/ServerWidget.jsx': `import 'server-only';import{headers}from'next/headers';import Inner from './ServerClient';await fetch(${JSON.stringify(originUrl + '/server-module')},{cache:'no-store'});const privateValue='APP_DYNAMIC_SERVER_SECRET';export default async function Server(){const header=(await headers()).get('x-dynamic')||'none';return <section data-testid="server-dynamic-result" data-private-length={privateValue.length}><h2>Server module ready</h2><p data-testid="dynamic-header">{header}</p><Inner/></section>}`,
      'components/ServerClient.jsx': `'use client';import{useState}from'react';export default function Inner(){const[n,setN]=useState(0);return <button data-testid="server-client-count" onClick={()=>setN(n+1)}>server child {n}</button>}`,
      'app/server-client-dynamic/page.jsx': `import load from'prnext/dynamic';const Client=load(()=>import('../../components/AppInitial'));export const dynamic='force-dynamic';export default function Page(){return <><h1>Server imports client dynamically</h1><Client/></>}`,
      'app/dynamic-error/page.jsx': `import ErrorShelf from '../../components/ErrorShelf';export const dynamic='force-dynamic';export default function Page(){return <ErrorShelf/>}`,
      'app/dynamic-error/error.jsx': `'use client';export default function Error({error}){return <p data-testid="dynamic-error-boundary">Dynamic module error: {error.message}</p>}`,
      'components/ErrorShelf.jsx': `'use client';import dynamic from'next/dynamic';import{useState}from'react';const Broken=dynamic(()=>import('./BrokenWidget'));export default function Shelf(){const[show,setShow]=useState(false);return <><button data-testid="load-broken" onClick={()=>setShow(true)}>Load broken widget</button>{show&&<Broken/>}</>}`,
      'components/BrokenWidget.jsx': `'use client';throw new Error('DYNAMIC_CHUNK_IMPORT_FAILURE');export default function Broken(){return <p>unreachable dynamic component</p>}`,
      'app/dynamic-ssr-error/error.jsx': `'use client';export default function Error({error}){return <p data-testid="dynamic-ssr-error-boundary">Dynamic SSR error: {error.message}</p>}`,
      'components/RejectingDynamic.jsx': `'use client';import dynamic from'next/dynamic';const reject=()=>Promise.reject(new Error('DYNAMIC_SSR_LOAD_FAILURE'));export const WithLoading=dynamic(reject,{loading:()=> <p data-testid="dynamic-ssr-loading">Loading failed widget</p>});export const WithoutLoading=dynamic(reject);`,
      'app/dynamic-ssr-error/loading/page.jsx': `import{WithLoading}from'../../../components/RejectingDynamic';export const dynamic='force-dynamic';export default function Page(){return <><h1>Recoverable dynamic shell</h1><WithLoading/><p>Dynamic page tail</p></>}`,
      'app/dynamic-ssr-error/suspense/page.jsx': `import{Suspense}from'react';import{WithoutLoading}from'../../../components/RejectingDynamic';export const dynamic='force-dynamic';export default function Page(){return <><h1>Recoverable dynamic shell</h1><Suspense fallback={<p data-testid="dynamic-ssr-outer-loading">Outer failed widget loading</p>}><WithoutLoading/></Suspense><p>Dynamic page tail</p></>}`,
      'app/dynamic-ssr-error/unbounded/page.jsx': `import{WithoutLoading}from'../../../components/RejectingDynamic';export const dynamic='force-dynamic';export default function Page(){return <><h1>Unbounded dynamic shell</h1><WithoutLoading/><p>Dynamic page tail</p></>}`,
      'pages/dynamic-retry.jsx': `import dynamic from'next/dynamic';import{useState}from'react';let attempts=0;const Retry=dynamic(()=>{if(++attempts===1)return Promise.reject(new Error('first dynamic attempt'));return import('../components/PagesInitial')},{ssr:false,delay:0,loading:({error,retry,isLoading})=>error?<button data-testid="dynamic-retry" onClick={retry}>Retry dynamic</button>:<p data-testid="dynamic-retry-loading">Loading retry {String(isLoading)}</p>});export default function Page(){const[show,setShow]=useState(false);return <><button data-testid="start-retry" onClick={()=>setShow(true)}>Start retry</button>{show&&<Retry name="retried"/>}</>}`,
    };
    for (const [file, source] of Object.entries(files)) await write(file, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, build, write, counts,
      hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
      async chunks(marker) {
        const assets = path.join(fixture.root, '.prnext/assets');
        const matches = [];
        for (const name of await readdir(assets)) if (name.endsWith('.js') && (await readFile(path.join(assets, name), 'utf8')).includes(marker)) matches.push('/_prnext/assets/' + name);
        return matches;
      },
      async remove() {
        for (const gate of gates.values()) gate.release();
        origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
        await fixture.remove();
      },
    };
  } catch (error) {
    for (const gate of gates.values()) gate.release();
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    await fixture.remove(); throw error;
  }
}
