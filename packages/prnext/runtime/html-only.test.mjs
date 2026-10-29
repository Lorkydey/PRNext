import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHtmlOnlyDocument } from './html-only.mjs';
import {renderAppPage} from './app-render.mjs';
import {renderAppIsrPage} from './app-static.mjs';

test('HTML-only output allows static CSS/fonts/metadata and text while refusing executable or action markup', () => {
  const html='<!doctype html><html><head><title>Text</title><link rel="stylesheet" href="/a.css"><link rel="preload" as="font" href="/a.woff2"></head><body><a href="/next">Next</a><p>onclick=&quot;text&quot;</p></body></html>';
  assert.equal(assertHtmlOnlyDocument(html),html);
  for(const bad of ['<script/>','<script/x>bad()</script>','<script//>bad()</script>','<iframe/x src="/bad">','<script type="application/ld+json">{}</script>','<img onerror="bad()">','<a href="javascript:bad()">Bad</a>','<a href="java&#x73;cript&#58;bad()">Bad</a>','<iframe srcdoc="bad">','<input name="$ACTION_ID_x">','<link rel="modulepreload" href="/a.js">','<link rel="preload" as="script" href="/a.js">','<link rel="prefetch modulepreload" href="/a.js">','<link rel="prefetch&#32;mOdulepreload" href="/a.js">','<link rel="preload" as="s&#99;ript" href="/a.js">','<link rel="preload" as="script" as="image" href="/a.js">'])assert.throws(()=>assertHtmlOnlyDocument(bad,'/bad'),/htmlOnly/);
});

test('HTML-only runtime never falls back to a hydrated SSR/Flight response or request-time ISR', async () => {
  const route={htmlOnly:true,pattern:'/legal'};
  for(const headers of [{},{RSC:'1'},{'Next-Action':'must-not-run'}]) {
    const response=await renderAppPage({modulePath:'/missing/not-loaded.mjs',route,headers});
    assert.equal(response.status,409);assert.equal(response.headers['x-prnext-document-navigation'],'1');assert.equal(response.headers['cache-control'],'private, no-store');
    assert.doesNotMatch(response.body.toString(),/<script|__PRNEXT_|text\/x-component/);
  }
  await assert.rejects(renderAppIsrPage({route}),/cannot use ISR/);
});
