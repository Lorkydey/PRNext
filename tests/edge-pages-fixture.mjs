import { mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function edgePagesFixture({ webpack = false } = {}) {
  const fixture = await appFixture();
  try {
    await symlink(path.dirname(createRequire(import.meta.url).resolve('sass')), path.join(fixture.root, 'node_modules/sass'), 'dir');
    for (const name of ['app', 'pages', 'components', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'rustyx.config.mjs': `export default{basePath:'/docs'${webpack ? ",webpack(config){config.plugins.push({apply(compiler){compiler.hooks.compilation.tap('EdgeStyles',()=>{})}});return config}" : ''}}`,
      'components/counter.jsx': `'use client';import {useState,useEffect} from 'react';import {useRouter} from 'next/navigation';export default function Counter({name,edge,data}){if(typeof window==='undefined'&&edge&&(typeof Buffer!=='undefined'||typeof process.versions!=='undefined'||EdgeRuntime!=='edge-runtime'))throw Error('Client SSR escaped Edge');if(typeof window==='undefined'&&!edge&&typeof Buffer==='undefined')throw Error('Node SSR was changed to Edge');const[n,set]=useState(0),[ready,mark]=useState(false);const router=useRouter();useEffect(()=>mark(true),[]);return <section data-testid={name} data-ready={ready}><button onClick={()=>set(n+1)}>{name} {n}</button>{data&&<p>{data.date.getUTCFullYear()}:{data.map.get('id')}:{data.set.has('web')?'web':'missing'}</p>}<button onClick={()=>router.refresh()}>refresh {name}</button></section>}`,
      'app/global.css': `body { background-color: rgb(240, 245, 250); }`,
      'app/edge/title.module.scss': `$ink: rgb(12, 34, 56); .title { color: $ink; }`,
      'app/layout.jsx': `import './global.css';import Link from 'next/link';export default({children})=><html><body><nav><Link href="/edge/one">edge one</Link><Link href="/edge/two">edge two</Link><Link href="/node">node page</Link></nav>{children}</body></html>`,
      'app/edge/layout.jsx': `import Counter from '../../components/counter';export const runtime='edge';export default({children})=><section><p data-testid="edge-layout">{EdgeRuntime}:{typeof Buffer}</p><Counter name="layout" edge/>{children}</section>`,
      'app/edge/[id]/page.jsx': `import {headers,cookies} from 'next/headers';import Counter from '../../../components/counter';export async function generateMetadata({params}){return{title:'Edge '+(await params).id+' '+(await headers()).get('x-user')}}export default async function Page({params}){const{id}=await params;const h=await headers(),c=await cookies();const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));return <><h1>Edge {id}</h1><p data-testid="edge-context">{[EdgeRuntime,typeof Buffer,h.get('x-user'),c.get('visitor')?.value,bytes.byteLength,h instanceof Headers].join(':')}</p><Counter name="page" edge data={{date:new Date('2026-01-02'),map:new Map([['id',id]]),set:new Set(['web'])}}/></>}`,
      'app/edge/missing/page.jsx': `import {notFound} from 'next/navigation';export default()=>notFound()`,
      'app/edge/not-found.jsx': `export default()=> <h2>Edge missing</h2>`,
      'app/node/page.jsx': `import Counter from '../../components/counter';export const dynamic='force-dynamic';export default()=> <><h1>Node page {typeof Buffer}</h1><Counter name="node" edge={false}/></>`,
      'components/realm.jsx': `'use client';const lexical='second-client';if(typeof window==='undefined'&&typeof EdgeRuntime!=='undefined')globalThis.__edgeSSRCount=(globalThis.__edgeSSRCount||0)+1;export default function Realm(){if(typeof window==='undefined'&&(lexical!=='second-client'||globalThis.__edgeSSRCount<2||globalThis.__edgeRSCCount!==undefined))throw Error('React SSR realm was not shared or crossed into RSC');return <p>Shared Edge realm</p>}`,
      'app/edge/other/page.jsx': `import Realm from '../../../components/realm';const lexical='second-page';globalThis.__edgeRSCCount=(globalThis.__edgeRSCCount||0)+1;export default function Other(){if(lexical!=='second-page'||globalThis.__edgeRSCCount<2||globalThis.__edgeSSRCount!==undefined)throw Error('React RSC realm was not shared or crossed into SSR');return <><h1>Other Edge page</h1><Realm/></>}`,
    };
    files['app/edge/[id]/page.jsx'] = "import styles from '../title.module.scss';" + files['app/edge/[id]/page.jsx'].replace('<h1>Edge {id}</h1>', '<h1 className={styles.title}>Edge {id}</h1>');
    files['components/counter.jsx'] = files['components/counter.jsx'].replace("'use client';", "'use client';const lexical='first-client';if(typeof window==='undefined'&&typeof EdgeRuntime!=='undefined')globalThis.__edgeSSRCount=(globalThis.__edgeSSRCount||0)+1;").replace('const[n,set]=useState(0)', "if(lexical!=='first-client'||(typeof window==='undefined'&&typeof EdgeRuntime!=='undefined'&&globalThis.__edgeRSCCount!==undefined))throw Error('Client lexical or realm state crossed');const[n,set]=useState(0)");
    files['app/edge/[id]/page.jsx'] = "const lexical='first-page';globalThis.__edgeRSCCount=(globalThis.__edgeRSCCount||0)+1;" + files['app/edge/[id]/page.jsx'].replace('const{id}=await params;', "if(lexical!=='first-page'||globalThis.__edgeSSRCount!==undefined)throw Error('Page lexical or realm state crossed');const{id}=await params;");
    files['app/edge/[id]/page.jsx'] = files['app/edge/[id]/page.jsx'].replace("const h=await headers()", "const form=new FormData();form.append('kind','web-form');const h=await headers()").replace("set:new Set(['web'])", "set:new Set(['web']),form,bytes:new Uint8ClampedArray([0,255]),error:new Error('redacted')");
    files['components/counter.jsx'] = files['components/counter.jsx'].replace("{data.set.has('web')?'web':'missing'}</p>", "{data.set.has('web')?'web':'missing'}:{data.form instanceof FormData?data.form.get('kind'):'wrong-form'}:{data.bytes instanceof Uint8ClampedArray?data.bytes[1]:'wrong-bytes'}:{data.error instanceof Error?'error':'wrong-error'}</p>");
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    async function build() {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 ** 2 });
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    }
    return { ...fixture, build };
  } catch (error) { await fixture.remove(); throw error; }
}
