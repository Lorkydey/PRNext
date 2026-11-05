import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,realpath,rename} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {trackBuildStage,reclaimBuildStages} from './build-retention.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-stage-gc-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const paths=root=>({stage:path.join(root,'.prnext-build-'+randomUUID()),backup:path.join(root,'.prnext-backup-'+randomUUID())});

test('published stage cleanup keeps destination and retries only owned retired backups',async t=>{
  const root=await fixture(t),owned=paths(root),journal=await trackBuildStage(root,owned);
  await mkdir(owned.backup);await writeFile(path.join(owned.backup,'old.txt'),'old');
  await mkdir(path.join(root,'.prnext'));await writeFile(path.join(root,'.prnext','manifest.json'),'new build');
  await journal.committed();await journal.cleanup();
  await assert.rejects(readFile(path.join(owned.backup,'old.txt')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'),'new build');
  assert.deepEqual(await readdir(path.join(root,'.prnext-gc')),[]);
});

test('an uncommitted backup is retained as the possible last working build',async t=>{
  const root=await fixture(t),owned=paths(root),journal=await trackBuildStage(root,owned);
  await mkdir(owned.stage);await mkdir(owned.backup);await writeFile(path.join(owned.backup,'manifest.json'),'last working build');
  await journal.cleanup();await assert.rejects(readdir(owned.stage),{code:'ENOENT'});
  assert.equal(await readFile(path.join(owned.backup,'manifest.json'),'utf8'),'last working build');
  assert.equal((await readdir(path.join(root,'.prnext-gc'))).length,1,'journal retained for recovery');
});

test('recovery handles a killed process, preserves active owners and requires grace',async t=>{
  const root=await fixture(t),module=new URL('./build-retention.mjs',import.meta.url).href,owned=paths(root);
  const child=spawn(process.execPath,['--input-type=module','-e',`import {trackBuildStage} from ${JSON.stringify(module)};import {mkdir,writeFile} from 'node:fs/promises';const p=${JSON.stringify(owned)};const j=await trackBuildStage(${JSON.stringify(root)},p);await mkdir(p.stage);await writeFile(p.stage+'/output','staged');console.log('ready');setInterval(()=>{},1000);`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('ready'))resolve();});child.once('exit',()=>reject(Error('child exited before ready')));});
  const future=Date.now()+7200000;assert.equal((await reclaimBuildStages(root,{now:future})).removedStages,0);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.equal((await reclaimBuildStages(root)).removedStages,0,'recent crash keeps grace period');
  assert.equal((await reclaimBuildStages(root,{now:future})).removedStages,1);
  await assert.rejects(readdir(owned.stage),{code:'ENOENT'});assert.deepEqual(await readdir(path.join(root,'.prnext-gc')),['cursor.json']);
});

test('persistent recovery cursor progresses beyond retained journals without renaming active records',async t=>{
  const root=await fixture(t),directory=path.join(root,'.prnext-gc');await mkdir(directory);
  const retained=[];
  for(let index=0;index<128;index++){
    const id=`00000000-0000-4000-8000-${index.toString(16).padStart(12,'0')}`;
    const name=id+'.json';retained.push(name);
    await writeFile(path.join(directory,name),JSON.stringify({version:1,pid:process.pid,host:hostname(),createdAt:1,stage:'.prnext-build-'+id,backup:'.prnext-backup-'+id,committed:false}));
  }
  const owned=paths(root),name='ffffffff-ffff-ffff-ffff-ffffffffffff.json';await mkdir(owned.stage);await writeFile(path.join(owned.stage,'output'),'dead stage');
  await writeFile(path.join(directory,name),JSON.stringify({version:1,pid:2147483647,host:hostname(),createdAt:1,stage:path.basename(owned.stage),backup:path.basename(owned.backup),committed:true}));
  const first=await reclaimBuildStages(root);
  assert.equal(first.scanned,128);assert.equal(first.scanComplete,false);assert.equal(first.deferred,true);assert.equal(first.removedStages,0);
  assert.ok(await readdir(owned.stage));
  const cursor=JSON.parse(await readFile(path.join(directory,'cursor.json'),'utf8'));assert.equal(cursor.after,retained.at(-1));
  // Re-enter from persisted data, as another fresh CLI process would do.
  const second=await reclaimBuildStages(root);
  assert.equal(second.scanned,1);assert.equal(second.removedStages,1);assert.equal(second.removedBackups,0);assert.equal(second.scanComplete,true);assert.equal(second.deferred,false);
  await assert.rejects(readdir(owned.stage),{code:'ENOENT'});
  assert.deepEqual((await readdir(directory)).filter(value=>value!=='cursor.json'),retained);
  assert.equal(JSON.parse(await readFile(path.join(directory,'cursor.json'),'utf8')).after,null);
});

test('missing stages resolve journals without counting directories as deleted',async t=>{
  const root=await fixture(t),owned=paths(root);await trackBuildStage(root,owned);
  const directory=path.join(root,'.prnext-gc'),name=(await readdir(directory))[0],file=path.join(directory,name);
  const owner=JSON.parse(await readFile(file,'utf8'));owner.pid=2147483647;owner.createdAt=1;owner.committed=true;await writeFile(file,JSON.stringify(owner));
  const result=await reclaimBuildStages(root);
  assert.equal(result.removedStages,0);assert.equal(result.removedBackups,0);assert.equal(result.scanComplete,true);
  assert.deepEqual(await readdir(directory),['cursor.json']);
});

test('a committed retired backup counts only when its directory is actually removed',async t=>{
  const root=await fixture(t),owned=paths(root);await trackBuildStage(root,owned);await mkdir(owned.backup);
  const directory=path.join(root,'.prnext-gc'),file=path.join(directory,(await readdir(directory))[0]);
  const owner=JSON.parse(await readFile(file,'utf8'));owner.pid=2147483647;owner.createdAt=1;owner.committed=true;await writeFile(file,JSON.stringify(owner));
  const result=await reclaimBuildStages(root);
  assert.equal(result.removedStages,0);assert.equal(result.removedBackups,1);await assert.rejects(readdir(owned.backup),{code:'ENOENT'});
});

test('an incomplete journal listing defers deletion and preserves the previous cursor',async t=>{
  const root=await fixture(t),directory=path.join(root,'.prnext-gc');await mkdir(directory);
  const after='00000000-0000-4000-8000-000000000000.json';
  await writeFile(path.join(directory,'cursor.json'),JSON.stringify({version:1,after}));
  const owned=paths(root);await mkdir(owned.stage);
  await writeFile(path.join(directory,'ffffffff-ffff-ffff-ffff-ffffffffffff.json'),JSON.stringify({version:1,pid:2147483647,host:hostname(),createdAt:1,stage:path.basename(owned.stage),backup:path.basename(owned.backup),committed:true}));
  const result=await reclaimBuildStages(root,{maxListingEntries:1});
  assert.equal(result.listed,1);assert.equal(result.scanComplete,false);assert.equal(result.deferred,true);assert.equal(result.removedStages,0);
  assert.ok(await readdir(owned.stage));assert.equal(JSON.parse(await readFile(path.join(directory,'cursor.json'),'utf8')).after,after);
});

test('a symlinked recovery cursor defers cleanup and leaves its target untouched',async t=>{
  const root=await fixture(t),outside=await fixture(t),owned=paths(root);await trackBuildStage(root,owned);await mkdir(owned.stage);
  const directory=path.join(root,'.prnext-gc'),file=path.join(directory,(await readdir(directory))[0]);
  const owner=JSON.parse(await readFile(file,'utf8'));owner.pid=2147483647;owner.createdAt=1;owner.committed=true;await writeFile(file,JSON.stringify(owner));
  await writeFile(path.join(outside,'keep'),'outside');await symlink(outside,path.join(directory,'cursor.json'),process.platform==='win32'?'junction':'dir');
  const result=await reclaimBuildStages(root);
  assert.equal(result.scanComplete,false);assert.equal(result.deferred,true);assert.equal(result.removedStages,0);
  assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'outside');assert.ok(await readdir(owned.stage));
});

test('unknown stages, foreign hosts, uncommitted backups and symlinks survive recovery',async t=>{
  const root=await fixture(t),outside=await fixture(t),unknown=paths(root);await mkdir(unknown.stage);
  const owned=paths(root),journal=await trackBuildStage(root,owned);await mkdir(owned.backup);await writeFile(path.join(owned.backup,'keep'),'recovery');
  await symlink(outside,owned.stage,process.platform==='win32'?'junction':'dir');await writeFile(path.join(outside,'keep'),'outside');
  const directory=path.join(root,'.prnext-gc'),file=path.join(directory,(await readdir(directory))[0]),record=JSON.parse(await readFile(file,'utf8'));
  record.pid=2147483647;record.createdAt=1;record.host=hostname()+'-foreign';await writeFile(file,JSON.stringify(record));
  assert.equal((await reclaimBuildStages(root)).removedStages,0);
  record.host=hostname();await writeFile(file,JSON.stringify(record));const result=await reclaimBuildStages(root);
  assert.equal(result.removedStages,0);assert.equal(result.retainedRecoveryBackups,1);assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'outside');
  await journal.cleanup();assert.ok(await readdir(unknown.stage));assert.equal(await readFile(path.join(owned.backup,'keep'),'utf8'),'recovery');
});

test('recovery refuses escaped and unknown paths and never follows its registry symlink',async t=>{
  const root=await fixture(t),outside=await fixture(t);
  await assert.rejects(trackBuildStage(root,{stage:path.join(outside,'.prnext-build-'+randomUUID()),backup:paths(root).backup}),/inside the project/);
  await symlink(outside,path.join(root,'.prnext-gc'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(trackBuildStage(root,paths(root)),/real directory/);
  assert.equal((await reclaimBuildStages(root)).removedStages,0);assert.deepEqual(await readdir(outside),[]);
});

test('a replaced canonical project root is rejected before creating or reclaiming journals',async t=>{
  const parent=await fixture(t),root=path.join(parent,'project'),outside=path.join(parent,'outside');
  await mkdir(root);await mkdir(outside);const owned=paths(root);await trackBuildStage(root,owned);
  const name=(await readdir(path.join(root,'.prnext-gc')))[0],record=JSON.parse(await readFile(path.join(root,'.prnext-gc',name),'utf8'));
  record.pid=2147483647;record.createdAt=1;
  await mkdir(path.join(outside,'.prnext-gc'));await writeFile(path.join(outside,'.prnext-gc',name),JSON.stringify(record));
  const sentinel=path.join(outside,path.basename(owned.stage));await mkdir(sentinel);await writeFile(path.join(sentinel,'keep'),'outside project');
  await rename(root,path.join(parent,'original'));await symlink(outside,root,process.platform==='win32'?'junction':'dir');
  assert.equal((await reclaimBuildStages(root)).deferred,true);assert.equal(await readFile(path.join(sentinel,'keep'),'utf8'),'outside project');
  await assert.rejects(trackBuildStage(root,paths(root)),/canonical physical/);
  assert.deepEqual(await readdir(path.join(outside,'.prnext-gc')),[name]);
});
