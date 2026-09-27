import { standaloneFixture, freePort, repositoryRoot } from './support.mjs';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function standaloneOutputFixture({ nativeAddon = false } = {}) {
  const fixture = await standaloneFixture();
  let deployed;
  const put = async (name, content) => { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  try {
    const require = createRequire(import.meta.url);
    await cp(path.dirname(require.resolve('react-server-dom-webpack/package.json')), path.join(fixture.root, 'node_modules/react-server-dom-webpack'), { recursive: true });
    await put('prnext.config.mjs', `export default {output:'standalone',distDir:'build/server',basePath:'/docs',serverExternalPackages:['file-package','action-package'],outputFileTracingIncludes:{'/api/files':['extra/*.txt']},outputFileTracingExcludes:{'/api/files':['extra/ignored.txt']}};`);
    await put('public/asset.txt', 'public-portable');
    await put('extra/included.txt', 'explicit-include');
    await put('extra/ignored.txt', 'excluded-include');
    await put('.env.production', 'PRIVATE_DEPLOY_SECRET=do-not-copy');
    await put('node_modules/unused-package/package.json', '{"name":"unused-package","main":"index.js"}');
    await put('node_modules/unused-package/index.js', 'module.exports="unused"');
    await put('node_modules/file-package/package.json', '{"name":"file-package","main":"index.cjs"}');
    await put('node_modules/file-package/index.cjs', `const fs=require('node:fs');const path=require('node:path');module.exports=()=>({data:fs.readFileSync(path.join(__dirname,'payload.txt'),'utf8'),version:require('nested-version')});`);
    await put('node_modules/file-package/payload.txt', 'npm-adjacent');
    await put('node_modules/action-package/package.json', '{"name":"action-package","main":"index.cjs"}');
    await put('node_modules/action-package/index.cjs', `module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'payload.txt'),'utf8')`);
    await put('node_modules/action-package/payload.txt', 'action-adjacent');
    await put('node_modules/file-package/node_modules/nested-version/package.json', '{"name":"nested-version","main":"index.cjs"}');
    await put('node_modules/file-package/node_modules/nested-version/index.cjs', 'module.exports="nested-version-2"');
    await put('node_modules/nested-version/package.json', '{"name":"nested-version","main":"index.cjs"}');
    await put('node_modules/nested-version/index.cjs', 'module.exports="root-version-1"');
    await put('pages/api/files.js', `import files from 'file-package';import fs from 'node:fs';export default function handler(req,res){const part='included';res.json({...files(),extra:fs.readFileSync(process.cwd()+'/extra/'+part+'.txt','utf8')});}`);
    if (nativeAddon) {
      await symlink(path.dirname(path.dirname(require.resolve('sharp'))), path.join(fixture.root, 'node_modules/sharp'));
      await put('pages/api/native.js', `import sharp from 'sharp';export default async function handler(req,res){const bytes=await sharp({create:{width:2,height:3,channels:4,background:{r:12,g:34,b:56,alpha:1}}}).png().toBuffer();res.setHeader('Content-Type','image/png');res.end(bytes);}`);
    }
    await put('app/layout.jsx', `export default function Layout({children}){return <html><body>{children}</body></html>}`);
    await put('app/application/page.jsx', `import Counter from './counter';import files from 'file-package';export const dynamic='force-dynamic';export default function Page(){return <><h1>Portable App {files().data}</h1><Counter/></>}`);
    await put('app/application/actions.js', `'use server';import value from 'action-package';export async function mutate(){return value()}`);
    await put('app/application/counter.jsx', `'use client';import {useState} from 'react';import{mutate}from'./actions';export default function Counter(){const [n,set]=useState(0),[result,finish]=useState('not run');return <><button onClick={()=>set(n+1)}>App count {n}</button><button onClick={async()=>finish(await mutate())}>Run action</button><output>{result}</output></>}`);
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    deployed = await mkdtemp(path.join(tmpdir(), 'prnext-standalone-deployed-'));
    await cp(path.join(fixture.root, 'build/server/standalone'), deployed, { recursive: true, verbatimSymlinks: true });
    const metadata = JSON.parse(await readFile(path.join(deployed, 'standalone.json'), 'utf8'));
    await fixture.remove();
    return { root: deployed, metadata, app: path.join(deployed, metadata.app), remove: async () => { await fixture.remove(); await rm(deployed, { recursive: true, force: true }); } };
  } catch (error) { await fixture.remove(); if (deployed) await rm(deployed, { recursive: true, force: true }); throw error; }
}

export async function startStandalone(root, { native = false } = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', PRNEXT_WORKERS: '1' };
  delete env.NODE_PATH; delete env.NODE_OPTIONS; delete env.PRIVATE_DEPLOY_SECRET;
  const child = spawn(native ? path.join(root, 'start') : process.execPath, native ? [] : [path.join(root, 'server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let failure;
  child.on('error', error => { failure = error; });
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const close = async () => { if (child.exitCode !== null || child.signalCode) return; await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }); };
  const url = `http://127.0.0.1:${port}`;
  for (let count = 0; count < 150; count++) {
    if (failure || child.exitCode !== null) { await close(); throw failure || new Error(output); }
    try { await fetch(url + '/docs/asset.txt'); return { url, child, close, output: () => output }; } catch { await delay(50); }
  }
  await close(); throw new Error(`Standalone did not start: ${output}`);
}
