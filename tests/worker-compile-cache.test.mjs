import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {standaloneFixture,startServer} from './support.mjs';
import {build} from '../packages/prnext/build/index.mjs';

async function files(root){const output=[];for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){const file=path.join(root,entry.name);if(entry.isDirectory())output.push(...await files(file));else output.push(file);}return output;}
test('worker bytecode cache persists across processes and never freezes application state',{timeout:90000},async()=>{
  const fixture=await standaloneFixture('prnext-worker-bytecode-');let server;
  try{
    await mkdir(path.join(fixture.root,'pages/api'));const source=path.join(fixture.root,'pages/api/value.js');
    const put=version=>writeFile(source,`let calls=0;export default function handler(req,res){res.json({version:${version},calls:++calls})}`);
    await put(1);await build(fixture.root);
    const cache=path.join(fixture.root,'.prnext-cache/node-compile-v1');
    server=await startServer(fixture.root,['--workers','1']);
    assert.deepEqual(await(await fetch(server.url+'/api/value')).json(),{version:1,calls:1});
    await delay(1500);const first=await files(cache);assert.ok(first.length>0,'worker flushes V8 cache before exit');
    const before=new Map(await Promise.all(first.map(async file=>[path.relative(cache,file),await readFile(file)])));
    await server.close();server=null;
    server=await startServer(fixture.root,['--workers','1']);
    assert.deepEqual(await(await fetch(server.url+'/api/value')).json(),{version:1,calls:1},'module globals are fresh in every process');
    await server.close();server=null;
    assert.ok((await files(cache)).some(file=>before.has(path.relative(cache,file))),'next worker retains compatible bytecode files');
    await put(2);await build(fixture.root);
    server=await startServer(fixture.root,['--workers','1']);
    assert.deepEqual(await(await fetch(server.url+'/api/value')).json(),{version:2,calls:1},'changed modules cannot execute old bytecode');
    await server.close();server=null;
    // Explicit opt-out must work even if the project cache path is unusable.
    server=await startServer(fixture.root,['--workers','1'],{PRNEXT_WORKER_COMPILE_CACHE:'0',NODE_DISABLE_COMPILE_CACHE:'1'});
    assert.deepEqual(await(await fetch(server.url+'/api/value')).json(),{version:2,calls:1});
  }finally{await server?.close();await fixture.remove();}
});
