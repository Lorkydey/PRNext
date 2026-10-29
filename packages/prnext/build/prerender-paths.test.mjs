import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, disposeBuildSession } from './index.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(files,run){
  const root=await mkdtemp(path.join(repository,'.prnext-prerender-paths-'));
  try{for(const[name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),source.replace(/'(discovery|app-calls|pages-calls)\.txt'/g,(_,file)=>JSON.stringify(path.join(root,file+'.txt'))));}await run(root);}
  finally{await disposeBuildSession(root);await rm(root,{recursive:true,force:true});}
}
const cpu=`const usage=process.cpuUsage();while(process.cpuUsage(usage).user+process.cpuUsage(usage).system<40000){}`;

test('authored App and Pages paths use bounded processes, discover params once and preserve artifact order across builds',async()=>{
  await fixture({
    'prnext.config.mjs':`export default {prerender:{workers:2,maxMemoryMb:1536}}`,
    'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
    'app/app/[category]/layout.jsx':`import{appendFileSync}from'node:fs';
      export const dynamicParams=false;
      export function generateStaticParams(){appendFileSync('discovery.txt','parent\\n');return[{category:'a'},{category:'b'}]}
      export default({children})=>children;`,
    'app/app/[category]/[id]/page.jsx':`import{appendFileSync}from'node:fs';
      export function generateStaticParams({params}){appendFileSync('discovery.txt','child:'+params.category+'\\n');return[{id:'0'},{id:'1'},{id:'2'}]}
      export default async function Page({params}){const value=await params;${cpu};appendFileSync('app-calls.txt',value.category+'/'+value.id+'\\n');return <h1 data-pid={process.pid}>{value.category}/{value.id}</h1>}`,
    'pages/legacy/[id].jsx':`import{appendFileSync}from'node:fs';
      export function getStaticPaths(){appendFileSync('discovery.txt','pages\\n');return{paths:['/legacy/0','/legacy/1','/legacy/2','/legacy/3'],fallback:false}}
      export function getStaticProps({params}){${cpu};appendFileSync('pages-calls.txt',params.id+'\\n');return{props:{id:params.id,pid:process.pid}}}
      export default({id,pid})=><h1 data-pid={pid}>legacy:{id}</h1>`,
    'pages/server.jsx':`export const getServerSideProps=()=>{throw new Error('SSR must never run at build')};export default()=>null`,
  },async root=>{
    const first=await build(root);
    const expectedApp=['/app/a/0','/app/a/1','/app/a/2','/app/b/0','/app/b/1','/app/b/2'];
    assert.deepEqual(first.prerendered.filter(seed=>seed.path.startsWith('/app/')).map(seed=>seed.path),expectedApp);
    assert.deepEqual(first.prerendered.filter(seed=>seed.path.startsWith('/legacy/')).map(seed=>seed.path),['/legacy/0','/legacy/1','/legacy/2','/legacy/3']);
    assert.deepEqual((await readFile(path.join(root,'discovery.txt'),'utf8')).trim().split('\n').sort(),['child:a','child:b','pages','parent']);
    assert.deepEqual((await readFile(path.join(root,'app-calls.txt'),'utf8')).trim().split('\n').sort(),expectedApp.map(value=>value.slice(5)));
    assert.deepEqual((await readFile(path.join(root,'pages-calls.txt'),'utf8')).trim().split('\n').sort(),['0','1','2','3']);
    assert.ok(!first.prerendered.some(seed=>seed.path==='/server'));
    const pids=new Set();
    for(const seed of first.prerendered.filter(seed=>seed.path.startsWith('/app/'))){const html=await readFile(path.join(first.outputDirectory,seed.file),'utf8');pids.add(Number(/data-pid="(\d+)"/.exec(html)[1]));}
    // The compiler can change free RAM before the pool samples its admission
    // budget. Serial fallback is valid; a pre-build RAM estimate is not proof
    // that two workers were actually admitted. Deterministic pool tests verify
    // parallel dispatch separately, while this fixture checks the real bound.
    assert.ok(pids.size >= 1 && pids.size <= 2);
    if(pids.size===2)assert.ok(!pids.has(process.pid));
    const second=await build(root,{incremental:true});
    assert.deepEqual(second.prerendered.map(seed=>[seed.path,seed.file,seed.dataFile]),first.prerendered.map(seed=>[seed.path,seed.file,seed.dataFile]));
    assert.deepEqual((await readFile(path.join(root,'discovery.txt'),'utf8')).trim().split('\n').sort(),['child:a','child:a','child:b','child:b','pages','pages','parent','parent']);
  });
});
