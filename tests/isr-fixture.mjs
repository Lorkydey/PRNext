import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { standaloneFixture, repositoryRoot } from './support.mjs';

export async function isrFixture({ originDelayMs = 0 } = {}) {
  const fixture = await standaloneFixture();
  const counts = new Map(), values = new Map(), reasons = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin');
    const key = url.searchParams.get('key');
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    reasons.set(key, [...(reasons.get(key) || []), url.searchParams.get('reason')]);
    const data = { value: 0, mode: 'props', revalidate: false, ...values.get(key), key, count };
    if (originDelayMs) await delay(originDelayMs);
    await gates.get(key)?.promise;
    response.setHeader('content-type', 'application/json');
    if (data.mode === 'error') response.statusCode = 500;
    response.end(JSON.stringify(data));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  try {
    await rm(path.join(fixture.root, 'pages'), { recursive: true });
    const files = {
      'lib/data.js': `const origin=${JSON.stringify(originUrl)};
        export async function data(key,reason){const response=await fetch(origin+'/?key='+encodeURIComponent(key)+'&reason='+encodeURIComponent(reason));
          if(!response.ok)throw new Error('Origin rejected ISR regeneration');const value=await response.json();
          if(value.mode==='notFound')return {notFound:true,revalidate:value.revalidate};
          if(value.mode==='redirect')return {redirect:{destination:'/target?from='+encodeURIComponent(key),permanent:false},revalidate:value.revalidate};
          return {props:{...value,reason},revalidate:value.revalidate};}`,
      'components/Page.jsx': `import {useRouter} from 'next/router';
        export default function Page(props){const router=useRouter();return router.isFallback?<p data-testid="fallback">Loading static page</p>:<>
          <h1>Generated page</h1><p data-testid="value">{props.value}</p><p data-testid="count">{props.count}</p>
          <p data-testid="reason">{props.reason}</p><p data-testid="id">{router.query.id||'none'}</p>
          <p data-testid="query">{router.query.from||'none'}</p><p data-testid="as-path">{router.asPath}</p></>}`,
      'pages/_app.jsx': `import {useState} from 'react';export default function App({Component,pageProps}){const [count,setCount]=useState(0);return <><button onClick={()=>setCount(count+1)}>Persistent count: {count}</button><Component {...pageProps}/></>}`,
      'pages/index.jsx': `import {data} from '../lib/data';export {default} from '../components/Page';export const getStaticProps=({revalidateReason})=>data('index',revalidateReason);`,
      'pages/index/index.jsx': `import {data} from '../../lib/data';export {default} from '../../components/Page';export const getStaticProps=({revalidateReason})=>data('literal-index',revalidateReason);`,
      'pages/seed.jsx': `import {data} from '../lib/data';export {default} from '../components/Page';export const getStaticProps=({revalidateReason})=>data('seed',revalidateReason);`,
      'pages/server.jsx': `import {data} from '../lib/data';export {default} from '../components/Page';export const getServerSideProps=()=>data('server','ssr');`,
      'pages/target.jsx': `export default function Target(){return <h1>Redirect target</h1>}`,
      'pages/blocking/[id].jsx': `import {data} from '../../lib/data';export {default} from '../../components/Page';export const getStaticPaths=()=>({paths:[{params:{id:'built'}}],fallback:'blocking'});export const getStaticProps=({params,revalidateReason})=>data('blocking/'+params.id,revalidateReason);`,
      'pages/blocking/special.jsx': `export default function Special(){return <h1>Specific SSR route</h1>}export const getServerSideProps=()=>({props:{}});`,
      'pages/fallback/[id].jsx': `import {data} from '../../lib/data';export {default} from '../../components/Page';export const getStaticPaths=()=>({paths:[],fallback:true});export const getStaticProps=({params,revalidateReason})=>data('fallback/'+params.id,revalidateReason);`,
      'pages/closed/[id].jsx': `import {data} from '../../lib/data';export {default} from '../../components/Page';export const getStaticPaths=()=>({paths:[{params:{id:'built'}}],fallback:false});export const getStaticProps=({params,revalidateReason})=>data('closed/'+params.id,revalidateReason);`,
      'pages/api/revalidate.js': `export default async function handler(req,res){try{await res.revalidate(req.body.path,{unstable_onlyGenerated:req.body.onlyGenerated});res.json({revalidated:true});}catch(error){res.status(500).json({error:error.message});}}`,
    };
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true });
      await writeFile(path.join(fixture.root, file), contents);
    }
    const build = async (args = []) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root, ...args]);
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { ...fixture, build, manifest, counts, values, reasons, originUrl,
      hold(key) {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        gates.set(key, { promise, release });
        return () => { gates.delete(key); release(); };
      },
      async remove() {
        for (const gate of gates.values()) gate.release();
        origin.closeAllConnections();
        await new Promise(resolve => origin.close(resolve));
        await fixture.remove();
      },
    };
  } catch (error) {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await fixture.remove();
    throw error;
  }
}
