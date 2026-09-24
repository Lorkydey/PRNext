import { test, expect } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { standaloneFixture, startServer, repositoryRoot } from '../support.mjs';

test('npm Next imports and configured TypeScript/CSS components hydrate and navigate after deployment', async ({ page }) => {
  const fixture = await standaloneFixture();
  let server;
  try {
    const directory = path.join(fixture.root, 'node_modules/next-ui');
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'next-ui', type: 'module', main: 'index.tsx' }));
    await writeFile(path.join(directory, 'index.tsx'), `import {useState} from 'react';import Link from 'next/link';import styles from './style.module.css';export function Widget({href}:{href:string}){const[count,setCount]=useState(0);return <div className={styles.card} data-testid="widget"><button onClick={()=>setCount(count+1)}>npm count {count}</button><Link href={href}>npm link</Link></div>}`);
    await writeFile(path.join(directory, 'style.module.css'), '.card{color:rgb(12,34,56)}');
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default{transpilePackages:['next-ui']}`);
    await writeFile(path.join(fixture.root, 'pages/index.jsx'), `import{Widget}from'next-ui';export default()=> <><h1>Home</h1><Widget href="/other"/></>;export const getServerSideProps=()=>({props:{}})`);
    await writeFile(path.join(fixture.root, 'pages/other.jsx'), `import{Widget}from'next-ui';export default()=> <><h1>Other</h1><Widget href="/"/></>`);
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root]);
    await rm(directory, { recursive: true });
    server = await startServer(fixture.root);
    const errors = [], documents = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(server.url);
    await expect(page.getByTestId('widget')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await page.getByRole('button', { name: 'npm count 0' }).click();
    await expect(page.getByRole('button', { name: 'npm count 1' })).toBeVisible();
    await page.getByRole('link', { name: 'npm link' }).click();
    await expect(page.getByRole('heading', { name: 'Other' })).toBeVisible();
    await expect(page.getByTestId('widget')).toHaveCSS('color', 'rgb(12, 34, 56)');
    expect(documents).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
