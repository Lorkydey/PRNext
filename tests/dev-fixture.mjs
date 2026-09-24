import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { freePort, repositoryRoot, binary } from './support.mjs';

export const counterSource = (label = 'Original', { renderError = false, eventError = false } = {}) => `'use client';import{useState}from'react';import styles from'./counter.module.css';export default function Counter(){const[count,setCount]=useState(0);${renderError ? 'throw new Error("render refresh failure");' : ''}return <button data-testid="counter" className={styles.counter} onClick={()=>{${eventError ? 'throw new Error("event refresh failure");' : 'setCount(count+1);'}}}>${label} {count}</button>}`;

export async function devFixture({config, files: additionalFiles = {}} = {}) {
  const root = await mkdtemp(path.join(repositoryRoot, '.rustyx-hmr-test-'));
  const files = {
    'package.json': '{"name":"rustyx-dev-test","type":"module"}',
    'postcss.config.json': '{"plugins":[]}',
    'rustyx.config.mjs': config || `export default{basePath:'/docs'}`,
    'components/Counter.jsx': counterSource(),
    'components/counter.module.css': '.counter{color:rgb(12,34,56)}',
    'pages/pages.jsx': `import Counter from'../components/Counter';export const getServerSideProps=()=>({props:{value:'page-server-one'}});export default function Page({value}){return <><h1>Pages refresh</h1><Counter/><p data-testid="server">{value}</p></>}`,
    'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/app/page.jsx': `import Counter from'../../components/Counter';export const dynamic='force-dynamic';export default function Page(){return <><h1>App refresh</h1><Counter/><p data-testid="server">app-server-one</p></>}`,
    ...additionalFiles,
  };
  for (const [file, source] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), source); }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'dev', root, '--port', String(port)], {
    cwd: repositoryRoot, env: { ...process.env, NODE_ENV: 'development', RUSTYX_BINARY: binary }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-80_000); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-80_000); });
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    await rm(root, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`dev exited: ${output}`);
      try {
        const response = await fetch(url + '/docs/pages');
        if (response.ok) return { root, url, child, close, output: () => output,
          write: (file, source) => writeFile(path.join(root, file), source),
          read: file => readFile(path.join(root, file), 'utf8'),
        };
      } catch {}
      await delay(50);
    }
    throw new Error(`dev did not start: ${output}`);
  } catch (error) { await close(); throw error; }
}
