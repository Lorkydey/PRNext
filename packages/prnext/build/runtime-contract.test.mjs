import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeRuntimeContract } from './runtime-contract.mjs';

test('production deployment capability is explicit while development and legacy contracts retain their wire versions',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ['runtime','compat'])await mkdir(path.join(root,name));
  await writeFile(path.join(root,'runtime','worker.mjs'),'worker');
  const read=async()=>JSON.parse(await readFile(path.join(root,'runtime-contract.json'),'utf8'));
  await writeRuntimeContract(root);assert.equal((await read()).deployment,undefined);
  await writeRuntimeContract(root,{deployment:true});
  const contract=await read();assert.equal(contract.deployment,1);
  assert.deepEqual([contract.schema,contract.protocol,contract.lifecycle],[1,2,1]);
  assert.match(contract.modules['runtime/worker.mjs'],/^[a-f0-9]{64}$/);
  assert.equal(contract.htmlOnly,undefined);
  await writeRuntimeContract(root,{deployment:true,htmlOnly:true});
  assert.equal((await read()).htmlOnly,1);
  await writeRuntimeContract(root,{workerMemory:true});
  assert.equal((await read()).workerMemory,1);
  await writeRuntimeContract(root,{incrementalCache:true});
  assert.equal((await read()).incrementalCache,1);
});
