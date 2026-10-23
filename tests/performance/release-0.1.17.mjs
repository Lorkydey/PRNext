// Paired local benchmark. No external services, credentials or public listener.
// node tests/performance/release-0.1.17.mjs BASELINE_ROOT BASELINE_BINARY OUT
import {mkdtemp,mkdir,writeFile,readFile,symlink,readdir} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const execute=promisify(execFile),repo=fileURLToPath(new URL('../../',import.meta.url));
const [baseline,oldBinary,destination]=process.argv.slice(2).map(p=>path.resolve(p));
await mkdir(destination,{recursive:true});const out=await mkdtemp(path.join(destination,'paired-'));
const records=[];
const routeCount=Number(process.env.PRNEXT_PERF_ROUTES||20);assert.ok(Number.isInteger(routeCount)&&routeCount>=20&&routeCount<=200);
for(const [label,source,binary]of [['baseline',baseline,oldBinary],['candidate',repo,process.env.PRNEXT_BINARY||path.join(repo,'target/release',process.platform==='win32'?'prnext.exe':'prnext')]]){
  const root=path.join(out,label);await mkdir(path.join(root,'app/api/probe'),{recursive:true});await mkdir(path.join(root,'components'));
  await symlink(path.join(repo,'node_modules'),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  await writeFile(path.join(root,'package.json'),JSON.stringify({name:'prnext-perf-fixture',private:true,type:'module'}));
  await writeFile(path.join(root,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(root,'app/api/probe/route.js'),`export function GET(){return Response.json({ok:true,pid:process.pid})}`);
  await writeFile(path.join(root,'components/Counter.jsx'),`'use client';import {useState} from 'react';export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>{n}</button>}`);
  for(let i=0;i<routeCount*3;i++){
    await writeFile(path.join(root,`components/part${i}.jsx`),`export default function Part(){return <section><h2>Part ${i}</h2><p>${'Compiled component text. '.repeat(20)}</p></section>}`);
  }
  for(let i=0;i<routeCount;i++){
    const dir=path.join(root,`app/section${i}`);await mkdir(dir);
    await writeFile(path.join(dir,'page.jsx'),`import Counter from '../../components/Counter.jsx';${[0,1,2].map(j=>`import Part${j} from '../../components/part${i*3+j}.jsx';`).join('')}export const dynamic='force-dynamic';export default function Page(){return <main><h1>Section ${i}</h1><Counter/>${[0,1,2].map(j=>`<Part${j}/>`).join('')}</main>}`);
  }
  const builds=[];
  for(let i=0;i<5;i++){
    const began=performance.now();
    await execute(process.execPath,[path.join(source,'packages/prnext/cli.mjs'),'build',root],{cwd:source,env:{...process.env,PRNEXT_BINARY:binary},windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
    builds.push(performance.now()-began);
  }
  // A one-file edit must change rendered output while retaining unrelated work.
  await writeFile(path.join(root,'components/part59.jsx'),`export default function Part(){return <p>CHANGED-COMPONENT</p>}`);
  const editStarted=performance.now();await execute(process.execPath,[path.join(source,'packages/prnext/cli.mjs'),'build',root],{cwd:source,env:{...process.env,PRNEXT_BINARY:binary},timeout:120000,windowsHide:true});const editedBuildMs=performance.now()-editStarted;
  const probe=`import {build} from ${JSON.stringify(pathToFileURL(path.join(source,'packages/prnext/build/index.mjs')).href)};import {transformCacheStats} from ${JSON.stringify(pathToFileURL(path.join(source,'packages/prnext/build/transform-cache.mjs')).href)};const result=await build(${JSON.stringify(root)});console.log(JSON.stringify({durationMs:result.durationMs,transforms:transformCacheStats()}));`;
  const instrumented=JSON.parse((await execute(process.execPath,['--input-type=module','-e',probe],{cwd:root,env:{...process.env,PRNEXT_BINARY:binary,PWD:root,INIT_CWD:root},timeout:120000,windowsHide:true})).stdout.trim().split('\n').at(-1));
  const wakes=[];let workerFiles=0;
  for(let i=0;i<6;i++){
    const began=performance.now();let logs='',url;
    const child=spawn(binary,['start',root,'--hostname','127.0.0.1','--port','0','--workers','1','--node',process.execPath,'--shutdown-on-stdin-eof'],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_ENV:'production'},windowsHide:true});
    const closed=once(child,'close');child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
    try{
      for(let attempts=0;attempts<1000&&!url;attempts++){url=/http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];if(!url)await new Promise(resolve=>setTimeout(resolve,5));}
      assert.ok(url,logs);const response=await fetch(url+'/section19');assert.equal(response.status,200);assert.match(await response.text(),/CHANGED-COMPONENT/);
      wakes.push(performance.now()-began);
      if(i===0)await new Promise(resolve=>setTimeout(resolve,1500));
    }finally{child.stdin.end();await closed;}
  }
  async function size(directory){let bytes=0,count=0;for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const file=path.join(directory,entry.name);if(entry.isDirectory()){const nested=await size(file);bytes+=nested.bytes;count+=nested.count;}else{count++;bytes+=(await readFile(file)).length;}}return {bytes,count};}
  const v8=await size(path.join(root,'.prnext-cache/node-compile-v1'));workerFiles=v8.count;
  records.push({label,routeCount,buildsMs:builds,editedBuildMs,instrumented,wakesMs:wakes,v8,workerFiles,cache:await size(path.join(root,'.prnext-cache'))});
  await writeFile(path.join(out,'results.json'),JSON.stringify({node:process.version,platform:process.platform,records},null,2));console.log(JSON.stringify(records.at(-1)));
}
console.log('Results: '+path.join(out,'results.json'));
