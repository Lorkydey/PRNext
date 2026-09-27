import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => {
  fixture = await appFixture();
  const rich = path.join(fixture.root, 'app/action-types');
  await mkdir(rich, { recursive: true });
  await writeFile(path.join(rich, 'actions.ts'), `'use server';
export async function echo(form: FormData, rich: any, opaque: any) {
  const file = form.get('file') as File;
  return { name: file.name, type: file.type, contents: await file.text(), tags: form.getAll('tag'),
    date: rich.date, map: rich.map, set: rich.set, big: rich.big, bytes: rich.bytes,
    circular: rich.circular, promised: await rich.promised, opaque };
}`);
  await writeFile(path.join(rich, 'client.tsx'), `'use client';
import {useState} from 'react'; import {echo} from './actions';
export default function Types() {
  const [result,setResult]=useState('');
  async function submit(form: FormData) {
    form.append('tag','one');form.append('tag','two');
    const opaque = () => 'browser only';
    const circular: any = { value: 'cycle' }; circular.self=circular;
    const answer=await echo(form,{date:new Date('2026-01-02T03:04:05Z'),map:new Map([['hello',42]]),set:new Set(['a','b']),big:12345678901234567890n,bytes:new Uint8Array([0,128,255]),circular,promised:Promise.resolve('awaited')},opaque);
    setResult(JSON.stringify({name:answer.name,type:answer.type,contents:answer.contents,tags:answer.tags,date:answer.date instanceof Date&&answer.date.toISOString(),map:answer.map instanceof Map&&answer.map.get('hello'),set:answer.set instanceof Set&&[...answer.set],big:typeof answer.big==='bigint'&&String(answer.big),bytes:answer.bytes instanceof Uint8Array&&[...answer.bytes],cycle:answer.circular.self===answer.circular,promised:answer.promised,temporaryReference:answer.opaque===opaque}));
  }
  return <><h1>Action protocol values</h1><form action={submit}><label>Action upload<input type="file" name="file" /></label><button type="submit">Send rich values</button></form><pre data-testid="rich-result">{result}</pre></>;
}`);
  await writeFile(path.join(rich, 'page.tsx'), "export {default} from './client';\n");
  const returned = path.join(fixture.root, 'app/action-return');
  await mkdir(returned, { recursive: true });
  await writeFile(path.join(returned, 'actions.ts'), `'use server';
import {cookies} from 'next/headers';
export async function save(step: number, label: string) {
  const store=await cookies(); const value=Number(store.get('rx-returned')?.value||'0')+step;
  store.set('rx-returned',String(value),{httpOnly:true,sameSite:'lax'});
  return {value,label};
}
export async function choose() { return save.bind(null,2); }
`);
  await writeFile(path.join(returned, 'client.tsx'), `'use client';
import {startTransition,useState} from 'react'; import {choose} from './actions';
export default function ReturnedAction() {
  const [result,setResult]=useState('');
  return <><button onClick={()=>startTransition(async()=>{
    const selected=await choose(); const answer=await selected('returned reference');
    setResult(answer.value+' / '+answer.label);
  })}>Invoke returned action</button><p data-testid="returned-result">{result}</p></>;
}`);
  await writeFile(path.join(returned, 'page.tsx'), `import {cookies} from 'next/headers'; import ReturnedAction from './client';
export default async function Page(){return <><h1>Returned Server Action</h1><p data-testid="returned-server-count">{(await cookies()).get('rx-returned')?.value||'0'}</p><ReturnedAction/></>;}
`);
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
  server = await startServer(fixture.root);
});
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/status of (404|500)/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function hydrated(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
}

test('Server Actions queue mutations, refresh server data, preserve client state, and support form hooks', async ({ page }) => {
  const errors = collectErrors(page);
  const posts = [];
  page.on('request', request => { if (request.headers()['next-action']) posts.push(request); });
  await page.goto(`${server.url}/actions`);
  await hydrated(page);
  await expect(page).toHaveTitle('Server Actions · PRNext');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__prnextActionsMarker = 'same-document'; });
  await page.getByRole('button', { name: 'Increment on server', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect(page.getByTestId('server-count')).toHaveText('2');
  await expect(page.getByTestId('action-result')).toHaveText('2 / Date / server');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();

  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`${server.url}/actions`, async route => { await held; await route.continue(); }, { times: 1 });
  await page.getByLabel('Greeting name', { exact: true }).fill('Katherine');
  await page.getByRole('button', { name: 'Save greeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(page.getByTestId('action-pending')).toHaveText('true');
  release();
  await expect(page.getByTestId('action-state')).toHaveText('Hello, Katherine! (1)');
  await expect(page.getByTestId('action-pending')).toHaveText('false');
  await expect(page.getByTestId('server-name')).toHaveText('Katherine');

  await page.getByLabel('Name', { exact: true }).fill('Grace Hopper');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByTestId('server-name')).toHaveText('Grace Hopper');
  await expect(page.getByTestId('action-state')).toHaveText('Hello, Katherine! (1)');
  await page.getByLabel('Record value', { exact: true }).fill('encrypted closure');
  await page.getByRole('button', { name: 'Save bound record', exact: true }).click();
  await expect(page.getByTestId('server-bound')).toHaveText('record-42:encrypted closure');

  await page.getByRole('button', { name: 'Test action error', exact: true }).click();
  await expect(page.getByTestId('action-error')).not.toBeEmpty();
  await expect(page.getByTestId('action-error')).not.toContainText('PRNEXT_ACTION_PRIVATE_ERROR_DO_NOT_SEND');
  await page.getByRole('button', { name: 'Increment on server', exact: true }).click();
  await expect(page.getByTestId('server-count')).toHaveText('3');
  await expect(page.getByTestId('action-result')).toHaveText('3 / Date / server');

  const beforeRedirect = posts.length;
  await page.getByRole('button', { name: 'Save and redirect', exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/actions?redirected=1`);
  await expect(page.getByTestId('server-redirect')).toHaveText('saved');
  expect(posts.length - beforeRedirect).toBe(1);
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__prnextActionsMarker)).toBe('same-document');
  await page.goBack();
  await expect(page).toHaveURL(`${server.url}/actions`);
  await expect(page.getByTestId('server-count')).toHaveText('3');
  expect(await page.evaluate(() => window.__prnextActionsMarker)).toBe('same-document');
  expect(errors).toEqual([]);
});

test('official action encoding preserves files, repeated FormData, rich values, cycles, and temporary references', async ({ page }) => {
  const errors = collectErrors(page);
  const response = await page.goto(`${server.url}/action-types`);
  expect(response.status()).toBe(200);
  await hydrated(page);
  await page.getByLabel('Action upload').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello from a browser upload!') });
  await page.getByRole('button', { name: 'Send rich values', exact: true }).click();
  await expect(page.getByTestId('rich-result')).not.toBeEmpty();
  expect(JSON.parse(await page.getByTestId('rich-result').textContent())).toEqual({
    name: 'hello.txt', type: 'text/plain', contents: 'Hello from a browser upload!', tags: ['one', 'two'],
    date: '2026-01-02T03:04:05.000Z', map: 42, set: ['a', 'b'], big: '12345678901234567890',
    bytes: [0, 128, 255], cycle: true, promised: 'awaited', temporaryReference: true,
  });
  expect(errors).toEqual([]);
});

test('forms work without JavaScript, including useActionState, encrypted closures, and redirects', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${server.url}/actions`);
    await page.getByLabel('Greeting name', { exact: true }).fill('Marie');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save greeting', exact: true }).click()]);
    await expect(page.getByTestId('server-name')).toHaveText('Marie');
    await expect(page.getByTestId('action-state')).toHaveText('Hello, Marie! (1)');
    await page.getByLabel('Greeting name', { exact: true }).fill('Rosalind');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save greeting', exact: true }).click()]);
    await expect(page.getByTestId('action-state')).toHaveText('Hello, Rosalind! (2)');
    await page.getByLabel('Record value', { exact: true }).fill('without javascript');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save bound record', exact: true }).click()]);
    await expect(page.getByTestId('server-bound')).toHaveText('record-42:without javascript');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save and redirect', exact: true }).click()]);
    await expect(page).toHaveURL(`${server.url}/actions?redirected=1`);
    await expect(page.getByTestId('server-redirect')).toHaveText('saved');
  } finally { await context.close(); }
});

test('a native form response hydrates useActionState and continues with enhanced submissions', async ({ page }) => {
  await page.route('**/_prnext/assets/*.js', route => route.abort());
  await page.goto(`${server.url}/actions`, { waitUntil: 'networkidle' });
  await page.getByLabel('Greeting name', { exact: true }).fill('Dorothy');
  // Initial scripts failed to load. Allow the following document's scripts so
  // hydration must consume formState from the native POST's Flight payload.
  await page.unroute('**/_prnext/assets/*.js');
  const errors = collectErrors(page);
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save greeting', exact: true }).click()]);
  await hydrated(page);
  await expect(page.getByTestId('action-state')).toHaveText('Hello, Dorothy! (1)');
  await page.evaluate(() => { window.__prnextFormStateMarker = true; });
  await page.getByLabel('Greeting name', { exact: true }).fill('Annie');
  await page.getByRole('button', { name: 'Save greeting', exact: true }).click();
  await expect(page.getByTestId('action-state')).toHaveText('Hello, Annie! (2)');
  await expect(page.getByTestId('server-name')).toHaveText('Annie');
  expect(await page.evaluate(() => window.__prnextFormStateMarker)).toBe(true);
  expect(errors).toEqual([]);
});

test('queued mutations finish without canceling a newer navigation', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`${server.url}/actions`);
  await hydrated(page);
  let releaseAction, releaseNavigation;
  const actionGate = new Promise(resolve => { releaseAction = resolve; });
  const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
  await page.route(`${server.url}/actions`, async route => { await actionGate; await route.continue().catch(() => {}); }, { times: 1 });
  await page.route(`${server.url}/about`, async route => { await navigationGate; await route.continue().catch(() => {}); }, { times: 1 });
  let completed = 0;
  page.on('response', response => { if (response.request().headers()['next-action']) completed++; });
  const firstAction = page.waitForRequest(request => Boolean(request.headers()['next-action']));
  await page.getByRole('button', { name: 'Increment on server', exact: true }).evaluate(button => { button.click(); button.click(); });
  await firstAction;
  const navigation = page.waitForRequest(request => request.url() === `${server.url}/about` && request.headers().rsc === '1');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await navigation;
  releaseAction();
  await expect.poll(() => completed).toBe(2);
  releaseNavigation();
  await expect(page).toHaveURL(`${server.url}/about`);
  await expect(page.getByTestId('pathname')).toHaveText('/about');
  await page.getByRole('link', { name: 'Actions', exact: true }).click();
  await expect(page.getByTestId('server-count')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('a Server Action can return a bound local action that the browser invokes through Flight', async ({ page }) => {
  const errors = collectErrors(page);
  const actionIds = [];
  page.on('request', request => {
    const id = request.headers()['next-action'];
    if (id) actionIds.push(id);
  });
  await page.goto(`${server.url}/action-return`);
  await hydrated(page);
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__prnextReturnedActionMarker = true; });
  await page.getByRole('button', { name: 'Invoke returned action', exact: true }).click();
  await expect(page.getByTestId('returned-result')).toHaveText('2 / returned reference');
  await expect(page.getByTestId('returned-server-count')).toHaveText('2');
  expect(actionIds).toHaveLength(2);
  expect(actionIds[0]).not.toBe(actionIds[1]);
  await page.getByRole('button', { name: 'Invoke returned action', exact: true }).click();
  await expect(page.getByTestId('returned-result')).toHaveText('4 / returned reference');
  await expect(page.getByTestId('returned-server-count')).toHaveText('4');
  expect(actionIds).toEqual([actionIds[0], actionIds[1], actionIds[0], actionIds[1]]);
  expect((await page.context().cookies(server.url)).find(cookie => cookie.name === 'rx-returned')?.value).toBe('4');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__prnextReturnedActionMarker)).toBe(true);
  expect(errors).toEqual([]);
});
