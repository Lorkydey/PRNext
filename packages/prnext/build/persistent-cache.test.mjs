import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withPersistentTransforms,cachedTransform} from './transform-cache.mjs';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),moduleUrl=new URL('./transform-cache.mjs',import.meta.url).href;
async function run(root,source='input',settings='mode'){
  const code=`import {withPersistentTransforms,cachedTransform,transformCacheStats} from ${JSON.stringify(moduleUrl)};let calls=0;const output=await withPersistentTransforms(${JSON.stringify(root)},{},()=>cachedTransform('test',${JSON.stringify(source)},[${JSON.stringify(settings)}],()=>{calls++;return 'result:'+${JSON.stringify(source)}}));console.log(JSON.stringify({calls,output,stats:transformCacheStats()}));`;
  return JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PRNEXT_BUILD_CACHE:'1'},windowsHide:true})).stdout);
}
test('pure transforms persist across fresh processes and invalidate source, options, dependency and env inputs',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-persist-transform-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'package.json'),'{}');
  assert.equal((await run(root)).calls,1);const second=await run(root);assert.equal(second.calls,0);assert.equal(second.stats.diskHits,1);assert.equal(second.output,'result:input');
  assert.equal((await run(root,'changed')).calls,1);assert.equal((await run(root,'input','server')).calls,1);
  await writeFile(path.join(root,'package-lock.json'),'{}');assert.equal((await run(root)).calls,1);
  await writeFile(path.join(root,'.env.production'),'PUBLIC_VALUE=changed');assert.equal((await run(root)).calls,1);
});
test('corrupted cache and unavailable directories are misses, never alternate build outputs',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-corrupt-transform-'));t.after(()=>rm(root,{recursive:true,force:true}));await run(root);
  const directory=path.join(root,'.prnext-cache','transforms-v1'),file=path.join(directory,(await readdir(directory)).find(name=>name.endsWith('.json')));
  const record=JSON.parse(await readFile(file,'utf8'));record.payload=record.payload.replace('result:input','poisoned');await writeFile(file,JSON.stringify(record));
  assert.equal((await run(root)).calls,1);assert.equal((await run(root)).calls,0);
  await rm(path.join(root,'.prnext-cache'),{recursive:true});await writeFile(path.join(root,'.prnext-cache'),'not a directory');assert.equal((await run(root)).calls,1);
});
test('a failed transform/build is never saved and concurrent project contexts remain separate',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-transform-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const roots=[path.join(root,'a'),path.join(root,'b')];await Promise.all(roots.map(p=>mkdir(p)));
  await assert.rejects(withPersistentTransforms(roots[0],{},()=>{cachedTransform('pure','x',[],()=>'safe');throw Error('build failed')}),/build failed/);
  assert.deepEqual(await readdir(path.join(roots[0],'.prnext-cache','transforms-v1')),[]);
  const outputs=await Promise.all(roots.map((p,i)=>withPersistentTransforms(p,{},async()=>{await new Promise(r=>setTimeout(r,20-i*10));return cachedTransform('context','same',[],()=>String(i));})));
  assert.deepEqual(outputs,['0','1']);
});

test('real fresh-process App builds reuse transforms while renewing action keys and IDs',async t=>{
  const root=await mkdtemp(fileURLToPath(new URL('../../../.prnext-persistent-real-',import.meta.url)));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'app'));await writeFile(path.join(root,'package.json'),'{"type":"module","private":true}');
  await writeFile(path.join(root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(root,'app/actions.js'),"'use server';export async function save(){return 'action output'}");
  await writeFile(path.join(root,'app/page.jsx'),"import {save} from './actions.js';export default function Page(){return <form action={save}><button>Save</button></form>}");
  const buildUrl=new URL('./index.mjs',import.meta.url).href;
  const env={...process.env,PRNEXT_BUILD_CACHE:'1'};delete env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
  const invoke=async()=>{
    const code=`import {build} from ${JSON.stringify(buildUrl)};import {transformCacheStats} from ${JSON.stringify(moduleUrl)};const built=await build(${JSON.stringify(root)});console.log(JSON.stringify({stats:transformCacheStats(),key:built.app.actionKey,ids:Object.keys(built.app.actions)}));`;
    return JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{env,windowsHide:true,maxBuffer:1024*1024})).stdout.trim().split('\n').at(-1));
  };
  const first=await invoke(),second=await invoke();
  assert.ok(second.stats.diskHits>0,'actual compiler callbacks must enter the persistent cache scope');
  assert.ok(second.stats.misses<first.stats.misses);assert.notEqual(first.key,second.key);assert.notDeepEqual(first.ids,second.ids);assert.equal(second.ids.length,1);
});
