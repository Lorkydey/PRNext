import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function scriptFixture({ workerPackage, csp = false } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://origin').pathname.slice(1);
    counts.set(name, (counts.get(name) || 0) + 1);
    await gates.get(name)?.promise;
    if (response.destroyed) return;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('access-control-allow-origin', '*');
    if (name.endsWith('.css')) {
      response.setHeader('content-type', 'text/css');
      response.end('.script-style { color: rgb(12, 34, 56); }');
    } else if (name === 'load-gate.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR0sAAAAASUVORK5CYII=', 'base64'));
    } else {
      response.setHeader('content-type', 'text/javascript');
      if (name === 'missing.js' || name === 'before-missing.js') {
        response.statusCode = 404; response.end('// missing script');
      } else if (name === 'worker.js') {
        response.end('window.__workerPrivate=42;document.documentElement.dataset.workerResult=String(window.__workerPrivate);');
      } else {
        response.end(`(window.__scriptEvents||=[]).push(${JSON.stringify(`${name}:exec`)});(window.__scriptRuns||={})[${JSON.stringify(name)}]=((window.__scriptRuns||{})[${JSON.stringify(name)}]||0)+1;`);
      }
    }
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  const write = async (name, source) => { const filename = path.join(fixture.root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); };
  const remove = async () => {
    for (const gate of gates.values()) gate.release();
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    await fixture.remove();
  };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    if (workerPackage) {
      const target = path.join(fixture.root, 'node_modules/@builder.io/partytown');
      await mkdir(path.dirname(target), { recursive: true }); await cp(workerPackage, target, { recursive: true });
    }
    await write('prnext.config.mjs', `export default{basePath:'/docs',assetPrefix:'/resources',generateBuildId:()=> 'script-tests'${workerPackage ? ',experimental:{nextScriptWorkers:true}' : ''}}`);
    const before = `<Script id="inline-first" strategy="beforeInteractive" nonce="script-nonce">{'(window.__scriptEvents||=[]).push("inline-first:exec")'}</Script><Script id="external-first" src="${originURL}/before-first.js" strategy="beforeInteractive" nonce="script-nonce"/><Script id="inline-second" strategy="beforeInteractive"${csp ? ' nonce="script-nonce"' : ''}>{'window.__scriptEvents.push("inline-second:exec")'}</Script><Script id="external-second" src="${originURL}/before-second.js" strategy="beforeInteractive"${csp ? ' nonce="script-nonce"' : ''}/>`;
    await write('app/layout.jsx', `import Script from'next/script';${csp ? "export const dynamic='force-dynamic';" : ''}export default function Layout({children}){return <html><body>${before}{children}</body></html>}`);
    await write('pages/_document.jsx', `import{Html,Head,Main,NextScript}from'next/document';import Script from'prnext/script';export default function Document(){return <Html><Head>${before}${workerPackage ? `<Script id="worker" strategy="worker" src="${originURL}/worker.js"/>` : ''}</Head><body><Main/><NextScript/></body></Html>}`);
    await write('components/Probe.jsx', `'use client';import{useEffect,useState}from'react';import Script from'next/script';import AliasScript from'prnext/script';import Link from'next/link';const origin=${JSON.stringify(originURL)};
      function record(event){(window.__scriptEvents||=[]).push(event)}
      function Scripts(){return <>
        <Script id="after" src={origin+'/after.js'} onLoad={function(event){record('after:load:'+event.type+':'+this.tagName)}} onReady={()=>record('after:ready')} stylesheets={[origin+'/after.css']} data-probe="forwarded" nonce="script-nonce" async={false}/>
        <Script id="lazy" src={origin+'/lazy.js'} strategy="lazyOnload" onLoad={()=>record('lazy:load:'+document.readyState)} onReady={()=>record('lazy:ready')}/>
        <Script id="duplicate-one" src={origin+'/duplicate.js'} onLoad={()=>record('dup1:load')} onReady={()=>record('dup1:ready')}/>
        <AliasScript id="duplicate-two" src={origin+'/duplicate.js'} onLoad={()=>record('dup2:load')} onReady={()=>record('dup2:ready')}/>
        <AliasScript id="inline-after" onLoad={()=>record('inline:load')} onReady={()=>record('inline:ready:'+String(window.__inlineRuns))}>{'window.__inlineRuns=(window.__inlineRuns||0)+1;window.__scriptEvents.push("inline:exec")'}</AliasScript>
        <Script id="missing" src={origin+'/missing.js'} onLoad={()=>record('missing:load')} onReady={()=>record('missing:ready')} onError={event=>record('missing:error:'+event.type)}/>
      </>}
      export default function Probe({router,label,gate=false,beforeFailure=false}){const[mounted,setMounted]=useState(true),[count,setCount]=useState(0);useEffect(()=>{record('hydrate:'+JSON.stringify(window.__scriptRuns||{}));window.__scriptHydrated=true},[]);return <>
        {beforeFailure&&<><Script id="before-missing" strategy="beforeInteractive" src={origin+'/before-missing.js'}/><Script id="after-before-missing" strategy="beforeInteractive">{'window.__afterFailedBefore=true'}</Script></>}
        <h1 className="script-style" data-testid="script-heading">{label}</h1><button data-testid="toggle-scripts" onClick={()=>setMounted(!mounted)}>{mounted?'Hide scripts':'Show scripts'}</button><button data-testid="script-count" onClick={()=>setCount(count+1)}>Count {count}</button>
        <Link prefetch={false} data-testid="script-next" href={router==='app'?'/app-other':'/pages-other'}>Other page</Link>
        {gate&&<img src={origin+'/load-gate.png'} alt="load gate"/>}{mounted&&<Scripts/>}
      </>}
    `);
    await write('pages/pages.jsx', `import Probe from'../components/Probe';export default()=> <Probe router="pages" label="Pages scripts"/>`);
    await write('pages/pages-other.jsx', `import Probe from'../components/Probe';export default()=> <Probe router="pages" label="Other Pages scripts"/>`);
    await write('pages/pages-lazy.jsx', `import Probe from'../components/Probe';export default()=> <Probe router="pages" label="Lazy Pages scripts" gate/>`);
    await write('app/app/page.jsx', `import Probe from'../../components/Probe';export default()=> <Probe router="app" label="App scripts"/>`);
    await write('app/app-other/page.jsx', `import Probe from'../../components/Probe';export default()=> <Probe router="app" label="Other App scripts"/>`);
    await write('app/app-lazy/page.jsx', `import Probe from'../../components/Probe';export default()=> <Probe router="app" label="Lazy App scripts" gate/>`);
    await write('app/before-failure/page.jsx', `import Probe from'../../components/Probe';export default()=> <Probe router="app" label="Before failure" beforeFailure/>`);
    if (csp) {
      const policy = "script-src 'nonce-script-nonce' 'strict-dynamic'; object-src 'none'; base-uri 'self'";
      await write('proxy.ts', `import{NextResponse}from'next/server';export const config={matcher:'/app-csp'};export function proxy(request){const policy=${JSON.stringify(policy)},headers=new Headers(request.headers);headers.set('content-security-policy',policy);const response=NextResponse.next({request:{headers}});response.headers.set('content-security-policy',policy);return response}`);
      await write('app/app-csp/page.jsx', `'use client';import{useEffect,useState}from'react';import Script from'next/script';export default function Page(){const[count,setCount]=useState(0);useEffect(()=>{window.__cspHydrated=true},[]);return <><h1>Strict CSP scripts</h1><button data-testid="csp-count" onClick={()=>setCount(count+1)}>Count {count}</button><Script id="csp-inline" nonce="script-nonce">{'window.__cspInline=(window.__cspInline||0)+1'}</Script><Script id="csp-after" nonce="script-nonce" src="${originURL}/csp-after.js" onReady={()=>{window.__cspReady=true}}/></>}`);
    }
    return {
      root: fixture.root, counts, originURL, remove,
      async build() {
        await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
        return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
      },
      hold(name) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(name, { promise, release }); return () => { gates.delete(name); release(); }; },
    };
  } catch (error) { await remove(); throw error; }
}
