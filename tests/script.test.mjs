import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { scriptFixture } from './script-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await scriptFixture(); await fixture.build(); server = await startServer(fixture.root); });
beforeEach(() => fixture.counts.clear());
after(async () => { await server?.close(); await fixture?.remove(); });
const scripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(match => ({ attributes: match[1], content: match[2], index: match.index }));
async function document(route) {
  const response = await fetch(`${server.url}/docs${route}`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(response.status, 200);
  return response.text();
}

test('Pages Document puts inline beforeInteractive scripts in head and deferred sources before the hydration entry', async () => {
  const html = await document('/pages');
  const tags = scripts(html);
  const inline = tags.filter(tag => /id="inline-(?:first|second)"/.test(tag.attributes));
  assert.equal(inline.length, 2);
  assert.ok(inline.every(tag => tag.index < html.indexOf('</head>')));
  assert.match(inline[0].content, /inline-first:exec/);
  assert.match(inline[1].content, /inline-second:exec/);
  const external = tags.filter(tag => /id="external-(?:first|second)"/.test(tag.attributes));
  assert.equal(external.length, 2);
  const bootstrap = tags.find(tag => /type="module"/.test(tag.attributes) && /src=/.test(tag.attributes));
  assert.ok(bootstrap, 'the normal Pages entry remains present');
  for (const tag of external) {
    assert.match(tag.attributes, /\bdefer(?:\s|=|$)/);
    assert.match(tag.attributes, /data-nscript="beforeInteractive"/);
    assert.ok(tag.index < bootstrap.index);
  }
  assert.ok(external[0].attributes.includes(`${fixture.originURL}/before-first.js`));
  assert.ok(external[1].attributes.includes(`${fixture.originURL}/before-second.js`));
  assert.match(external[0].attributes, /nonce="script-nonce"/);
  assert.equal(fixture.counts.size, 0, 'rendering the page never downloads or evaluates user scripts on the server');
});

test('App beforeInteractive preserves mixed inline/external order in a serialized bootstrap queue', async () => {
  const html = await document('/app');
  const tags = scripts(html);
  const queue = tags.filter(tag => tag.content.includes('__RUSTYX_SCRIPTS__'));
  assert.equal(queue.length, 4);
  assert.match(queue[0].content, /inline-first:exec/);
  assert.ok(queue[1].content.includes(`${fixture.originURL}/before-first.js`));
  assert.match(queue[2].content, /inline-second:exec/);
  assert.ok(queue[3].content.includes(`${fixture.originURL}/before-second.js`));
  assert.ok(!tags.some(tag => tag.attributes.includes(`${fixture.originURL}/before-first.js`)), 'App loads the beforeInteractive source through its bootstrap sequence');
  assert.match(queue[0].attributes, /nonce="script-nonce"/);
  assert.equal(fixture.counts.size, 0);
});

for (const router of ['pages', 'app']) {
  test(`${router} leaves afterInteractive and lazyOnload execution to the browser`, async () => {
    const html = await document(`/${router}`);
    const tags = scripts(html);
    assert.ok(!tags.some(tag => /\bid="(?:after|lazy|duplicate-one|duplicate-two|inline-after|missing)"/.test(tag.attributes)));
    assert.ok(!tags.some(tag => /\bsrc="[^"]*\/(?:after|lazy|duplicate|missing)\.js"/.test(tag.attributes)));
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map(match => match[0]);
    const style = links.filter(tag => tag.includes(`${fixture.originURL}/after.css`) && /rel="stylesheet"/.test(tag));
    const preload = links.filter(tag => tag.includes(`${fixture.originURL}/after.js`) && /rel="preload"/.test(tag) && /as="script"/.test(tag));
    assert.equal(style.length, router === 'app' ? 1 : 0);
    assert.equal(preload.length, router === 'app' ? 1 : 0);
    assert.ok(!links.some(tag => tag.includes(`${fixture.originURL}/lazy.js`)), 'lazyOnload is not speculatively downloaded during SSR');
    assert.equal(fixture.counts.size, 0);
  });
}
