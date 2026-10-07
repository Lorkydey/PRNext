import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { repositoryRoot } from '../scripts/cargo.mjs';

export { repositoryRoot };
export const binary = process.env.PRNEXT_BINARY || path.join(repositoryRoot, 'target/release', process.platform === 'win32' ? 'prnext.exe' : 'prnext');
export async function appFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-app-independent-'));
  try {
  await cp(path.join(repositoryRoot, 'examples/app'), root, { recursive: true, filter: source => !['/.prnext', '/.rustyx', '/node_modules'].some(part => source.replaceAll(path.sep, '/').includes(part)) });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  const require = createRequire(import.meta.url);
  for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler', 'clsx']) {
    let folder = path.dirname(require.resolve(name));
    for (;;) {
      try { if (JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')).name === name) break; } catch {}
      if (path.dirname(folder) === folder) throw new Error(`Cannot locate installed package ${name}`);
      folder = path.dirname(folder);
    }
    await cp(folder, path.join(root, 'node_modules', name), { recursive: true });
  }
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function standaloneFixture(prefix = 'prnext-independent-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const require = createRequire(import.meta.url);
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'pages'), { recursive: true });
  await mkdir(path.join(root, 'components'), { recursive: true });
  for (const name of ['react', 'react-dom', 'scheduler']) await cp(path.dirname(require.resolve(`${name}/package.json`)), path.join(root, 'node_modules', name), { recursive: true });
  await mkdir(path.join(root, 'node_modules/example-widget'));
  await writeFile(path.join(root, 'node_modules/example-widget/package.json'), JSON.stringify({ name: 'example-widget', main: 'index.cjs' }));
  await writeFile(path.join(root, 'node_modules/example-widget/index.cjs'), `const React=require('react'); exports.Widget=function Widget(){const [count,setCount]=React.useState(0);return React.createElement('button',{onClick:()=>setCount(count+1)},'npm '+process.env.NODE_ENV+' count '+count);};`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'independent-app', private: true, type: 'module' }));
  await writeFile(path.join(root, 'pages/_app.jsx'), `export default function App({Component,pageProps,router}){return <><p data-testid="app-query">{router.query.from||'none'}</p><Component {...pageProps}/></>;}`);
  await writeFile(path.join(root, 'components/Main.jsx'), `import {useState} from 'react'; import {Widget} from 'example-widget'; import Head from 'next/head'; import Link from 'prnext/link'; import {useRouter} from 'prnext/router'; import styles from './main.module.css'; export default function Main(){const [count,setCount]=useState(0);const router=useRouter();return <><Head><title>Independent React</title><script type="application/ld+json">{'{"name":"PRNext fixture"}'}</script></Head><h1 className={styles.title}>Independent React</h1><button onClick={()=>setCount(count+1)}>count {count}</button><Widget/><p data-testid="query">{router.query.from||'none'}</p><Link href="/server">SSR</Link></>;}`);
  await writeFile(path.join(root, 'components/main.module.css'), '.title { color: rgb(12, 34, 56); }');
  await writeFile(path.join(root, 'pages/index.jsx'), `export {default} from '../components/Main';`);
  await writeFile(path.join(root, 'pages/server.jsx'), `export {default} from '../components/Main'; export const getServerSideProps=()=>({props:{}});`);
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}
export async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
export async function startServer(root, args = [], environment = {}) {
  const port = await freePort();
  const child = spawn(binary, ['start', root, '--hostname', '127.0.0.1', '--port', String(port), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ...environment } });
  let output = '';
  let launchError;
  child.on('error', error => { launchError = error; });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { await fetch(`${url}/robots.txt`); return { child, url, close, output: () => output }; }
    catch { await delay(50); }
  }
  await close();
  throw new Error(`Server did not become ready: ${output}`);
}
