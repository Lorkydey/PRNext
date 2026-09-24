import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { standaloneFixture, startServer, freePort, binary, repositoryRoot } from './support.mjs';
const cli=path.join(repositoryRoot,'packages/rustyx/cli.mjs');

test('custom distDir starts natively and through the CLI and exposes routes without evaluating config',async()=>{
  const fixture=await standaloneFixture();let server,child;
  try{
    await writeFile(path.join(fixture.root,'rustyx.config.mjs'),`export default {distDir:'build/server'}`);
    await promisify(execFile)(process.execPath,[cli,'build',fixture.root]);
    await writeFile(path.join(fixture.root,'rustyx.config.mjs'),`throw new Error('configuration must not execute when serving')`);
    server=await startServer(fixture.root);
    assert.equal((await fetch(server.url+'/')).status,200);
    assert.match((await promisify(execFile)(binary,['routes',fixture.root])).stdout,/page.*\//);
    assert.match((await promisify(execFile)(process.execPath,[cli,'routes',fixture.root],{env:{...process.env,RUSTYX_BINARY:binary}})).stdout,/page.*\//);
    await server.close();server=undefined;
    const port=await freePort();
    child=spawn(process.execPath,[cli,'start',fixture.root,'--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,RUSTYX_BINARY:binary},stdio:'ignore'});
    let healthy=false;
    for(let attempt=0;attempt<100;attempt++){try{healthy=(await fetch('http://127.0.0.1:'+port+'/')).ok;if(healthy)break}catch{}await delay(30)}
    assert.equal(healthy,true);
  }finally{await server?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve))}await fixture.remove()}
});

test('dev watches sources while ignoring configured output and keeps the previous build after a failed edit',{timeout:30000},async()=>{
  const fixture=await standaloneFixture();let child;let output='';
  try{
    await writeFile(path.join(fixture.root,'rustyx.config.mjs'),`export default {distDir:'build/server'}`);
    await writeFile(path.join(fixture.root,'pages/index.jsx'),`export default function Page(){return <h1>First custom output</h1>}`);
    const port=await freePort(),url='http://127.0.0.1:'+port;
    child=spawn(process.execPath,[cli,'dev',fixture.root,'--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NODE_ENV:'development',RUSTYX_BINARY:binary},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{output=(output+chunk).slice(-32000)});child.stderr.on('data',chunk=>{output=(output+chunk).slice(-32000)});
    const manifest=async()=>JSON.parse(await readFile(path.join(fixture.root,'build/server/manifest.json'),'utf8'));
    async function eventually(predicate){for(let attempt=0;attempt<300;attempt++){try{if(await predicate())return}catch{}if(child.exitCode!==null)throw new Error(output);await delay(40)}throw new Error('Timed out: '+output)}
    await eventually(async()=> (await (await fetch(url)).text()).includes('First custom output'));
    const first=await manifest();assert.equal(first.dev,true);
    await writeFile(path.join(fixture.root,'build/server/ignored-output.txt'),'output');
    await delay(400);assert.equal((await manifest()).buildId,first.buildId);
    await writeFile(path.join(fixture.root,'pages/index.jsx'),`export default function Page(){return <h1>Second custom output</h1>}`);
    await eventually(async()=> (await (await fetch(url)).text()).includes('Second custom output'));
    const second=await manifest();assert.notEqual(second.buildId,first.buildId);
    await writeFile(path.join(fixture.root,'pages/index.jsx'),'broken syntax {');
    await eventually(()=>output.includes('Build failed'));
    assert.equal((await manifest()).buildId,second.buildId);
    assert.equal(JSON.parse(await readFile(path.join(fixture.root,'.rustyx-output.json'),'utf8')).distDir,'build/server');
    assert.match(await (await fetch(url)).text(),/Second custom output/);
  }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},5000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}await fixture.remove()}
});
