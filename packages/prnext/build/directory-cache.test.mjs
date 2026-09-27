import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readDirectory,directoryCacheStats,clearDirectoryCache} from './directory-cache.mjs';
test('directory snapshots reuse unchanged names and observe additions, renames and removals',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-scan-cache-'));t.after(async()=>{clearDirectoryCache();await rm(root,{recursive:true,force:true});});
  await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'page.jsx'),'first');
  const first=await readDirectory(root),before=directoryCacheStats();
  first[0].name='caller mutation';
  assert.ok((await readDirectory(root)).some(item=>item.name==='page.jsx'));assert.equal(directoryCacheStats().hits,before.hits+1);
  await rename(path.join(root,'page.jsx'),path.join(root,'route.jsx'));
  assert.ok((await readDirectory(root)).some(item=>item.name==='route.jsx'));
  await writeFile(path.join(root,'layout.jsx'),'layout');assert.equal((await readDirectory(root)).length,3);
  await rm(path.join(root,'route.jsx'));assert.equal((await readDirectory(root)).length,2);
  for(let i=0;i<20;i++){
    await writeFile(path.join(root,'rapid-a.jsx'),String(i));
    assert.ok((await readDirectory(root)).some(item=>item.name==='rapid-a.jsx'));
    await rename(path.join(root,'rapid-a.jsx'),path.join(root,'rapid-b.jsx'));
    const names=(await readDirectory(root)).map(item=>item.name);
    assert.ok(names.includes('rapid-b.jsx'));assert.ok(!names.includes('rapid-a.jsx'));
    await rm(path.join(root,'rapid-b.jsx'));
    assert.ok(!(await readDirectory(root)).some(item=>item.name.startsWith('rapid-')));
  }
  for(let i=0;i<260;i++){const directory=path.join(root,String(i));await mkdir(directory);await readDirectory(directory);}
  assert.ok(directoryCacheStats().entries<=256);assert.ok(directoryCacheStats().bytes<=1024*1024);
});
