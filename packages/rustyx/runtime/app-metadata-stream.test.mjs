import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderAppPage, renderFlight, decodeFlight, closeAppRuntime } from './app-render.mjs';
import { renderAppRecoveryShell } from './app-recovery.mjs';

test('extended async metadata survives streamed HTML, Flight and recovery with the visible canonical pathname', async () => {
  const root = await mkdtemp(fileURLToPath(new URL('./.metadata-test-', import.meta.url)));
  const modulePath = `${root}/page.mjs`;
  try {
    await writeFile(modulePath, `
      import React from 'react';
      export const segments=[{layout:{metadata:{metadataBase:new URL('https://example.com/base')},default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
      export const page={default:()=>React.createElement('h1',null,'Article'),async generateMetadata(){
        await new Promise(resolve=>setTimeout(resolve,5));
        return {title:'Extended',verification:{google:['first','second']},alternates:{canonical:'./',types:{'application/rss+xml':[{url:'/feed.xml',title:'Feed'}]}},openGraph:{type:'article',authors:['author'],publishedTime:'2026-09-23'},twitter:{card:'player',players:{playerUrl:'https://example.com/player',streamUrl:'https://example.com/stream',width:640,height:360}},appLinks:{web:{url:'https://example.com',should_fallback:false}}};
      }};
    `);
    const options = { modulePath, distDir: root, manifest: { config: { basePath: '/docs' }, app: { clientModules: {} } }, route: { client: '/client.js' }, url: 'http://localhost/internal', originalUrl: 'http://localhost/docs/visible?ignored=yes', params: {}, stream: true };
    const response = await renderAppPage(options);
    let html = '';
    for await (const chunk of response.body) html += Buffer.from(chunk).toString('utf8');
    assert.equal(response.status, 200);
    assert.match(html, /rel="canonical" href="https:\/\/example.com\/base\/visible"/);
    assert.match(html, /name="google-site-verification" content="first"/);
    assert.match(html, /property="article:author" content="author"/);
    assert.match(html, /name="twitter:player:width" content="640"/);
    assert.match(html, /property="al:web:should_fallback" content="false"/);
    const flight = await renderFlight({ ...options, basePath: options.manifest.config.basePath, stream: false });
    const model = await decodeFlight(flight.body, {}, root);
    const recovery = await renderAppRecoveryShell(model.head);
    assert.match(recovery, /<title>Extended<\/title>/);
    assert.match(recovery, /rel="canonical" href="https:\/\/example.com\/base\/visible"/);
    assert.match(recovery, /property="article:author" content="author"/);
    assert.match(recovery, /name="robots" content="noindex"/);
  } finally {
    await closeAppRuntime();
    await rm(root, { recursive: true, force: true });
  }
});
