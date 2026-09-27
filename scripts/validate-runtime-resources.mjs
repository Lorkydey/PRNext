import {mkdir,cp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const variant=process.argv[2]||'candidate';
const profileNames=['classic','standard','balanced','speed','memory'];
assert.ok(['next','baseline','baseline-compact','candidate','compact',...profileNames].includes(variant));
const output=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/runtime-resources');
process.env.DYNAMIC_BENCH_OUTPUT=path.join(output,'parity-'+variant);
if(variant.startsWith('baseline'))process.env.PRNEXT_BINARY=path.join(output,'projects/baseline-binary/rustyx');
const {launchBackend,directory,sha}=await import('./dynamic-benchmark/harness.mjs');
const {binary}=await import('../tests/support.mjs');
const {parityFor}=await import('./dynamic-benchmark/parity.mjs');
const engine=variant==='next'?'next':'rustyx';
const root=path.join(output,'projects',variant==='compact'||profileNames.includes(variant)?'candidate':variant==='baseline-compact'?'baseline':variant);
await mkdir(directory,{recursive:true});
await rm(path.join(directory,'projects',engine),{recursive:true,force:true});
await cp(root,path.join(directory,'projects',engine),{recursive:true,force:true,verbatimSymlinks:true,filter:file=>!file.includes('/.prnext-cache')&&!file.includes('/.next/cache')});
const backend=await launchBackend();
try{
  const env=variant.endsWith('compact')?{PRNEXT_MEMORY_PROFILE:'compact'}:profileNames.includes(variant)?{PRNEXT_PROFILE:variant}:{};
  const result=await parityFor(engine,backend,'runtime-resource-parity',undefined,env);
  await writeFile(path.join(directory,'results.json'),JSON.stringify({variant,environmentOverrides:env,binarySha256:engine==='next'?null:sha(await readFile(binary)),result},null,2)+'\n');
  assert.ok(result.checks.every(check=>check.pass),'parity failed');
  console.log('PARITY COMPLETE',variant,result.checks.length);
}finally{await backend.close();}
