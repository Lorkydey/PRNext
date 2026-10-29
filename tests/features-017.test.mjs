import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {standaloneFixture,appFixture,binary,repositoryRoot,freePort} from './support.mjs';
import {build} from '../packages/prnext/build/index.mjs';
import {closeIncrementalCompiler,incrementalCompilerStats} from '../packages/prnext/build/incremental.mjs';
import {analyzeBuild} from '../packages/prnext/build/analyze.mjs';
import {createBuilder} from '../packages/prnext/build/production-builder.mjs';
const execute=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await check();if(result)return result;await sleep(100);}throw new Error('Timed out waiting for expected runtime state');}

async function minimalApp(){const fixture=await appFixture();
for(const name of ['app','pages','components','lib','proxy.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});return fixture;}

test('incremental production builds reuse graphs, isolate prerender state, rotate action keys and report route bundles',{timeout:180000},async()=>{
  const fixture=await minimalApp();
  const builder=await createBuilder(fixture.root);
  try{
    await mkdir(path.join(fixture.root,'pages'),{recursive:true});await mkdir(path.join(fixture.root,'app'),{recursive:true});
    await writeFile(path.join(fixture.root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
    await writeFile(path.join(fixture.root,'app/Counter.jsx'),`'use client';import {useState} from 'react';export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>{n}</button>}`);
    await writeFile(path.join(fixture.root,'app/page.jsx'),`import Counter from './Counter';import {action} from './actions';export const dynamic='force-dynamic';export default function Page(){return <form action={action}><Counter/></form>}`);
    await mkdir(path.join(fixture.root,'app/observed'),{recursive:true});
    await writeFile(path.join(fixture.root,'app/observed/page.jsx'),`import Counter from '../Counter';export default function Observed(){return <Counter/>}`);
    await writeFile(path.join(fixture.root,'app/actions.js'),`'use server';export async function action(){return 1}`);
    await writeFile(path.join(fixture.root,'pages/legacy.jsx'),`globalThis.__prnextBuildCount=(globalThis.__prnextBuildCount||0)+1;export function getStaticProps(){return {props:{n:globalThis.__prnextBuildCount}}}export default function Legacy({n}){return <p>fresh-build-{n}</p>}`);
    const first=await builder.build();
    const stats=incrementalCompilerStats();
    const report1=await analyzeBuild(fixture.root);
    const second=await builder.build();
    assert.ok(incrementalCompilerStats().reused>stats.reused,'production builds must reuse compiler graphs');
    assert.notEqual(first.app.actionKey,second.app.actionKey);assert.notEqual(first.previewModeEncryptionKey,second.previewModeEncryptionKey);
    assert.ok(Object.keys(first.app.actions).length);assert.notDeepEqual(Object.keys(first.app.actions),Object.keys(second.app.actions));
    const seed=second.prerendered.find(route=>route.path==='/legacy');assert.match(await readFile(path.join(second.outputDirectory,seed.file),'utf8'),/fresh-build-.*1/);
    const report=await analyzeBuild(fixture.root,{maxJs:0});
    assert.equal(report.previous.buildId,report1.buildId);assert.ok(report.budget.exceeded.includes('/'));
    // Analysis v2 counts observed hydration imports. Dynamic routes report a
    // lower bound; the prerendered sibling supplies an actual initial sample.
    const dynamicRoute=report.routes.find(route=>route.route==='/');
    assert.equal(dynamicRoute.initial.status,'request-dependent');
    assert.ok(dynamicRoute.budget.exceeded.includes('initial-unknown'));
    const observedRoute=report.routes.find(route=>route.route==='/observed');
    assert.equal(observedRoute.initial.status,'prerendered');
    const sample=observedRoute.initial.samples.find(sample=>sample.path==='/observed');
    assert.ok(sample?.files.some(file=>file.startsWith('client-')),'observed hydration imports include the actual App client boundary');
    assert.ok(observedRoute.files.some(file=>file.startsWith('client-')),'App client boundary is part of the observed route budget');
    assert.ok(report.files.every(file=>file.bytes>0&&file.brotliBytes>0));
    await assert.rejects(execute(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'analyze',fixture.root,'--json','--max-js','0']),error=>{assert.equal(error.code,1);assert.ok(JSON.parse(error.stdout).budget.exceeded.length);return true;});
    await writeFile(path.join(fixture.root,'app/page.jsx'),'export default (');
    await assert.rejects(builder.build());
    assert.equal(JSON.parse(await readFile(path.join(second.outputDirectory,'manifest.json'),'utf8')).buildId,second.buildId);
    await writeFile(path.join(fixture.root,'app/page.jsx'),`export default function Page(){return <p>recovered</p>}`);
    await builder.build();
    const started=path.join(fixture.root,'.builder-started'),release=path.join(fixture.root,'.builder-release');
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),`import {writeFileSync,existsSync} from 'node:fs';export default {async generateBuildId(){writeFileSync(${JSON.stringify(started)},'yes');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,10));return 'concurrent-builder'}}`);
    const other=await createBuilder(fixture.root),running=other.build();let disposed=false;
    try{
      await until(async()=>{try{await access(started);return true;}catch{return false;}});
      const closing=builder.dispose().then(()=>{disposed=true;});
      await sleep(50);assert.equal(disposed,false,'session disposal must wait for an in-progress build sharing its contexts');
      await writeFile(release,'yes');await running;await closing;
    }finally{await writeFile(release,'yes');await running.catch(()=>{});await other.dispose();}
  }finally{await builder.dispose();await assert.rejects(builder.build(),/disposed/);await closeIncrementalCompiler();await fixture.remove();}
});

test('configured startup preloading imports Pages/API and RSC modules without calling handlers or rendering',{timeout:90000},async()=>{
  const fixture=await minimalApp();let child;
  try{
    await mkdir(path.join(fixture.root,'pages/api'),{recursive:true});await mkdir(path.join(fixture.root,'app'),{recursive:true});
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),`export default {workerPreload:{routes:['/','/api/preload'],maxRssMb:1024,timeoutMs:15000}}`);
    await writeFile(path.join(fixture.root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
    await writeFile(path.join(fixture.root,'app/page.jsx'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path.join(fixture.root,'rsc-imported'))},'yes');export const dynamic='force-dynamic';export default function Page(){writeFileSync(${JSON.stringify(path.join(fixture.root,'render-called'))},'yes');return <p>preloaded</p>}`);
    await writeFile(path.join(fixture.root,'pages/api/preload.js'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path.join(fixture.root,'api-imported'))},'yes');export default function handler(req,res){writeFileSync(${JSON.stringify(path.join(fixture.root,'handler-called'))},'yes');res.json({ok:true})}`);
    await build(fixture.root);
    for(const name of ['rsc-imported','api-imported','render-called','handler-called'])await rm(path.join(fixture.root,name),{force:true});
    const port=await freePort();let logs='';
    child=spawn(binary,['start',fixture.root,'--port',String(port),'--node',process.execPath,'--shutdown-on-stdin-eof'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
    await until(()=>logs.includes(`http://127.0.0.1:${port}`));
    await access(path.join(fixture.root,'api-imported'));await access(path.join(fixture.root,'rsc-imported'));
    await assert.rejects(access(path.join(fixture.root,'handler-called')));await assert.rejects(access(path.join(fixture.root,'render-called')));
    const response=await fetch(`http://127.0.0.1:${port}/`);assert.equal(response.status,200);assert.match(await response.text(),/preloaded/);
    assert.doesNotMatch(logs,/preloading failed|preloading was incomplete/i);
  }finally{if(child){const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await exited;}await fixture.remove();}
});

test('pstart rolls back a replacement that becomes unhealthy after switching traffic',{timeout:120000},async()=>{
  const fixture=await standaloneFixture('prnext-017-rollback-'),home=path.join(fixture.root,'.manager');
  const env={...process.env,PRNEXT_PM_HOME:home,PRNEXT_BINARY:binary};
  const cli=async(...args)=>(await execute(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),...args],{env,cwd:fixture.root,windowsHide:true,timeout:60000})).stdout;
  const status=async()=>JSON.parse(await cli('pstatus','--json'));
  try{
    await mkdir(path.join(fixture.root,'pages/api'),{recursive:true});
    await writeFile(path.join(fixture.root,'pages/api/health.js'),`export default function health(req,res){res.json({ok:true})}`);
    await writeFile(path.join(fixture.root,'pages/api/version.js'),`export default function version(req,res){res.json({version:1})}`);
    await build(fixture.root);const port=await freePort();
    await cli('pstart',fixture.root,'--name','rollback','--port',String(port),'--health-path','/api/health','--rollback-window','6000');
    const first=(await status()).apps[0];
    await writeFile(path.join(fixture.root,'pages/api/health.js'),`let calls=0;export default function health(req,res){res.status(++calls>1?500:200).json({ok:calls===1})}`);
    await writeFile(path.join(fixture.root,'pages/api/version.js'),`export default function version(req,res){res.json({version:2})}`);
    await build(fixture.root);await cli('prestart','rollback');
    const next=(await status()).apps[0];assert.notEqual(next.pid,first.pid);assert.ok(next.rollback);
    assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/version`)).json()).version,2);
    await until(async()=>{const app=(await status()).apps[0];return app.pid===first.pid&&app.error?.includes('Rolled back');});
    assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/version`)).json()).version,1);
    await writeFile(path.join(fixture.root,'pages/api/health.js'),`export default function health(req,res){res.json({ok:true})}`);
    await build(fixture.root);await cli('prestart','rollback');
    const crashing=(await status()).apps[0];assert.notEqual(crashing.pid,first.pid);
    process.kill(crashing.pid,'SIGKILL');
    await until(async()=>{const app=(await status()).apps[0];return app.pid===first.pid&&app.error?.includes('Rolled back');});
    assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/version`)).json()).version,1,'a post-switch crash returns to the old process');
    await cli('prestart','rollback');assert.ok((await status()).apps[0].rollback);
    await cli('pstop','rollback');assert.equal((await status()).apps[0].state,'stopped');
  }finally{await cli('pdelete','--all').catch(()=>{});await cli('pdown').catch(()=>{});await fixture.remove();}
});

test('production watch rebuilds dependencies, preserves a good build on error and exits cleanly',{timeout:90000},async()=>{
  const fixture=await standaloneFixture('prnext-017-watch-');let child,logs='';
  try{
    const cli=path.join(repositoryRoot,'packages/prnext/cli.mjs');
    const code=`process.on('message',()=>{process.emit('SIGINT');process.disconnect();});process.argv=[process.execPath,${JSON.stringify(cli)},'build',${JSON.stringify(fixture.root)},'--watch'];await import(${JSON.stringify(new URL('../packages/prnext/cli.mjs',import.meta.url).href)});`;
    child=spawn(process.execPath,['--input-type=module','--eval',code],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value);
    const manifest=async()=>JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    await until(()=>logs.includes('Watching production'),30000);const first=await manifest();
    await writeFile(path.join(fixture.root,'components/Main.jsx'),'export default function Main(){return <p>watched-dependency</p>}');
    await until(async()=>{try{return (await manifest()).buildId!==first.buildId;}catch{return false;}},30000);
    const second=await manifest();assert.notEqual(second.buildId,first.buildId);
    await writeFile(path.join(fixture.root,'components/Main.jsx'),'export default (');
    await until(()=>logs.includes('Unexpected')||logs.includes('SyntaxError'),30000);assert.equal((await manifest()).buildId,second.buildId);
    await writeFile(path.join(fixture.root,'components/Main.jsx'),'export default function Main(){return <p>repaired</p>}');
    await until(async()=>{try{return (await manifest()).buildId!==second.buildId;}catch{return false;}},30000);
  }finally{
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.send('stop');await exited;}
    await fixture.remove();
  }
});
