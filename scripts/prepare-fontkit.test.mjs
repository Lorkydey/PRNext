import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {create as original} from 'fontkit';
import {create} from '../packages/prnext/vendor/fontkit/index.mjs';
import {prepareFontkit} from './prepare-fontkit.mjs';
import {verifyVendoredFontkit} from '../packages/prnext/release/fontkit.mjs';

const vendor = new URL('../packages/prnext/vendor/fontkit/', import.meta.url);
const run = promisify(execFile);

function metrics(font) {
  return {type: font.type, postscriptName: font.postscriptName, unitsPerEm: font.unitsPerEm,
    ascent: font.ascent, descent: font.descent, lineGap: font.lineGap,
    characters: font.characterSet, glyphs: font.glyphsForString('aab é').map(glyph => ({id: glyph.id,
      advanceWidth: glyph.advanceWidth, bbox: {...glyph.bbox}, path: glyph.path.toSVG()})),
    layout: font.layout('aab é').positions.map(position => ({...position}))};
}

test('the reviewed minimal fontkit bundle reproduces offline with every license and locked input', async () => {
  const result = await prepareFontkit({check: true});
  assert.equal(result.packages, 12);
  assert.ok(result.bytes < 850_000);
  const provenance = JSON.parse(await readFile(new URL('upstream.json', vendor), 'utf8'));
  assert.equal(provenance.packages.fontkit.license, 'MIT');
  assert.equal(provenance.packages['@swc/helpers'].license, 'Apache-2.0');
  for (const metadata of Object.values(provenance.packages)) assert.match(metadata.integrity, /^sha512-/);
  assert.match(await readFile(new URL('SOURCE-NOTICES.txt', vendor), 'utf8'), /Copyright 2013 Google/);
  assert.ok(Object.keys(provenance.files).some(name => name.endsWith('@swc__helpers/LICENSE')));
});

for (const extension of ['ttf', 'otf', 'woff', 'woff2', 'ttc', 'dfont']) {
  test(`vendored fontkit keeps exact ${extension} metrics, outlines, layout and collection selection`, async () => {
    const bytes = await readFile(new URL(`../tests/fixtures/fontkit/fixture.${extension}`, import.meta.url));
    const actual = create(bytes), expected = original(bytes);
    if (['ttc', 'dfont'].includes(extension)) {
      assert.equal(actual.fonts.length, extension === 'ttc' ? 2 : 1);
      assert.deepEqual(actual.fonts.map(metrics), expected.fonts.map(metrics));
      const postscriptName = actual.fonts.at(-1).postscriptName;
      assert.deepEqual(metrics(create(bytes, postscriptName)), metrics(original(bytes, postscriptName)));
      assert.equal(actual.getFont('not-present'), null);
    } else {
      assert.deepEqual(metrics(actual), metrics(expected));
      assert.equal(actual.unitsPerEm, 1000);
      assert.equal(actual.ascent, 800);
      assert.equal(actual.glyphsForString('a')[0].advanceWidth, 600);
    }
  });
}

test('vendored fontkit preserves real Geist metrics and rejects unknown input', async () => {
  const bytes = await readFile(new URL('../packages/prnext/runtime/og/Geist-Regular.ttf', import.meta.url));
  assert.deepEqual(metrics(create(bytes)), metrics(original(bytes)));
  assert.throws(() => create(Buffer.from('not a font')), /font format/);
});

test('vendored fontkit preserves variable axes and interpolated advance widths', async () => {
  const bytes = await readFile(new URL('../tests/fixtures/fontkit/fixture-variable.ttf', import.meta.url));
  const actual = create(bytes), expected = original(bytes);
  assert.deepEqual(actual.variationAxes, expected.variationAxes);
  assert.equal(actual.variationAxes.wght.min, 400);
  assert.equal(actual.variationAxes.wght.max, 900);
  for (const weight of [400, 650, 900]) {
    assert.deepEqual(metrics(actual.getVariation({wght: weight})), metrics(expected.getVariation({wght: weight})));
  }
  assert.equal(actual.getVariation({wght: 400}).glyphsForString('a')[0].advanceWidth, 600);
  assert.equal(actual.getVariation({wght: 900}).glyphsForString('a')[0].advanceWidth, 700);
});

test('vendored bundle runs from a relocated directory without external fontkit or any npm dependency', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-fontkit-relocated-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await cp(new URL('index.mjs', vendor), path.join(directory, 'index.mjs'));
  await cp(new URL('../tests/fixtures/fontkit/fixture.woff2', import.meta.url), path.join(directory, 'fixture.woff2'));
  const script = `import {registerHooks} from 'node:module';import {readFile} from 'node:fs/promises';
    registerHooks({resolve(specifier,context,next){if(!specifier.startsWith('.')&&!specifier.startsWith('node:')&&specifier!=='fs')throw new Error('Unexpected npm dependency: '+specifier);return next(specifier,context)}});
    const {create}=await import('./index.mjs');const f=create(await readFile('fixture.woff2'));console.log(f.unitsPerEm+':'+f.ascent+':'+f.glyphsForString('a')[0].advanceWidth);`;
  const {stdout} = await run(process.execPath, ['--input-type=module', '-e', script], {cwd: directory, windowsHide: true});
  assert.equal(stdout.trim(), '1000:800:600');
});

test('fontkit release verifier detects changed, added or missing distribution bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-fontkit-integrity-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await cp(vendor, directory, {recursive: true});
  await verifyVendoredFontkit(directory);
  const file = path.join(directory, 'NOTICE.txt'), contents = await readFile(file);
  await writeFile(file, 'changed');
  await assert.rejects(verifyVendoredFontkit(directory), /differs/);
  await writeFile(file, contents);
  await writeFile(path.join(directory, 'unexpected.txt'), 'added');
  await assert.rejects(verifyVendoredFontkit(directory), /inventory/);
  await rm(path.join(directory, 'unexpected.txt'));
  await rm(file);
  await assert.rejects(verifyVendoredFontkit(directory), /inventory/);
  const manifest = JSON.parse(await readFile(new URL('../packages/prnext/package.json', import.meta.url)));
  assert.equal(manifest.dependencies.fontkit, undefined);
  assert.ok(manifest.files.includes('vendor/'));
});
