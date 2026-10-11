import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer, repositoryRoot } from './support.mjs';
let root;
before(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'prnext-file-admission-'));
  await mkdir(path.join(root,'.prnext'));await mkdir(path.join(root,'public'));
  await writeFile(path.join(root,'.prnext/manifest.json'),JSON.stringify({version:1,routes:[],prerendered:[]}));
  await writeFile(path.join(root,'public/robots.txt'),'ready');await writeFile(path.join(root,'public/payload.txt'),'payload');
  const file=await open(path.join(root,'public/large-v6.bin'),'w');try{await file.truncate(32*1024*1024);}finally{await file.close();}
});
after(async()=>{if(root){assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}});
test('observer preserves configured admission; slow files reject, cancel, recover and retain Range',async()=>{
  const metrics=path.join(root,'metrics.jsonl');
  for(let i=0;i<2;i++) {
    const server=await startServer(root,[],{PRNEXT_FILE_CONCURRENCY:'1',PRNEXT_FILE_QUEUE:'0',PRNEXT_METRICS_FILE:metrics});
    try {
      const {stdout}=await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'tests/performance/static-overload-v6.mjs'),server.url,metrics],{timeout:30000});
      assert.equal(JSON.parse(stdout).complete,true);
    }finally{await server.close();}
  }
});
test('invalid filesystem admission overrides fail before listening',async()=>{
  for(const env of [{PRNEXT_FILE_CONCURRENCY:'0'},{PRNEXT_FILE_QUEUE:'-1'},{PRNEXT_FILE_WAIT_MS:'0'},{PRNEXT_FILE_WORK_CONCURRENCY:'1025'}]) {
    await assert.rejects(async()=>{const server=await startServer(root,[],env);await server.close();},/must be an integer/);
  }
});
