import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { standaloneFixture, startServer, repositoryRoot } from './support.mjs';
let fixture, contract, worker;
async function rejectsStart(args, pattern) {
  await assert.rejects(async () => {
    const server = await startServer(fixture.root, args);
    // A regression must fail promptly without leaving the unexpectedly started
    // server alive and hanging the rest of the test process.
    await server.close();
  }, pattern);
}
before(async()=>{
  fixture=await standaloneFixture('prnext-contract-');
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root]);
  contract=await readFile(path.join(fixture.root,'.prnext/runtime-contract.json'),'utf8');
  worker=await readFile(path.join(fixture.root,'.prnext/runtime/worker.mjs'),'utf8');
});
after(async()=>fixture?.remove());
test('recent build starts without capability warnings and renders dynamically',async()=>{
  const server=await startServer(fixture.root);
  try { assert.equal((await fetch(server.url+'/server')).status,200);assert.doesNotMatch(server.output(),/capabilities|Rebuild|Unsupported runtime/); }
  finally {await server.close();}
});
test('missing, invalid, old and future contracts fail before accepting requests',async()=>{
  const file=path.join(fixture.root,'.prnext/runtime-contract.json');
  try {
    await unlink(file);await rejectsStart([],/prnext build/);
    for(const value of ['{', 'null', ' '.repeat(65537), JSON.stringify({...JSON.parse(contract),lifecycle:0}),JSON.stringify({...JSON.parse(contract),schema:99}),JSON.stringify({...JSON.parse(contract),capabilities:[]})]) {
      await writeFile(file,value);await rejectsStart([],/prnext build/);
    }
  } finally {await writeFile(file,contract);}
});
test('a worker from another directory cannot borrow this build lifecycle declaration',async()=>{
  const alternate=path.join(fixture.root,'alternate-worker.mjs');
  await writeFile(alternate,worker);
  await rejectsStart(['--worker',alternate],/verified directories.*prnext build/);
});
test('a worker-free legacy artifact remains usable without any Node executable',async()=>{
  const manifest=path.join(fixture.root,'.prnext/manifest.json'),original=await readFile(manifest,'utf8');
  const metadata=path.join(fixture.root,'.prnext/runtime-contract.json');
  try {
    await writeFile(manifest,JSON.stringify({version:1,routes:[],prerendered:[]}));await unlink(metadata);
    await mkdir(path.join(fixture.root,'public'),{recursive:true});await writeFile(path.join(fixture.root,'public/legacy.txt'),'legacy bytes');
    const server=await startServer(fixture.root,['--node',path.join(fixture.root,'missing-node-executable')]);
    try {assert.equal(await fetch(server.url+'/legacy.txt').then(r=>r.text()),'legacy bytes');assert.equal((await fetch(server.url+'/missing')).status,404);}
    finally{await server.close();}
  }finally{await writeFile(manifest,original);await writeFile(metadata,contract);}
});
test('a retained new sidecar cannot conceal a changed worker',async()=>{
  const file=path.join(fixture.root,'.prnext/runtime/worker.mjs');
  try {await writeFile(file,worker+'\n// old or mixed artifact\n');await rejectsStart([],/mixed or modified.*prnext build/);}
  finally {await writeFile(file,worker);}
});
