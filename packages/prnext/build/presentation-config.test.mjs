import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPresentationConfigPolicy} from './presentation-config.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(run){const root=await mkdtemp(path.join(repo,'.prnext-presentation-config-'));try{await mkdir(path.join(root,'app/ui'),{recursive:true});await writeFile(path.join(root,'tsconfig.json'),'{}');await run(root,path.join(root,'app/ui/Table.tsx'));}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}

test('standard root JSONC and source aliases retain eligibility without executing configuration',()=>fixture(async(root,file)=>{
  await writeFile(path.join(root,'tsconfig.json'),`{/* jsxImportSource in a comment is not configuration */"compilerOptions":{"jsx":"preserve","paths":{"@/*":["./app/*"]},},}`);
  assert.equal(await createPresentationConfigPolicy({root})(file),undefined);
  await writeFile(path.join(root,'tsconfig.json'),'{"compilerOptions":{"jsxImportSource":"react"}}');
  assert.equal(await createPresentationConfigPolicy({root})(file),undefined);
  assert.match(await createPresentationConfigPolicy({root,customTransforms:true})(file),/Custom source transforms/);
}));

test('custom JSX, escaped keys, duplicate options, inheritance and unverified inputs retain ordinary rendering',()=>fixture(async(root,file)=>{
  for(const source of [
    '{"compilerOptions":{"jsxImportSource":"custom-jsx"}}',
    '{"compilerOptions":{"jsxFactory":"h"}}',
    '{"compilerOptions":{"jsxFragmentFactory":"Fragment"}}',
    '{"compilerOptions":{"j\\u0073xImportSource":"custom-jsx"}}',
    '{"compilerOptions":{},"compilerOptions":{"jsxImportSource":"custom-jsx"}}',
    '{"extends":"./shared.json"}',
    '{"compilerOptions":getPrivateConfig()}',
    '{"compilerOptions":{...privateConfig}}',
    '{broken',
    ' '.repeat(256*1024+1),
  ]){
    await writeFile(path.join(root,'tsconfig.json'),source);
    assert.ok(await createPresentationConfigPolicy({root})(file),source.slice(0,80));
  }
}));

test('per-directory configuration and explicit configuration have separate ownership',()=>fixture(async(root,file)=>{
  const nested=path.join(root,'app/ui/tsconfig.json');await writeFile(nested,'{}');
  assert.match(await createPresentationConfigPolicy({root})(file),/Per-directory/);
  assert.equal(await createPresentationConfigPolicy({root,tsconfig:path.join(root,'tsconfig.json')})(file),undefined,'an explicit build-wide config overrides directory discovery');
}));

test('configuration lookup/inspection is shared within a build and refreshed by the next build',()=>fixture(async(root,file)=>{
  const policy=createPresentationConfigPolicy({root});assert.equal(await policy(file),undefined);
  await writeFile(path.join(root,'tsconfig.json'),'{"compilerOptions":{"jsxImportSource":"changed"}}');
  assert.equal(await policy(file),undefined);
  assert.match(await createPresentationConfigPolicy({root})(file),/Custom JSX/);
}));
