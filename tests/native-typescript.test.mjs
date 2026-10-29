import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {checkTypeScript} from '../packages/prnext/build/typescript.mjs';
import {resolveTypeScript} from '../packages/prnext/build/typescript-toolchain.mjs';
import {startTypeChecker} from '../packages/prnext/build/typescript-dev.mjs';
import {watchProject} from '../packages/prnext/runtime/watch-project.mjs';
import {runTypeCommand} from '../packages/prnext/build/type-command.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {repositoryRoot,startServer} from './support.mjs';

const installed=fileURLToPath(new URL('./toolchain/node_modules/typescript/',import.meta.url));
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext native typescript '));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  await mkdir(path.join(root,'node_modules'));
  await symlink(installed,path.join(root,'node_modules/typescript'),'junction');
  await writeFile(path.join(root,'package.json'),'{"private":true,"type":"module"}');
  const config=JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',skipLibCheck:true,types:[],composite:true},include:['*.ts']});
  await writeFile(path.join(root,'tsconfig.json'),config);
  await writeFile(path.join(root,'value.ts'),'export const value:number="broken";');
  return {root,config};
}
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(50);}throw new Error('Native TypeScript did not report the expected diagnostic generation');}
test('the real TypeScript 7 native checker reports semantic/config errors and never emits into the project',{timeout:60000},async t=>{
  const {root,config}=await fixture(t);
  assert.equal((await resolveTypeScript(root)).native,true);
  await assert.rejects(checkTypeScript(root,{typescript:{}}),/TS2322/);
  await writeFile(path.join(root,'value.ts'),'export const value:number=42;');
  await checkTypeScript(root,{typescript:{}});
  assert.equal(await readFile(path.join(root,'tsconfig.json'),'utf8'),config);
  assert.deepEqual((await readdir(root)).filter(name=>/\.js$|\.tsbuildinfo$|\.d\.ts$/.test(name)),[]);
  await writeFile(path.join(root,'tsconfig.json'),'{"compilerOptions":{"definitelyNotAnOption":true}}');
  await assert.rejects(checkTypeScript(root,{typescript:{}}),/TS5023/);
});
test('native development diagnostics update after edits, clear errors and stop their compiler subtree',{timeout:60000},async t=>{
  const {root}=await fixture(t);const generations=[];
  const checker=await startTypeChecker(root,{},errors=>generations.push(errors));
  const watcher=await watchProject(root,{onChange:(file,event)=>checker.invalidate(file,event),onError:error=>{throw error;}});
  try{
    await until(()=>generations.some(errors=>errors.join('\n').includes('TS2322')));
    await writeFile(path.join(root,'value.ts'),'export const value:number=42;');
    await until(()=>generations.at(-1)?.length===0);
    await writeFile(path.join(root,'second.ts'),'export const invalid:boolean=123;');
    await until(()=>generations.at(-1)?.join('\n').includes('second.ts'));
  }finally{watcher.close();await checker.close();}
  const count=generations.length;await writeFile(path.join(root,'value.ts'),'export const value:number="broken again";');await delay(300);assert.equal(generations.length,count);
});

test('native typecheck includes typed routes, preserves JSONC and resolves inherited aliases',{timeout:60000},async t=>{
  const {root}=await fixture(t);await mkdir(path.join(root,'pages'));await mkdir(path.join(root,'base'));
  await writeFile(path.join(root,'base/tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',types:[],paths:{'@value':['./value.ts']}}}));
  await writeFile(path.join(root,'base/value.ts'),'export const value:number=42;');await writeFile(path.join(root,'value.ts'),'import {value} from "@value";export const n:number=value;');
  await writeFile(path.join(root,'pages/index.js'),'export default function Page(){return null}');
  await writeFile(path.join(root,'tsconfig.json'),'{\n// preserve this comment\n"extends":"./base/tsconfig.json",\n"include":["value.ts"],\n}');
  const first=await runTypeCommand(root,{check:true});assert.equal(first.ok,true,first.errors.join('\n'));
  const config=await readFile(path.join(root,'tsconfig.json'),'utf8');assert.match(config,/preserve this comment/);assert.match(config,/prnext-env.d.ts/);assert.match(config,/base\/value.ts/);
  const second=await runTypeCommand(root,{check:true});assert.equal(second.ok,true,second.errors.join('\n'));assert.equal(await readFile(path.join(root,'tsconfig.json'),'utf8'),config);
});

test('a production build uses native TypeScript and its output serves through the real runtime',{timeout:120000},async t=>{
  const {root}=await fixture(t),require=createRequire(import.meta.url);
  await writeFile(path.join(root,'value.ts'),'export const value:number=42;');
  for(const name of ['react','react-dom','scheduler'])await symlink(path.dirname(require.resolve(name+'/package.json')),path.join(root,'node_modules',name),'junction');
  await mkdir(path.join(root,'pages'));
  await writeFile(path.join(root,'pages/index.ts'),'import React from "react";export default function Page(){return React.createElement("h1",null,"Native TypeScript production")}');
  await writeFile(path.join(root,'prnext.config.mjs'),'export default{typescript:{}}');
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root],{cwd:root,maxBuffer:4*1024*1024});
  const server=await startServer(root);try{const response=await fetch(server.url);assert.equal(response.status,200);assert.match(await response.text(),/Native TypeScript production/);}finally{await server.close();}
});

test('public Redis handler types accept an actual node-redis client under native TypeScript',{timeout:60000},async t=>{
  const {root}=await fixture(t);
  await writeFile(path.join(root,'value.ts'),'import{createClient}from"redis";import{createRedisCache}from"@thomas.f/prnext/cache/redis";createRedisCache({namespace:"typed-client",client:createClient()});');
  await symlink(fileURLToPath(new URL('./toolchain/node_modules/redis/',import.meta.url)),path.join(root,'node_modules/redis'),'junction');
  await mkdir(path.join(root,'node_modules/@thomas.f'));
  await symlink(path.join(repositoryRoot,'packages/prnext'),path.join(root,'node_modules/@thomas.f/prnext'),'junction');
  await checkTypeScript(root,{typescript:{}});
});
