import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cachedFontResource } from './font-cache.mjs';

test('font inputs reject corrupted cache bytes and keep URL/accept variants separate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-font-cache-'));
  try {
    let downloads=0;
    const get=(url='https://fonts.gstatic.com/font.woff2', accept='font/woff2')=>cachedFontResource(root,url,1024,accept,async()=>Buffer.from(`font-${++downloads}`));
    assert.equal(String(await get()), 'font-1');
    assert.equal(String(await get()), 'font-1');
    const directory=path.join(root,'.prnext-cache/fonts-v1');
    const file=path.join(directory,(await readdir(directory))[0]);
    const bytes=await readFile(file); bytes[bytes.length-1]^=1; await writeFile(file,bytes);
    assert.equal(String(await get()), 'font-2');
    assert.equal(String(await get(undefined,'text/css')), 'font-3');
    assert.equal(String(await get('https://fonts.gstatic.com/other.woff2')), 'font-4');
    assert.equal(String(await get()), 'font-2');
    await assert.rejects(cachedFontResource(root,'https://fonts.gstatic.com/large',4,'font/woff2',async()=>Buffer.alloc(5)),/limit/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('font input cache bounds its entry count', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-font-cache-'));
  try {
    for(let i=0;i<260;i++) await cachedFontResource(root,`https://fonts.gstatic.com/${i}`,1024,'font/woff2',async()=>Buffer.from('font'));
    assert.equal((await readdir(path.join(root,'.prnext-cache/fonts-v1'))).length,256);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('font cache does not follow a namespace junction or write when caching is disabled',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-font-links-')),outside=await mkdtemp(path.join(tmpdir(),'prnext-font-outside-'));
  t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]));
  await mkdir(path.join(root,'.prnext-cache'));await symlink(outside,path.join(root,'.prnext-cache/fonts-v1'),process.platform==='win32'?'junction':'dir');
  assert.equal(String(await cachedFontResource(root,'https://fonts.test/font',1024,'font/woff2',async()=>Buffer.from('download'))),'download');
  assert.deepEqual(await readdir(outside),[]);
  const previous=process.env.PRNEXT_BUILD_CACHE;process.env.PRNEXT_BUILD_CACHE='0';
  try{assert.equal(String(await cachedFontResource(outside,'https://fonts.test/font',1024,'font/woff2',async()=>Buffer.from('uncached'))),'uncached');assert.deepEqual(await readdir(outside),[]);}
  finally{if(previous===undefined)delete process.env.PRNEXT_BUILD_CACHE;else process.env.PRNEXT_BUILD_CACHE=previous;}
});
