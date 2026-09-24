import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { precompressBuild } from './precompress.mjs';

test('precompression reuses content across builds and repairs corrupt or oversized cache contents', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'rustyx-gzip-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cacheDirectory=path.join(root,'cache'), content='cached output '.repeat(4096);
  const cached=path.join(cacheDirectory,createHash('sha256').update(content).digest('hex')+'.gz');
  const run=async(index,source=content)=>{
    const stage=path.join(root,String(index));await mkdir(path.join(stage,'assets'),{recursive:true});
    const file=path.join(stage,'assets/client.js');await writeFile(file,source);
    const stats=await precompressBuild(stage,undefined,{cacheDirectory});
    assert.equal(gunzipSync(await readFile(file+'.gz')).toString(),source);
    assert.equal((await stat(file,{bigint:true})).mtimeNs,(await stat(file+'.gz',{bigint:true})).mtimeNs);
    return stats;
  };
  assert.deepEqual(await run(1),{compressed:1,reused:0,skipped:0});
  assert.deepEqual(await run(2),{compressed:0,reused:1,skipped:0});
  assert.equal((await run(3,content+'changed')).compressed,1);
  for (const [index,corrupt] of [Buffer.from('broken gzip'),gzipSync(content+'extra'),gzipSync('wrong bytes')].entries()) {
    await writeFile(cached,corrupt);
    assert.equal((await run(index+4)).compressed,1);
  }
  assert.equal((await run(7)).reused,1);
});

test('build sidecars preserve bytes and matching timestamps and skip unsuitable or mutable files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rustyx-precompress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compressible = {
    'static/page.html': '<html><body>Repeated prerendered content</body></html>'.repeat(4096),
    'assets/chunks/client.js': 'export const message = "Repeated client asset";\n'.repeat(4096),
    'assets/styles.css': '.content { color: blue; padding: 1rem; }\n'.repeat(4096),
  };
  const skipped = {
    'assets/random.js': randomBytes(65536),
    'assets/empty.css': '',
    'assets/already.js.gz': gzipSync('Already compressed content'.repeat(4096)),
    'assets/image.png': Buffer.alloc(65536, 42),
    'assets/font.woff2': Buffer.alloc(65536, 42),
    'public/mutable.txt': 'Mutable public content'.repeat(4096),
    'server/private.mjs': 'Server-only content'.repeat(4096),
  };
  for (const [relative, bytes] of Object.entries({ ...compressible, ...skipped })) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    await utimes(filename, 1_700_000_100.123456, 1_700_000_123.456789);
  }
  await symlink(path.join(root, 'public/mutable.txt'), path.join(root, 'assets/linked.txt'));
  await precompressBuild(root);
  for (const [relative, expected] of Object.entries(compressible)) {
    const filename = path.join(root, relative);
    const original = await readFile(filename);
    const compressed = await readFile(filename + '.gz');
    assert.deepEqual(original, Buffer.from(expected));
    assert.deepEqual(gunzipSync(compressed), original);
    assert.ok(compressed.length < original.length);
    const source = await stat(filename, { bigint: true });
    const sidecar = await stat(filename + '.gz', { bigint: true });
    assert.equal(sidecar.mtimeNs, source.mtimeNs, 'freshness comparisons match at filesystem precision');
    assert.equal(Number(source.mtimeNs / 1_000_000n), 1_700_000_123_456, 'original modification time is preserved');
  }
  for (const [relative, expected] of Object.entries(skipped)) {
    assert.deepEqual(await readFile(path.join(root, relative)), Buffer.from(expected));
    await assert.rejects(stat(path.join(root, relative + '.gz')), { code: 'ENOENT' });
  }
  await assert.rejects(stat(path.join(root, 'assets/linked.txt.gz')), { code: 'ENOENT' });
});

test('builds without static files or browser assets need no gzip outputs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rustyx-precompress-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await precompressBuild(root);
});

test('opaque Route Handler bodies gzip only published unencoded responses when smaller', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rustyx-handler-precompress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'static'));
  const bodies = {
    'binary.body': Buffer.alloc(65536, 42),
    'random.body': randomBytes(65536),
    'encoded.body': gzipSync(Buffer.alloc(65536, 42)),
    'unlisted.body': Buffer.alloc(65536, 42),
    'paired.body': Buffer.alloc(65536, 42),
  };
  for (const [name, body] of Object.entries(bodies)) await writeFile(path.join(root, 'static', name), body);
  await precompressBuild(root, { prerendered: [
    { file: 'static/binary.body', headers: { 'Content-Type': 'application/octet-stream' } },
    { file: 'static/random.body', headers: {} },
    { file: 'static/encoded.body', headers: { 'Content-Encoding': 'gzip' } },
    { file: 'static/paired.body', dataFile: 'static/paired.txt', headers: {} },
  ] });
  assert.deepEqual(gunzipSync(await readFile(path.join(root, 'static/binary.body.gz'))), bodies['binary.body']);
  for (const name of Object.keys(bodies)) {
    assert.deepEqual(await readFile(path.join(root, 'static', name)), bodies[name]);
    if (name !== 'binary.body') await assert.rejects(stat(path.join(root, 'static', name + '.gz')), { code: 'ENOENT' });
  }
});
