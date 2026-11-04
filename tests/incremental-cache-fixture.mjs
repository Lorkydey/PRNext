import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheFixture } from './cache-fixture.mjs';

export async function incrementalFixture() {
  const fixture = await cacheFixture();
  try {
    await writeFile(path.join(fixture.root, 'prnext.config.mjs'), `export default {cacheHandler:'./legacy-handler.ts',cacheMaxMemorySize:0}`);
    await writeFile(path.join(fixture.root, 'legacy-handler.ts'), `
import {mkdir,readFile,writeFile,rename,appendFile,open,unlink} from 'node:fs/promises';import{serialize,deserialize}from'node:v8';import{createHash,randomUUID}from'node:crypto';import{fileURLToPath}from'node:url';import{performance}from'node:perf_hooks';import{setTimeout as delay}from'node:timers/promises';
const root=fileURLToPath(new URL('../../.incremental-shared/',import.meta.url));
const filename=(key:string)=>root+createHash('sha256').update(key).digest('hex');
async function read(key:string){try{return deserialize(await readFile(filename(key)))}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function write(key:string,value:unknown){await mkdir(root,{recursive:true});const temporary=filename(key)+randomUUID();await writeFile(temporary,serialize(value));await rename(temporary,filename(key))}
async function note(method:string,key:string,kind:string){await mkdir(root,{recursive:true});await appendFile(root+'events.jsonl',JSON.stringify({method,key,kind})+'\\n')}
// Wall-clock ticks cannot order invalidation and refill, particularly on Windows.
// Serialize the shared fixture's revisions and publications across processes.
async function locked(work:()=>Promise<any>){
 await mkdir(root,{recursive:true});const filename=root+'revision.lock',deadline=performance.now()+2000;let owner;
 for(;;){try{owner=await open(filename,'wx');break}catch(error){if(error.code!=='EEXIST')throw error;if(performance.now()>=deadline)throw Error('Incremental fixture lock timed out');await delay(5)}}
 try{return await work()}finally{try{await owner.close()}finally{await unlink(filename)}}
}
async function mutate(work:(revision:number)=>Promise<any>){return locked(async()=>{const revision=(await read('revision')||0)+1;if(!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid incremental fixture revision');await write('revision',revision);return work(revision)})}
export default class Handler {
 constructor(public options:any){}
 resetRequestCache(){}
 async get(key:string,ctx:any){await note('get',key,ctx.kind);return locked(async()=>{const entry=await read('entry:'+key);if(!entry)return null;for(const tag of new Set([...entry.tags,...ctx.tags||[],...ctx.softTags||[]]))if((await read('tag:'+tag)||0)>=entry.revision)return null;return entry})}
 async set(key:string,value:any,ctx:any){await note('set',key,value?.kind);return mutate(revision=>write('entry:'+key,value===null?null:{value,lastModified:Date.now(),revision,tags:ctx.tags||[]}))}
 async revalidateTag(tags:string|string[]){return mutate(async revision=>{for(const tag of typeof tags==='string'?[tags]:tags)await write('tag:'+tag,revision)})}
}`);
    const files = {
      'pages/legacy-pages.jsx': `export async function getStaticProps(){const data=await(await fetch(${JSON.stringify(fixture.originUrl + '/?key=legacy-pages')})).json();return {props:data,revalidate:60}}export default({value,count})=><p data-testid="legacy">{value}:{count}</p>`,
      'pages/api/legacy-revalidate.js': `export default async function handler(req,res){await res.revalidate('/legacy-pages');res.json({ok:true})}`,
      'app/legacy-page/page.jsx': `import{origin}from'../data';export const revalidate=60;export default async()=>{const data=await(await fetch(origin+'/?key=legacy-page',{cache:'force-cache',next:{tags:['legacy-page']}})).json();return <p data-testid="legacy">{data.value}:{data.count}</p>}`,
      'app/legacy-route/route.js': `import{origin}from'../data';export const revalidate=60;export async function GET(){return Response.json(await(await fetch(origin+'/?key=legacy-route',{cache:'force-cache',next:{tags:['legacy-route']}})).json())}`,
    };
    for (const [name, source] of Object.entries(files)) { const filename = path.join(fixture.root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); }
    await fixture.build();
    return fixture;
  } catch (error) { await fixture.remove(); throw error; }
}
