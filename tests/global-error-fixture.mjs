import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function globalErrorFixture({ custom = true, sourceDirectory = 'app' } = {}) {
  const fixture = await appFixture();
  const state = { rootFailure: false, pageFailure: false, ssrClientFailure: false };
  const counts = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://origin').pathname.slice(1);
    counts.set(name, (counts.get(name) || 0) + 1);
    await gates.get(name)?.promise;
    if (!response.destroyed) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(state));
    }
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  const write = async (name, content) => { const target = path.join(fixture.root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); };
  const remove = async () => {
    for (const gate of gates.values()) gate.release();
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    await fixture.remove();
  };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    await write('rustyx.config.mjs', `export default{basePath:'/docs',assetPrefix:'/resources',generateBuildId:()=> 'global-errors'}`);
    const files = {
      'state.js': `export async function readState(name){return(await fetch(${JSON.stringify(originURL)}+'/'+name,{cache:'no-store'})).json()}`,
      'layout.jsx': `import{readState}from'./state';import Shell from'./shell';import'./normal.css';export const dynamic='force-dynamic';export const metadata={title:'Normal document',description:'Normal metadata'};export default async function RootLayout({children}){const state=await readState('root');if(state.rootFailure)throw new Error('PRIVATE_ROOT_SERVER_ERROR');return <html lang="fr" data-root-layout="yes"><head/><body className="normal-theme"><Shell ssrFailure={state.ssrClientFailure}>{children}</Shell></body></html>}`,
      'normal.css': 'body.normal-theme { background-color: rgb(24, 35, 46); } .normal-only { color: rgb(88, 99, 111); }',
      'shell.jsx': `'use client';import{useState,useEffect}from'react';import{useRouter}from'next/navigation';import Link from'next/link';export default function Shell({children,ssrFailure}){const router=useRouter(),[count,setCount]=useState(0),[broken,setBroken]=useState(false);useEffect(()=>{window.__globalRouter=router},[router]);if(ssrFailure)throw new Error('CLIENT_SSR_FAILURE');if(broken||typeof window!=='undefined'&&window.__rootCrash)throw new Error('CLIENT_ROOT_FAILURE');return <><aside data-testid="normal-shell"><button data-testid="layout-count" onClick={()=>setCount(count+1)}>Layout {count}</button><button data-testid="crash-root" onClick={()=>{window.__rootCrash=true;setBroken(true)}}>Crash root</button><Link prefetch={false} href="/" data-testid="home">Home</Link><Link prefetch={false} href="/unhandled" data-testid="unhandled">Unhandled</Link><Link prefetch={false} href="/local" data-testid="local">Local</Link><Link prefetch={false} href="/late" data-testid="late">Late</Link></aside>{children}</>}`,
      'page.jsx': `export default function Page(){return <h1 data-testid="healthy-heading">Healthy home</h1>}`,
      'unhandled/page.jsx': `import{readState}from'../state';export default async function Page(){const state=await readState('unhandled');if(state.pageFailure)throw new Error('PRIVATE_PAGE_SERVER_ERROR');return <h1 data-testid="healthy-heading">Recovered page</h1>}`,
      'local/page.jsx': `import{readState}from'../state';export default async function Page(){const state=await readState('local');if(state.pageFailure)throw new Error('PRIVATE_LOCAL_SERVER_ERROR');return <h1 data-testid="healthy-heading">Recovered local page</h1>}`,
      'local/error.jsx': `'use client';export default function ErrorUI({error,reset,retry}){if(typeof window!=='undefined'&&window.__localBoundaryCrash)throw new Error('CLIENT_LOCAL_BOUNDARY_FAILURE');return <section data-testid="local-error"><h1>Local error</h1><pre data-testid="local-message">{error.message}</pre><button data-testid="local-reset" onClick={reset}>Reset local</button><button data-testid="local-retry" onClick={retry}>Retry local</button></section>}`,
      'late/loading.jsx': `export default function Loading(){return <p data-testid="late-loading">Waiting for server</p>}`,
      'late/page.jsx': `import{readState}from'../state';export default async function Page(){const state=await readState('late');if(state.pageFailure)throw new Error('PRIVATE_LATE_SERVER_ERROR');return <h1 data-testid="healthy-heading">Recovered late page</h1>}`,
      'instant/loading.jsx': `export default function Loading(){return <p data-testid="instant-loading">Immediate failure loading shell</p>}`,
      'instant/page.jsx': `export const dynamic='force-dynamic';export default function Page(){throw new Error('PRIVATE_INSTANT_SERVER_ERROR')}`,
    };
    if (custom) {
      files['global-error.jsx'] = `'use client';import{useEffect}from'react';import{useRouter}from'next/navigation';import'./global.css';export default function GlobalError({error,reset,retry}){const router=useRouter();useEffect(()=>{window.__globalReady=true},[]);if(typeof window!=='undefined'&&window.__globalBoundaryCrash)throw new Error('CLIENT_GLOBAL_BOUNDARY_FAILURE');return <html lang="en" data-global-document="yes"><head><title>Global recovery</title></head><body><h1 data-testid="global-heading">Global error</h1><pre data-testid="global-error">{JSON.stringify({message:error.message,digest:error.digest,isError:error instanceof Error,reset:typeof reset,retry:typeof retry})}</pre><button data-testid="global-reset" onClick={()=>{window.__rootCrash=false;reset()}}>Reset global</button><button data-testid="global-retry" onClick={retry}>Retry global</button><button data-testid="global-home" onClick={()=>router.push('/')}>Home</button></body></html>}`;
      files['global.css'] = '[data-global-document] [data-testid="global-heading"] { color: rgb(130, 45, 91); }';
    }
    for (const [name, content] of Object.entries(files)) await write(`${sourceDirectory}/${name}`, content);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    };
    return { root: fixture.root, state, counts, build, write, remove,
      hold(name) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(name, { promise, release }); return () => { gates.delete(name); release(); }; },
    };
  } catch (error) { await remove(); throw error; }
}
