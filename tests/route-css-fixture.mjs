import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { devFixture } from './dev-fixture.mjs';
import { repositoryRoot, binary } from './support.mjs';

export const pageCss = (name, color) => `main[data-page="${name}"]{--page-${name}:1}.main-tone{color:${color}}`;
export function routeCssFiles({ parallel = false, heavy = false, interception = false } = {}) {
  const files = {
    'package.json': '{"name":"route-css-validation","type":"module","private":true}',
    'postcss.config.json': '{"plugins":[]}',
    'components/Persistent.jsx': `'use client';import {useState}from'react';export default function Persistent(){const[count,set]=useState(0);return <button data-testid="persistent" onClick={()=>set(count+1)}>Count {count}</button>}`,
    'app/layout.jsx': `import Link from 'next/link';import Persistent from '../components/Persistent';import './layout.css';export default function Layout({children,detail,modal}){return <html><head/><body><header><Persistent/><nav>${['a','b','c',...(parallel?[]:['edge'])].map(name=>`<Link href="/${name}" prefetch={false}>${name.toUpperCase()}</Link>`).join('')}${interception?'<Link href="/photo/one" prefetch={false}>Photo</Link>':''}</nav></header>{children}{detail}{modal}</body></html>}`,
    'app/layout.css': 'body{--layout-proof:1;margin:0;font-family:system-ui}nav{display:flex;gap:24px}header{padding:20px}.main-tone{font-size:24px}',
    'app/a/page.jsx': `import './page.css';import Client from './client';export const dynamic='force-dynamic';export default function Page(){return <main data-page="a"><h1 className="main-tone">Page A</h1><Client/></main>}`,
    'app/a/page.css': pageCss('a','rgb(170,20,30)'),
    'app/a/client.jsx': `'use client';import dynamic from 'next/dynamic';import styles from './client.module.css';const Lazy=dynamic(()=>import('./lazy'),{ssr:false});export default function Client(){return <div className={styles.box} data-testid="client-module"><Lazy/></div>}`,
    'app/a/client.module.css': '.box{border:3px solid rgb(12,34,56)}',
    'app/a/lazy.jsx': `import './lazy.css';export default function Lazy(){return <p className="lazy-style" data-testid="lazy">Lazy style</p>}`,
    'app/a/lazy.css': '.lazy-style{color:rgb(98,76,54)}',
    ...Object.fromEntries(['b','c'].flatMap((name,index)=>[
      [`app/${name}/page.jsx`,`import './page.css';export const dynamic='force-dynamic';export default function Page(){return <main data-page="${name}"><h1 className="main-tone">Page ${name.toUpperCase()}</h1></main>}`],
      [`app/${name}/page.css`,pageCss(name,index===0?'rgb(20,40,170)':'rgb(140,60,20)')],
    ])),
  };
  if (parallel) Object.assign(files, {
    'app/@detail/default.jsx': 'export default function Default(){return null}',
    'app/@detail/a/page.jsx': `import './detail.css';export default function Detail(){return <aside className="detail-tone" data-testid="detail">Detail A</aside>}`,
    'app/@detail/a/detail.css': '.detail-tone{color:rgb(30,140,90);border:2px solid rgb(50,100,150)}',
  });
  else Object.assign(files, {
    'app/edge/page.jsx': `import './page.css';export const runtime='edge';export const dynamic='force-dynamic';export default function Edge(){return <main data-page="edge"><h1 className="main-tone">Page EDGE</h1></main>}`,
    'app/edge/page.css': pageCss('edge','rgb(30,140,90)'),
  });
  if (heavy) files['app/b/page.css'] += Array.from({length:800},(_,index)=>`.sibling-only-${index}{--sibling-proof:${index};padding:${index%20}px}`).join('');
  if (interception) Object.assign(files, {
    'app/photo/[id]/page.jsx': `import './canonical.css';export default function Photo(){return <main data-testid="canonical"><h1 className="main-tone">Canonical photo</h1></main>}`,
    'app/photo/[id]/canonical.css': '.main-tone{--canonical-only:1;color:rgb(10,40,160)}',
    'app/@modal/default.jsx': 'export default function Default(){return null}',
    'app/@modal/(.)photo/[id]/page.jsx': `import './modal.css';export default function Modal(){return <aside role="dialog" className="modal-tone">Intercepted photo</aside>}`,
    'app/@modal/(.)photo/[id]/modal.css': '.modal-tone{--modal-only:1;color:rgb(160,80,20)}',
  });
  return files;
}

export async function routeCssFixture({ development = false, webpack = false, parallel = false, heavy = false, interception = false } = {}) {
  const files = routeCssFiles({ parallel, heavy, interception });
  const config = `export default{basePath:'/docs'${webpack?',webpack(config){return config}':''}}`;
  if (development) return devFixture({ config, files });
  const root = await mkdtemp(path.join(repositoryRoot, '.prnext-css-browser-'));
  try {
    for (const [name, source] of Object.entries({ ...files, 'prnext.config.mjs':config })) {
      await mkdir(path.dirname(path.join(root,name)), { recursive:true });
      await writeFile(path.join(root,name), source);
    }
    return { root,
      read:name=>readFile(path.join(root,name),'utf8'),
      write:(name,source)=>writeFile(path.join(root,name),source),
      async build() {
        await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root],{cwd:repositoryRoot,env:{...process.env,PRNEXT_BINARY:binary},maxBuffer:8*1024*1024});
        return JSON.parse(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'));
      },
      remove:()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}),
    };
  } catch(error) { await rm(root,{recursive:true,force:true}); throw error; }
}
