import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderAppPage, renderFlight, closeAppRuntime } from './app-render.mjs';

const fixtures = [];
after(async () => {
  await closeAppRuntime();
  await Promise.all(fixtures.map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(source) {
  const directory = await mkdtemp(fileURLToPath(new URL('./.cache-rsc-test-', import.meta.url)));
  fixtures.push(directory);
  const modulePath = path.join(directory, 'page.mjs');
  await writeFile(modulePath, source);
  return { modulePath, distDir: directory, url: 'http://app.test/missing', production: true };
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a not-found fallback shares GET fetch memoization with its initial render and layouts', async () => {
  let requests = 0;
  const origin = createServer((_request, response) => response.end(`origin-${++requests}`));
  try {
    const url = await listen(origin);
    const options = await fixture(`
      import React from 'react';
      import {notFound} from '../../compat/navigation-server.cjs';
      async function read(){return (await fetch(${JSON.stringify(url)}, {cache:'no-store'})).text();}
      export const page={default:async()=>{await read();notFound();}};
      export const segments=[{
        layout:{default:async({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',{'data-layout':await read()},children))},
        notFound:{default:async()=>React.createElement('h1',null,'Missing: '+await read())},
      }];
    `);
    const result = await renderAppPage(options);
    assert.equal(result.status, 404);
    assert.match(result.body.toString(), /Missing: origin-1/);
    assert.match(result.body.toString(), /data-layout="origin-1"/);
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => origin.close(resolve)); }
});

test('an import failure still completes already-started stale cache refreshes', async () => {
  await closeAppRuntime();
  let releaseOrigin;
  let originStarted;
  const held = new Promise(resolve => { releaseOrigin = resolve; });
  const started = new Promise(resolve => { originStarted = resolve; });
  const origin = createServer(async (_request, response) => {
    originStarted();
    await held;
    response.end('fresh');
  });
  let committed = false;
  const cacheServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const operation = JSON.parse(Buffer.concat(chunks));
    let result;
    if (operation.op === 'read') result = { state: 'stale', value: Buffer.from('{"value":"stale"}').toString('base64'), lease: 'import-lease' };
    else if (operation.op === 'commit') { committed = true; result = { stored: true }; }
    else result = { released: true };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  const previous = { url: process.env.PRNEXT_CACHE_URL, token: process.env.PRNEXT_CACHE_TOKEN };
  try {
    const originUrl = await listen(origin);
    process.env.PRNEXT_CACHE_URL = await listen(cacheServer);
    process.env.PRNEXT_CACHE_TOKEN = 'test';
    const options = await fixture(`
      import {unstable_cache} from '../../compat/cache.cjs';
      await unstable_cache(async()=>{return (await fetch(${JSON.stringify(originUrl)})).text();},['import-work'])();
      throw new Error('import failed after starting cache work');
    `);
    let completed = false;
    const rendering = renderFlight(options).finally(() => { completed = true; });
    rendering.catch(() => {});
    await started;
    await delay(20);
    assert.equal(completed, false);
    releaseOrigin();
    await assert.rejects(rendering, /import failed after starting cache work/);
    assert.equal(committed, true);
  } finally {
    releaseOrigin();
    await closeAppRuntime();
    if (previous.url === undefined) delete process.env.PRNEXT_CACHE_URL;
    else process.env.PRNEXT_CACHE_URL = previous.url;
    if (previous.token === undefined) delete process.env.PRNEXT_CACHE_TOKEN;
    else process.env.PRNEXT_CACHE_TOKEN = previous.token;
    await Promise.all([origin, cacheServer].map(server => new Promise(resolve => server.close(resolve))));
  }
});
