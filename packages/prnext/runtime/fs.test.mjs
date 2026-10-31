import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAtomicRenamer} from './fs.mjs';
import {createAtomicFileWriter} from './atomic-file.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

for(const code of ['EPERM','EACCES','EBUSY'])test('atomic rename retries a transient Windows '+code+' without deleting a destination',async()=>{
  let attempts=0,time=0;
  const move=createAtomicRenamer({platform:'win32',now:()=>time,wait:async ms=>{time+=ms;},moveFile:async()=>{if(++attempts<3)throw Object.assign(Error('locked'),{code});}});
  await move('temporary','destination');assert.equal(attempts,3);assert.equal(time,30);
});
test('permanent locks are bounded and expose only scoped diagnostic metadata',async()=>{
  let time=0;
  const move=createAtomicRenamer({platform:'win32',retryMs:30,now:()=>time,wait:async ms=>{time+=ms;},moveFile:async()=>{throw Object.assign(Error('locked'),{code:'EPERM'});}});
  await assert.rejects(move('/private/source','/private/state.json'),error=>{assert.deepEqual(error.atomicRename,{operation:'rename',code:'EPERM',attempts:3,elapsedMs:30,destination:'state.json'});return true;});
});
test('non-Windows and permanent errors fail immediately',async()=>{
  for(const [platform,code]of [['linux','EPERM'],['win32','ENOSPC']]){
    let attempts=0;
    const move=createAtomicRenamer({platform,wait:async()=>assert.fail('unexpected retry'),moveFile:async()=>{attempts++;throw Object.assign(Error('failed'),{code});}});
    await assert.rejects(move('a','b'),error=>error.code===code);assert.equal(attempts,1);
  }
});
test('a frozen wall clock cannot extend the rename retry deadline',async()=>{
  const code=`Date.now=()=>0;const {createAtomicRenamer}=await import(${JSON.stringify(new URL('./fs.mjs',import.meta.url).href)});try{await createAtomicRenamer({platform:'win32',retryMs:20,moveFile:async()=>{throw Object.assign(Error('locked'),{code:'EPERM'})}})('a','b')}catch(error){console.log(error.code)}`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:2000});assert.equal(stdout.trim(),'EPERM');
});
for(const failure of ['partial-write','rename'])test('state publication preserves the last valid file and recovers after '+failure,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-atomic-state-')),filename=path.join(directory,'state.json');
  try{
    await writeFile(filename,'{"sequence":1}');
    const writer=createAtomicFileWriter({
      openFile:failure==='partial-write'?async(...args)=>{const file=await open(...args);return {writeFile:async data=>{await file.writeFile(data.slice(0,4));throw Object.assign(Error('partial write'),{code:'EIO'});},close:()=>file.close()};}:open,
      moveFile:failure==='rename'?async()=>{throw Object.assign(Error('locked'),{code:'EPERM'});}:rename,
    });
    await assert.rejects(writer(filename,'{"sequence":2}'),error=>error.atomicFile.phase===(failure==='rename'?'publish':'write'));
    assert.equal(await readFile(filename,'utf8'),'{"sequence":1}');assert.deepEqual(await readdir(directory),['state.json']);
    await createAtomicFileWriter()(filename,'{"sequence":3}');assert.equal(JSON.parse(await readFile(filename)).sequence,3);
  }finally{const relative=path.relative(tmpdir(),directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});}
});
test('failed exclusive creation never removes a temporary it did not create',async()=>{
  const writer=createAtomicFileWriter({openFile:async()=>{throw Object.assign(Error('exists'),{code:'EEXIST'});},removeFile:async()=>assert.fail('must preserve an unowned file')});
  await assert.rejects(writer('/unused/state.json','state'),error=>error.code==='EEXIST'&&error.atomicFile.phase==='create');
});
