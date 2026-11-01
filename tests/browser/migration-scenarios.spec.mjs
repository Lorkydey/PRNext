import { test as base } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runMigrationScenarios } from '../../packages/prnext/build/migration-scenarios.mjs';

const test = base.extend({ cleanup: async ({}, use) => {
  const callbacks = [];
  try { await use({ after: callback => callbacks.push(callback) }); }
  finally { for (const callback of callbacks.reverse()) await callback(); }
} });

const require = createRequire(import.meta.url);
async function fixture(t, source, withPlaywright = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-browser-audit-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(path.join(root, 'package.json'), '{"name":"scenario-app","type":"module"}');
  await writeFile(path.join(root, 'scenarios.mjs'), source);
  if (withPlaywright) {
    await mkdir(path.join(root, 'node_modules/@playwright'), { recursive: true });
    await symlink(path.dirname(require.resolve('@playwright/test/package.json')), path.join(root, 'node_modules/@playwright/test'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
}
async function server(t) {
  const requests = [], instance = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    const authorized = (req.headers.cookie || '').includes('session=fixture');
    const html = text => { res.setHeader('content-type', 'text/html'); res.end(text); };
    if (req.url === '/login' && req.method === 'POST') {
      for await (const _ of req) {} // Consume without recording credentials.
      res.writeHead(303, { 'set-cookie': 'session=fixture; HttpOnly; Path=/', location: '/dashboard' }); res.end();
    } else if (req.url === '/note' && req.method === 'POST' && authorized) {
      res.writeHead(303, { location: '/saved' }); res.end();
    } else if (req.url === '/logout' && req.method === 'POST') {
      res.writeHead(303, { 'set-cookie': 'session=; Max-Age=0; HttpOnly; Path=/', location: '/login' }); res.end();
    } else if (req.url === '/dashboard' && authorized) html('<h1>Dashboard</h1><form action="/note" method="post"><button>Save note</button></form>');
    else if (req.url === '/saved' && authorized) html('<h1>Saved</h1><form action="/logout" method="post"><button>Log out</button></form>');
    else html('<h1>Sign in</h1><form action="/login" method="post"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>');
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}

test('real browser scenarios independently exercise login, authenticated POST and logout with isolated contexts', async ({ cleanup: t }) => {
  test.setTimeout(45000);
  const reference = await server(t), candidate = await server(t);
  const directory = await fixture(t, `import assert from 'node:assert/strict';
console.log('DO NOT PRINT fixture-secret-password');
export default [{id:'login-action-logout',run:async({page,baseURL})=>{
  await page.goto(baseURL+'/login');
  assert.equal(await page.evaluate(()=>localStorage.getItem('visited')),null);
  await page.evaluate(()=>localStorage.setItem('visited','true'));
  await page.getByLabel('Password').fill('fixture-secret-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Dashboard'}).waitFor();
  await page.getByRole('button',{name:'Save note'}).click();
  await page.getByRole('heading',{name:'Saved',exact:true}).waitFor();
  await page.getByRole('button',{name:'Log out'}).click();
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
}}, {id:'isolation',run:async({page,baseURL})=>{
  await page.goto(baseURL+'/dashboard');
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('visited')),null);
}}];`);
  const result = await runMigrationScenarios({ directory, against: reference.url, candidate: candidate.url, scenarios: 'scenarios.mjs', timeout: 5000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'checked');
  assert.deepEqual(result.results.map(({ scenario, target, status }) => ({ scenario, target, status })), [
    { scenario: 1, target: 'reference', status: 'passed' }, { scenario: 1, target: 'candidate', status: 'passed' },
    { scenario: 2, target: 'reference', status: 'passed' }, { scenario: 2, target: 'candidate', status: 'passed' },
  ]);
  for (const instance of [reference, candidate]) assert.deepEqual(instance.requests.filter(item => item.method === 'POST').map(item => item.url), ['/login', '/note', '/logout']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|session=|Sign in|127\.0\.0\.1|DO NOT PRINT/);
});

test('raw application errors and messages never enter the report', async ({ cleanup: t }) => {
  const directory = await fixture(t, "export default[{run:async()=>{console.error('Bearer fixture-private-token');throw new Error('password=fixture-private-token')}}]");
  const result = await runMigrationScenarios({ directory, against: 'http://127.0.0.1:1', candidate: 'http://127.0.0.1:2', scenarios: 'scenarios.mjs', timeout: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every(item => item.reason === 'assertion-or-runtime-failure'), true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|Bearer|password=/);
});

test('migration CLI presents both browser targets and keeps JSON machine-readable', async ({ cleanup: t }) => {
  test.setTimeout(45000);
  const reference = await server(t), candidate = await server(t);
  const directory = await fixture(t, "export default[{run:async({page,baseURL})=>{await page.goto(baseURL+'/login');await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor()}}]");
  await mkdir(path.join(directory, 'pages'));
  await writeFile(path.join(directory, 'pages/login.jsx'), 'export default function Page(){return <h1>Sign in</h1>}');
  const cli = fileURLToPath(new URL('../../packages/prnext/cli.mjs', import.meta.url));
  const args = [cli, 'migrate', directory, '--check', '--against', reference.url, '--candidate', candidate.url, '--browser-scenarios', 'scenarios.mjs'];
  const run = promisify(execFile);
  const text = await run(process.execPath, args, { windowsHide: true, timeout: 30000, maxBuffer: 2e6 });
  assert.match(text.stdout, /BROWSER 1 \(reference\): passed/);
  assert.match(text.stdout, /BROWSER 1 \(candidate\): passed/);
  assert.doesNotMatch(text.stdout, /BROWSER undefined/);
  const json = await run(process.execPath, [...args, '--json'], { windowsHide: true, timeout: 30000, maxBuffer: 2e6 });
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.browser.ok, true);
  assert.equal(report.browser.results.length, 2);
});

test('a suspended browser scenario times out, closes its context and stops before another target', async ({ cleanup: t }) => {
  const directory = await fixture(t, "export default[{run:async()=>new Promise(()=>{})}]");
  const started = Date.now();
  const result = await runMigrationScenarios({ directory, against: 'http://127.0.0.1:1', candidate: 'http://127.0.0.1:2', scenarios: 'scenarios.mjs', timeout: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.results, [{ scenario: 1, target: 'reference', status: 'failed', reason: 'timeout' }]);
  assert.ok(Date.now() - started < 20000);
});

test('the global worker budget stops synchronous callbacks and their owned browser process tree', async ({ cleanup: t }) => {
  test.setTimeout(50000);
  const directory = await fixture(t, 'export default[{run:async()=>{for(;;){}}}];');
  const started = Date.now();
  const result = await runMigrationScenarios({ directory, against: 'http://127.0.0.1:1', candidate: 'http://127.0.0.1:2', scenarios: 'scenarios.mjs', timeout: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'worker-timeout');
  assert.ok(Date.now() - started < 45000);
});
