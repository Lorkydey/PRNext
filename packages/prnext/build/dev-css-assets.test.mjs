import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStyleOverlay, STYLE_OVERLAY_LIMITS } from './dev-css-assets.mjs';

const descriptor = (name, data) => ({ name, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-css-catalogue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'base');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  const plans = [['a.css', []], ['b.css', []]];
  const manifest = { config: { assetBase: '/_prnext/assets' }, devStyles: { bundles: plans } };
  return { root, source, destination: path.join(root, 'overlay'), manifest, plans, selected: [plans[0]] };
}

test('overlay catalogue validation rejects traversal, missing provenance and aggregate byte budgets before allocation', async t => {
  const f = await fixture(t);
  const valid = descriptor('a.css', 'a');
  const cases = [
    [{ version: 1, baseDirectory: '../outside', bundles: [['a.css', [valid]]] }, 'invalid-style-overlay-base'],
    [{ version: 1, baseDirectory: 'base', bundles: [['a.css', [{ ...valid, name: '../escape.css' }]]] }, 'invalid-style-overlay'],
    [{ version: 1, baseDirectory: 'base', bundles: [['a.css', [valid]], ['a.css', [valid]]] }, 'invalid-style-overlay'],
    [{ version: 1, baseDirectory: 'base', bundles: [['a.css', [{ ...valid, bytes: STYLE_OVERLAY_LIMITS.bytes / 2 + 1 }, { ...valid, name: 'image.png', bytes: STYLE_OVERLAY_LIMITS.bytes / 2 + 1 }]]] }, 'style-overlay-budget'],
    [{ version: 1, baseDirectory: 'base', bundles: [] }, 'missing-style-overlay'],
  ];
  for (const [overlay, code] of cases) {
    await assert.rejects(createStyleOverlay({ ...f, manifest: { ...f.manifest, routes: [{ css: ['/_prnext/assets/a.css?v=old'] }], devStyles: { ...f.manifest.devStyles, baseClient: '/_prnext/assets/base.json', overlay } } }), error => error.code === code);
    await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  }
  await assert.rejects(createStyleOverlay({ ...f, manifest: { ...f.manifest, devStyles: { ...f.manifest.devStyles, baseClient: '/_prnext/assets/base.json' } } }), error => error.code === 'missing-style-overlay');
});

test('corrupt or missing inherited assets fall back and discard only the newly owned overlay', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'assets', 'b.css'), 'corrupted');
  const overlay = { version: 1, baseDirectory: 'base', bundles: [['b.css', [descriptor('b.css', 'expected')]]] };
  const manifest = { ...f.manifest, devStyles: { ...f.manifest.devStyles, baseClient: '/_prnext/assets/base.json', overlay } };
  await assert.rejects(createStyleOverlay({ ...f, manifest }), error => error.code === 'invalid-style-overlay-asset');
  await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.source, 'assets', 'b.css'), 'utf8'), 'corrupted');
  await rm(path.join(f.source, 'assets', 'b.css'));
  await assert.rejects(createStyleOverlay({ ...f, manifest }), error => error.code === 'missing-style-overlay-asset');
  await assert.rejects(stat(f.destination), { code: 'ENOENT' });
});

test('overlay preparation never removes a preexisting destination and rejects source nesting', async t => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(path.join(f.destination, 'owned-by-someone-else'), 'preserved');
  await assert.rejects(createStyleOverlay(f), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(f.destination, 'owned-by-someone-else'), 'utf8'), 'preserved');
  await assert.rejects(createStyleOverlay({ ...f, destination: path.join(f.source, 'nested') }), error => error.code === 'invalid-style-overlay-directory');
  await assert.rejects(stat(path.join(f.source, 'nested')), { code: 'ENOENT' });
});

test('overlay file count and catalogue size have independent aggregate limits', async t => {
  const f = await fixture(t);
  const file = name => ({ name, bytes: 0, sha256: '0'.repeat(64) });
  const overlays = [
    {
      plans: f.plans,
      bundles: [['a.css', [file('a.css'), ...Array.from({ length: STYLE_OVERLAY_LIMITS.files - 1 }, (_, index) => file(`${index}.png`))]], ['b.css', [file('b.css')]]],
    },
    {
      plans: [...f.plans, ['c.css', []], ['d.css', []]],
      bundles: ['a', 'b', 'c', 'd'].map(name => [name + '.css', [file(name + '.css'), ...Array.from({ length: 3999 }, (_, index) => file(`${index}-${'x'.repeat(230)}.png`))]]),
    },
  ];
  for (const { plans, bundles } of overlays) {
    const manifest = { ...f.manifest, devStyles: { bundles: plans, baseClient: '/_prnext/assets/base.json', overlay: { version: 1, baseDirectory: 'base', bundles } } };
    await assert.rejects(createStyleOverlay({ ...f, plans, manifest }), error => error.code === 'style-overlay-budget');
    await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  }
});

test('overlay validation accepts a project alias but still rejects canonical source nesting and outside parents', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'prnext-css-aliased-root-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'actual'), alias = path.join(parent, 'alias');
  await mkdir(path.join(target, 'base/assets'), { recursive: true });
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const plans = [['a.css', []]], source = path.join(alias, 'base');
  const options = { root: alias, source, destination: path.join(alias, 'overlay'), plans, selected: plans, manifest: { config: { assetBase: '/_prnext/assets' }, devStyles: { bundles: plans } } };
  const overlay = await createStyleOverlay(options);
  const css = path.join(alias, 'overlay/assets/a.css');
  await overlay.recordBundle('a.css', { outputFiles: [{ path: css, contents: Buffer.from('.aliased { color: red }') }], metafile: { outputs: { [css]: { imports: [] } } } });
  const catalogue = await overlay.finish();
  assert.equal(catalogue.baseDirectory, 'base');
  assert.match(await readFile(path.join(target, 'overlay/assets/a.css'), 'utf8'), /aliased/);
  await assert.rejects(createStyleOverlay({ ...options, destination: path.join(target, 'base/nested') }), error => error.code === 'invalid-style-overlay-directory');
  await assert.rejects(stat(path.join(target, 'base/nested')), { code: 'ENOENT' });
  // A later overlay has a different source, but its JavaScript base must stay
  // immutable too: a new CSS generation cannot be created inside that base.
  await assert.rejects(createStyleOverlay({ ...options, source: path.join(alias, 'overlay'), baseSource: source,
    destination: path.join(alias, 'base/nested'), manifest: { ...options.manifest,
      devStyles: { bundles: plans, baseClient: '/_prnext/assets/base.json', overlay: catalogue } } }), error => error.code === 'invalid-style-overlay-directory');
  await assert.rejects(stat(path.join(target, 'base/nested')), { code: 'ENOENT' });
  await mkdir(path.join(parent, 'outside'));
  await symlink(path.join(parent, 'outside'), path.join(target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createStyleOverlay({ ...options, destination: path.join(alias, 'escape/overlay') }), error => error.code === 'invalid-style-overlay-directory');
  await assert.rejects(stat(path.join(parent, 'outside/overlay')), { code: 'ENOENT' });
});
