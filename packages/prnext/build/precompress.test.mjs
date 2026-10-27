import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync, brotliDecompressSync, brotliCompressSync } from 'node:zlib';
import { precompressBuild } from './precompress.mjs';

test('global build-cache opt-out neither creates nor rewrites the compression cache',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-compression-disabled-'));
  const before=process.env.PRNEXT_BUILD_CACHE;
  t.after(async()=>{if(before===undefined)delete process.env.PRNEXT_BUILD_CACHE;else process.env.PRNEXT_BUILD_CACHE=before;await rm(root,{recursive:true,force:true});});
  process.env.PRNEXT_BUILD_CACHE='0';
  const source='valid uncached output '.repeat(4096),cacheDirectory=path.join(root,'cache');
  for(const index of [1,2]){
    const stage=path.join(root,String(index));await mkdir(path.join(stage,'assets'),{recursive:true});
    const file=path.join(stage,'assets/client.js');await writeFile(file,source);
    assert.deepEqual(await precompressBuild(stage,undefined,{cacheDirectory}),{compressed:1,reused:0,skipped:0});
    assert.equal(gunzipSync(await readFile(file+'.gz')).toString(),source);
    if(index===1){await assert.rejects(stat(cacheDirectory),{code:'ENOENT'});await mkdir(cacheDirectory);await writeFile(path.join(cacheDirectory,'preserved'),'unchanged');}
  }
  assert.deepEqual(await readdir(cacheDirectory),['preserved']);assert.equal(await readFile(path.join(cacheDirectory,'preserved'),'utf8'),'unchanged');
});

test('precompression reuses content across builds and repairs corrupt or oversized cache contents', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-gzip-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cacheDirectory=path.join(root,'cache'), content='cached output '.repeat(4096);
  const cached=path.join(cacheDirectory,createHash('sha256').update(content).digest('hex')+'.gz');
  const run=async(index,source=content)=>{
    const stage=path.join(root,String(index));await mkdir(path.join(stage,'assets'),{recursive:true});
    const file=path.join(stage,'assets/client.js');await writeFile(file,source);
    const stats=await precompressBuild(stage,undefined,{cacheDirectory});
    assert.equal(gunzipSync(await readFile(file+'.gz')).toString(),source);
    assert.equal(brotliDecompressSync(await readFile(file+'.br')).toString(),source);
    assert.equal((await stat(file,{bigint:true})).mtimeNs,(await stat(file+'.gz',{bigint:true})).mtimeNs);
    assert.equal((await stat(file,{bigint:true})).mtimeNs,(await stat(file+'.br',{bigint:true})).mtimeNs);
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
  const br=cached.replace(/\.gz$/,'.br');
  for(const [index,corrupt]of [Buffer.from('bad brotli'),brotliCompressSync(content+'wrong')].entries()){
    await writeFile(br,corrupt);assert.equal((await run(index+8)).compressed,1);
  }
});

test('supplied Brotli sidecars must represent exactly the published asset',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-brotli-supplied-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'assets'));const file=path.join(root,'assets/a.js'),source='valid asset '.repeat(4096);
  await writeFile(file,source);await writeFile(file+'.br',brotliCompressSync('wrong asset'));
  await assert.rejects(precompressBuild(root),/sidecar|Brotli|match|represent/i);
  await writeFile(file+'.br',brotliCompressSync(source));await precompressBuild(root);
  assert.equal(brotliDecompressSync(await readFile(file+'.br')).toString(),source);
});

test('shared compression cache bounds old entries and concurrent duplicate publications',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-compression-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cacheDirectory=path.join(root,'cache');await mkdir(cacheDirectory);
  const oversized=path.join(cacheDirectory,'f'.repeat(64)+'.gz');await writeFile(oversized,'');await truncate(oversized,64*1024*1024+1);
  await utimes(oversized,1,1);
  for(let i=0;i<513;i++) {
    const file=path.join(cacheDirectory,i.toString(16).padStart(64,'0')+'.gz');await writeFile(file,'old cache bytes');await utimes(file,2+i,2+i);
  }
  const stage=path.join(root,'build');await mkdir(path.join(stage,'assets'),{recursive:true});
  const source='same bytes in concurrent assets '.repeat(1024);
  for(let i=0;i<12;i++)await writeFile(path.join(stage,'assets',i+'.js'),source);
  await precompressBuild(stage,undefined,{cacheDirectory});
  await assert.rejects(stat(oversized),{code:'ENOENT'});
  const entries=await readdir(cacheDirectory);assert.equal(entries.length,512);assert.ok(entries.every(name=>/^[a-f0-9]{64}\.(?:gz|br)$/.test(name)));
  const key=createHash('sha256').update(source).digest('hex');
  assert.equal(gunzipSync(await readFile(path.join(cacheDirectory,key+'.gz'))).toString(),source);
  assert.equal(brotliDecompressSync(await readFile(path.join(cacheDirectory,key+'.br'))).toString(),source);
  const next=path.join(root,'next');await mkdir(path.join(next,'assets'),{recursive:true});await writeFile(path.join(next,'assets/client.js'),source);
  assert.deepEqual(await precompressBuild(next,undefined,{cacheDirectory}),{compressed:0,reused:1,skipped:0});
});

test('unavailable compression cache leaves valid gzip and Brotli build outputs',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-compression-optional-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cacheDirectory=path.join(root,'not-a-directory');await writeFile(cacheDirectory,'preserve this file');
  await mkdir(path.join(root,'assets'));const file=path.join(root,'assets/client.js'),source='valid build output '.repeat(4096);await writeFile(file,source);
  assert.deepEqual(await precompressBuild(root,undefined,{cacheDirectory}),{compressed:1,reused:0,skipped:0});
  assert.equal(gunzipSync(await readFile(file+'.gz')).toString(),source);assert.equal(brotliDecompressSync(await readFile(file+'.br')).toString(),source);
  assert.equal(await readFile(cacheDirectory,'utf8'),'preserve this file');
});

test('build sidecars preserve bytes and matching timestamps and skip unsuitable or mutable files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-precompress-'));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-precompress-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await precompressBuild(root);
});

test('opaque Route Handler bodies gzip only published unencoded responses when smaller', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-handler-precompress-'));
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
