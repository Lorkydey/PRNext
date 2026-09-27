import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from './support.mjs';

test('Server Action configured body limits and origin patterns survive middleware header replacement', async () => {
  const fixture = await appFixture();
  let server;
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default {experimental:{serverActions:{bodySizeLimit:'2mb',allowedOrigins:['*.example.test','**.deep.example.test','allowed.example.test:8443']}}}`,
      'proxy.ts': `import{NextResponse}from'next/server';export function proxy(request){const headers=new Headers(request.headers);headers.delete('origin');headers.delete('sec-fetch-site');headers.set('x-changed','yes');return NextResponse.next({request:{headers}})}export const config={matcher:'/'};`,
      'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
      'app/actions.ts': `'use server';import{appendFileSync}from'node:fs';export async function mutate(input){const value=input instanceof FormData?input.get('value'):input;const length=String(value).length;appendFileSync('.configured-action-calls',length+'\\n');return {length}}`,
      'app/page.jsx': `import{mutate}from'./actions';export default()=> <form action={mutate}><input name="value"/><button>Save</button></form>`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
    const manifest = JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    const [id] = Object.keys(manifest.app.actions);
    server = await startServer(fixture.root);
    const post = (origin, body = '["allowed"]') => fetch(server.url, { method: 'POST', headers: { origin, 'Next-Action': id, 'content-type': 'text/plain' }, body });
    for (const origin of ['https://portal.example.test', 'https://a.b.deep.example.test', 'https://allowed.example.test:8443', server.url]) {
      const response = await post(origin); assert.equal(response.status, 200, await response.clone().text()); assert.match(await response.text(), /actionResult/);
    }
    const before = await readFile(path.join(fixture.root, '.configured-action-calls'), 'utf8');
    for (const origin of ['https://example.test', 'https://portal.example.test:8443', 'https://portal.example.test.evil', 'https://a.b.example.test', 'https://user@portal.example.test', 'null']) {
      const response = await post(origin); assert.equal(response.status, 403); await response.body.cancel();
    }
    assert.equal(await readFile(path.join(fixture.root, '.configured-action-calls'), 'utf8'), before, 'rejected origins cannot invoke a mutation');
    const large = await post('https://portal.example.test', JSON.stringify(['x'.repeat(1200 * 1024)]));
    assert.equal(large.status, 200, await large.clone().text()); assert.match(await large.text(), /1228800/);
    const form = new FormData(); form.set(`$ACTION_ID_${id}`, ''); form.set('value', 'x'.repeat(1100 * 1024));
    const submitted = await fetch(server.url, { method: 'POST', headers: { origin: 'https://portal.example.test' }, body: form });
    assert.equal(submitted.status, 200, await submitted.clone().text()); await submitted.body.cancel();
    const calls = await readFile(path.join(fixture.root, '.configured-action-calls'), 'utf8');
    const tooLarge = await post('https://portal.example.test', 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal(tooLarge.status, 413); await tooLarge.body.cancel();
    assert.equal(await readFile(path.join(fixture.root, '.configured-action-calls'), 'utf8'), calls);
  } finally { await server?.close(); await fixture.remove(); }
});
