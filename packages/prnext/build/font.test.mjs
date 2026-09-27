import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './index.mjs';
import { fontFixture, mockGoogleFonts } from '../../../tests/font-fixture.mjs';

test('font builds share local values across Pages/App graphs, emit immutable files and preload route dependencies', async () => {
  const fixture = await fontFixture();
  try {
    const { manifest, requests } = await fixture.build();
    const assets = path.join(manifest.outputDirectory, 'assets');
    const files = await readdir(assets);
    const fonts = files.filter(file => file.startsWith('font-') && file.endsWith('.ttf'));
    assert.equal(fonts.length, 1, 'identical font bytes are shared across local/google calls');
    assert.deepEqual(await readFile(path.join(assets, fonts[0])), await readFile(path.join(fixture.root, 'fonts/local.ttf')));
    const pages = manifest.routes.find(route => route.pattern === '/pages');
    const app = manifest.routes.find(route => route.pattern === '/app');
    const other = manifest.routes.find(route => route.pattern === '/other');
    assert.equal(pages.fonts.length, 1);
    assert.equal(app.fonts.length, 1);
    assert.equal(other.fonts, undefined, 'preload:false omits the hint');
    assert.equal(pages.fonts[0].href, `/resources/_prnext/assets/${fonts[0]}`);
    const css = (await Promise.all(files.filter(file => file.endsWith('.css')).map(file => readFile(path.join(assets, file), 'utf8')))).join('\n');
    assert.match(css, /--font-body/);
    assert.match(css, /--font-google/);
    assert.match(css, /ascent-override/);
    assert.match(css, /size-adjust/);
    assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
    assert.ok(requests.some(url => url.includes('Inter:opsz,wght@14..32,100..900&display=swap')));
    assert.equal(requests.filter(url => url.includes('googleapis')).length, 1, 'the font call is compiled once across graphs');
    const scripts = (await Promise.all(files.filter(file => file.endsWith('.js')).map(file => readFile(path.join(assets, file), 'utf8')))).join('\n');
    assert.doesNotMatch(scripts, /fonts\.googleapis\.com|fonts\.gstatic\.com|node:fs|fontkit/);
    const { default: Page } = await import(pathToFileURL(path.join(manifest.outputDirectory, other.module)).href);
    const returned = Page();
    const className = returned.props.children[0].props.className;
    assert.match(css, new RegExp(className));
    const prerendered = manifest.prerendered.find(entry => entry.path === '/app');
    const html = await readFile(path.join(manifest.outputDirectory, prerendered.file), 'utf8');
    assert.match(html, /rel="preload" as="font"/);
    assert.match(html, /crossorigin="anonymous"/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  } finally { await fixture.remove(); }
});

test('invalid font calls fail at build and keep the last successful output', async () => {
  const fixture = await fontFixture();
  try {
    const { manifest } = await fixture.build();
    const previous = await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8');
    const source = path.join(fixture.root, 'pages/other.jsx');
    for (const [code, pattern] of [
      [`import f from 'next/font/local';const src='../fonts/local.ttf';const font=f({src});export default()=> <p/>`, /statically written literals/],
      [`import f from 'next/font/local';export default function Page(){const font=f({src:'../fonts/local.ttf'});return <p/>}`, /module scope/],
      [`import {Inter} from 'next/font/google';const font=Inter({weight:'1500',preload:false});export default()=> <p/>`, /Invalid weight/],
      [`import {Inter} from 'next/font/google';const font=Inter({});export default()=> <p/>`, /specify subsets/],
      [`import f from 'next/font/local';const font=f({src:'../fonts/local.ttf',variable:'body;color:red'});export default()=> <p/>`, /CSS custom property/],
    ]) {
      await writeFile(source, code);
      await mockGoogleFonts(() => assert.rejects(build(fixture.root), pattern));
      assert.equal(await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8'), previous);
    }
  } finally { await fixture.remove(); }
});

test('Google font build download failures never leave external runtime URLs or replace a valid build', async () => {
  const fixture = await fontFixture();
  try {
    const { manifest } = await fixture.build();
    const saved = await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8');
    const original = globalThis.fetch;
    globalThis.fetch = async input => { if (String(input).startsWith('https://fonts.googleapis.com')) return new Response('unavailable', { status: 503 }); return original(input); };
    try { await assert.rejects(build(fixture.root), /HTTP 503/); }
    finally { globalThis.fetch = original; }
    assert.equal(await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8'), saved);
  } finally { await fixture.remove(); }
});
