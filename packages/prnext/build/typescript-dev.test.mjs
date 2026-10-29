import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startTypeChecker} from './typescript-dev.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-native-watch-fallback-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'node_modules/typescript'),{recursive:true});
  await writeFile(path.join(root,'package.json'),'{"private":true}');
  await writeFile(path.join(root,'tsconfig.json'),'{}');
  await writeFile(path.join(root,'node_modules/typescript/package.json'),'{"version":"7.0.2","bin":{"tsc":"tsc.js"}}');
  await writeFile(path.join(root,'node_modules/typescript/tsc.js'),'');
  const children=[];
  const fork=()=>{
    const child=new EventEmitter();
    Object.assign(child,{stderr:new PassThrough(),connected:true,exitCode:null,signalCode:null});
    child.disconnect=()=>{child.connected=false;queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);});};
    child.kill=()=>child.disconnect();
    children.push(child);return child;
  };
  return {root,children,fork};
}
async function until(check){
  const deadline=Date.now()+5000;
  while(!check()){if(Date.now()>deadline)assert.fail('Expected checker lifecycle event');await delay(5);}
}

test('a native source edit missed by the compiler watcher restarts once and reports fresh diagnostics',async t=>{
  const f=await fixture(t),reports=[];
  const checker=await startTypeChecker(f.root,{},errors=>reports.push(errors),{fork:f.fork,recheckDelayMs:20});
  try{
    f.children[0].emit('message',{type:'diagnostics',errors:['old error']});
    checker.invalidate('value.ts','change');
    await until(()=>f.children.length===2);
    assert.equal(f.children[0].connected,false);
    f.children[0].emit('message',{type:'diagnostics',errors:['stale report']});
    f.children[1].emit('message',{type:'diagnostics',errors:[]});
    assert.deepEqual(reports,[['old error'],[]]);
    await delay(40);assert.equal(f.children.length,2);
  }finally{await checker.close();}
});

test('ordinary native diagnostic updates cancel the fallback and preserve the incremental compiler',async t=>{
  const f=await fixture(t);
  const checker=await startTypeChecker(f.root,{},()=>{},{fork:f.fork,recheckDelayMs:20});
  try{
    checker.invalidate('value.ts','change');
    f.children[0].emit('message',{type:'diagnostics',errors:[]});
    await delay(40);assert.equal(f.children.length,1);assert.equal(f.children[0].connected,true);
  }finally{await checker.close();}
});

test('file additions and configuration edits retain forced restart even if old diagnostics arrive',async t=>{
  const f=await fixture(t);
  const checker=await startTypeChecker(f.root,{},()=>{},{fork:f.fork,recheckDelayMs:20});
  try{
    checker.invalidate('new.ts','rename');
    checker.invalidate('value.ts','change');
    f.children[0].emit('message',{type:'diagnostics',errors:[]});
    await until(()=>f.children.length===2);
    checker.invalidate('tsconfig.json','change');
    f.children[1].emit('message',{type:'diagnostics',errors:[]});
    await until(()=>f.children.length===3);
  }finally{await checker.close();}
});

test('closing cancels a queued fallback and unrelated assets never restart the native compiler',async t=>{
  const f=await fixture(t);
  const checker=await startTypeChecker(f.root,{},()=>{},{fork:f.fork,recheckDelayMs:20});
  checker.invalidate('styles.css','change');
  await delay(40);assert.equal(f.children.length,1);
  checker.invalidate('value.ts','change');
  await checker.close();
  await delay(40);assert.equal(f.children.length,1);
});
