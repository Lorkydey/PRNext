import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildStatic } from './static-adapter.mjs';
import { readBuildOutput, validateBuildOutput } from './output-contract.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-static-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const put = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  await put('dist/index.html', '<!doctype html><h1>Static site</h1>');
  await put('dist/assets/app.js', 'document.body.dataset.ready="true";');
  return { root, put };
}

test('imports browser output without React, evaluating config, or changing its source', async t => {
  const { root, put } = await fixture(t);
  await put('next.config.mjs', 'throw new Error("configuration must not execute");');
  await put('dist/docs/index.html', '<h1>Docs</h1>');
  await put('dist/about.html', '<h1>About</h1>');
  await put('dist/.well-known/security.txt', 'contact');
  const result = await buildStatic(root);
  const output = await readBuildOutput(result.outputDirectory);
  assert.equal(output.adapter, 'static'); assert.equal(output.server, null); assert.equal(output.fallback, null);
  assert.equal(result.files, 5); assert.deepEqual(result.routes, []);
  for (const url of ['/', '/index.html', '/docs', '/docs/index.html', '/about', '/about.html', '/assets/app.js', '/.well-known/security.txt']) assert.ok(result.prerendered.some(p => p.path === url), url);
  assert.equal(await readFile(path.join(root, '.prnext/static/assets/app.js'), 'utf8'), await readFile(path.join(root, 'dist/assets/app.js'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.prnext-output.json'), 'utf8')), { distDir: '.prnext' });
});

test('imports to an explicit build directory and records SPA opt-in', async t => {
  const { root } = await fixture(t);
  const built = await buildStatic(root, { spa: true, distDir: 'build/prnext' });
  assert.equal((await readBuildOutput(built.outputDirectory)).fallback, 'index.html');
  assert.equal(built.config.staticFallback, true);
  assert.equal((await buildStatic(root)).outputDirectory, await realpath(path.join(root, 'build/prnext')));
});

test('static imports precompress text without changing source and accept verified existing sidecars', async t => {
  const { root, put } = await fixture(t), text='export const message="hello world";\n'.repeat(1000);
  await put('dist/assets/large.js',text);
  let built=await buildStatic(root);
  assert.equal(gunzipSync(await readFile(path.join(built.outputDirectory,'static/assets/large.js.gz'))).toString(),text);
  await assert.rejects(readFile(path.join(root,'dist/assets/large.js.gz')),{code:'ENOENT'});
  await put('dist/assets/large.js.gz',gzipSync(text));
  built=await buildStatic(root);assert.equal(gunzipSync(await readFile(path.join(built.outputDirectory,'static/assets/large.js.gz'))).toString(),text);
  await put('dist/assets/large.js.gz',gzipSync('wrong content'));
  await assert.rejects(buildStatic(root),/does not match/);
  assert.equal(await readFile(path.join(built.outputDirectory,'static/assets/large.js'),'utf8'),text);
});

test('failed imports preserve the previous build and pointer', async t => {
  const { root, put } = await fixture(t);
  await buildStatic(root);
  const before = await readFile(path.join(root, '.prnext/manifest.json'), 'utf8');
  const pointer = await readFile(path.join(root, '.prnext-output.json'), 'utf8');
  for (const name of ['.env', 'server/entry.mjs', 'node_modules/pkg.js', '_prnext/private.txt']) {
    await put('dist/' + name, 'must not publish');
    await assert.rejects(buildStatic(root), /private, reserved or server path/);
    await rm(path.join(root, 'dist', name.split('/')[0]), { recursive: true, force: true });
    assert.equal(await readFile(path.join(root, '.prnext/manifest.json'), 'utf8'), before);
    assert.equal(await readFile(path.join(root, '.prnext-output.json'), 'utf8'), pointer);
  }
});

test('rejects unsafe paths, symlinks, ambiguous aliases and source/output overlap', async t => {
  const { root, put } = await fixture(t);
  for (const from of ['.', '..', '../dist', '/tmp/dist', 'pages', 'node_modules', 'dist/../other', 'dist\\other']) await assert.rejects(buildStatic(root, { from }));
  await assert.rejects(buildStatic(root, { from: 'dist', distDir: 'dist/output' }), /overlap/);
  await assert.rejects(buildStatic(root, { from: 'dist', distDir: 'dist' }), /overlap|unrelated/);
  await put('dist/about', 'file'); await put('dist/about.html', '<h1>About</h1>');
  await assert.rejects(buildStatic(root), /Ambiguous static URL/);
  await rm(path.join(root, 'dist/about')); await rm(path.join(root, 'dist/about.html'));
  try { await symlink(path.join(root, 'dist/index.html'), path.join(root, 'dist/link.html')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.diagnostic('File symlink creation unavailable on Windows; Linux integration also exercises this rejection.'); return; } throw error; }
  await assert.rejects(buildStatic(root), /symbolic links/);
});

test('requires a finished index, refuses dev mode and leaves unrelated output intact', async t => {
  const { root, put } = await fixture(t);
  await assert.rejects(buildStatic(root, { dev: true }), /production files/);
  await assert.rejects(buildStatic(root, { spa: 'yes' }), /boolean/);
  await rm(path.join(root, 'dist/index.html'));
  await assert.rejects(buildStatic(root), /needs index.html/);
  await put('dist/index.html', 'index'); await put('.prnext/keep.txt', 'unrelated');
  await assert.rejects(buildStatic(root), /unrelated files/);
  assert.equal(await readFile(path.join(root, '.prnext/keep.txt'), 'utf8'), 'unrelated');
});

test('output metadata rejects future versions and executable or escaping entrypoints', async t => {
  const { root } = await fixture(t);
  const result = await buildStatic(root), output = await readBuildOutput(result.outputDirectory);
  for (const change of [{ version: 2 }, { adapter: 'nuxt' }, { manifest: '../secret' }, { assets: '../public' }, { server: { entry: 'server.mjs' } }, { fallback: '/index.html' }, { extra: true }]) assert.throws(() => validateBuildOutput({ ...output, ...change }), /Invalid PRNext build output/);
  await writeFile(path.join(result.outputDirectory, 'build-output.json'), ' '.repeat(65537));
  await assert.rejects(readBuildOutput(result.outputDirectory), /64 KiB/);
});

test('the common builder dispatches explicit adapters and explains incompatible source projects', async t => {
  const { root } = await fixture(t);
  const { build } = await import('./index.mjs');
  const result = await build(root, { adapter: 'static', spa: true });
  assert.equal((await readBuildOutput(result.outputDirectory)).adapter, 'static');
  await assert.rejects(build(root, { adapter: 'node' }), /Unknown PRNext adapter/);
  await assert.rejects(build(root, { adapter: 'react', from: 'dist' }), /only supported by the static adapter/);
  await assert.rejects(build(root), /React adapter needs.*--adapter static/);
});
