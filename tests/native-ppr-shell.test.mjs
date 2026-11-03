import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {appFixture, startServer, repositoryRoot} from './support.mjs';

test('native PPR emits a certified shell while Node initialization is gated, then resumes and honors persisted invalidation', {timeout: 180000}, async () => {
  const fixture = await appFixture();
  let server;
  const release = path.join(fixture.root, 'release-node-test');
  const started = path.join(fixture.root, 'node-test-started');
  try {
    for (const directory of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, directory), {recursive: true, force: true});
    const files = {
      'public/robots.txt': 'User-agent: *\nDisallow:',
      'prnext.config.mjs': 'export default {cacheComponents:true,experimental:{nativePprShell:true}}',
      'instrumentation.js': `import{access,writeFile}from'node:fs/promises';export async function register(){if(!process.env.PRNEXT_TEST_PPR_GATE)return;await writeFile(${JSON.stringify(started)},'started');const until=Date.now()+30000;for(;;){try{await access(process.env.PRNEXT_TEST_PPR_GATE);return}catch{if(Date.now()>until)throw Error('Test gate expired');await new Promise(r=>setTimeout(r,20))}}}`,
      'app/layout.jsx': `import{randomUUID}from'node:crypto';export default({children})=><html><head/><body><header>{'Built '+randomUUID()}</header>{children}</body></html>`,
      'app/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';async function Personal(){return <p data-testid="personal">{(await cookies()).get('name')?.value||'guest'}</p>}export default()=> <main><h1>Native public shell</h1><Suspense fallback={<p>Waiting for Node</p>}><Personal/></Suspense></main>`,
      'app/invalidate/route.js': `import{revalidatePath}from'next/cache';export async function POST(){revalidatePath('/','layout');return Response.json({ok:true})}`,
    };
    for (const [name, source] of Object.entries(files)) {
      const filename = path.join(fixture.root, name);
      await mkdir(path.dirname(filename), {recursive: true});
      await writeFile(filename, source);
    }
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], {maxBuffer: 8 * 1024 * 1024});
    const manifest = JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    assert.equal(manifest.config.nativePprArtifacts.length, 1);
    const descriptor = manifest.config.nativePprArtifacts[0];
    const expectedPrefix = await readFile(path.join(fixture.root, '.prnext', descriptor.prefix), 'utf8');
    server = await startServer(fixture.root, [], {PRNEXT_TEST_PPR_GATE: release});
    await assert.rejects(access(started), /ENOENT/, 'static readiness does not wake Node');
    const response = await fetch(server.url, {signal: AbortSignal.timeout(20000)});
    assert.equal(response.headers.get('x-prnext-native-ppr'), '1');
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(!first.done);
    const firstText = Buffer.from(first.value).toString();
    assert.equal(firstText, expectedPrefix, 'exact build prefix arrives while the real Node worker is gated');
    await writeFile(release, 'resume');
    const chunks = [Buffer.from(first.value)];
    for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
    const html = Buffer.concat(chunks).toString();
    assert.match(html, />guest</);
    assert.match(html, /<\/body><\/html>$/);
    assert.equal(html.split('<h1>Native public shell</h1>').length, 2, 'prefix is emitted exactly once');
    assert.equal(html.split('<html>').length, 2, 'continuation does not append another document');
    for (const [url, headers] of [[server.url + '/?q=private', {}], [server.url, {cookie: 'name=Ada'}], [server.url, {authorization: 'Bearer test'}], [server.url, {rsc: '1'}], [server.url, {'content-security-policy': "script-src 'nonce-example'"}], [server.url, {'x-prnext-native-ppr': 'forged'}]]) {
      const fallback = await fetch(url, {headers});
      assert.equal(fallback.headers.get('x-prnext-native-ppr'), null);
      const body = await fallback.text();
      if (headers.cookie) assert.match(body, /Ada/);
      assert.equal(fallback.status, 200);
    }
    const head = await fetch(server.url, {method: 'HEAD'});
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('x-prnext-native-ppr'), null);
    const invalidation = await fetch(server.url + '/invalidate', {method: 'POST'});
    assert.equal(invalidation.status, 200);
    assert.equal((await invalidation.json()).ok, true);
    const after = await fetch(server.url);
    assert.equal(after.headers.get('x-prnext-native-ppr'), null, 'invalidation disables the build snapshot');
    assert.equal(after.status, 200);
    await after.text();
    await server.close(); server = undefined;
    server = await startServer(fixture.root);
    const restarted = await fetch(server.url);
    assert.equal(restarted.headers.get('x-prnext-native-ppr'), null, 'generation is persistent across process restarts');
    assert.equal(restarted.status, 200);
    await restarted.text();
  } finally {
    await writeFile(release, 'resume').catch(() => {});
    await server?.close();
    await fixture.remove();
  }
});
