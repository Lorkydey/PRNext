import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheFixture } from './cache-fixture.mjs';

export async function incrementalFixture() {
  const fixture = await cacheFixture();
  try {
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default {cacheHandler:'./legacy-handler.ts',cacheMaxMemorySize:0}`);
    await writeFile(path.join(fixture.root, 'legacy-handler.ts'), `
import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';import{serialize,deserialize}from'node:v8';import{createHash,randomUUID}from'node:crypto';import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../../.incremental-shared/',import.meta.url));
const filename=(key:string)=>root+createHash('sha256').update(key).digest('hex');
async function read(key:string){try{return deserialize(await readFile(filename(key)))}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function write(key:string,value:unknown){await mkdir(root,{recursive:true});const temporary=filename(key)+randomUUID();await writeFile(temporary,serialize(value));await rename(temporary,filename(key))}
async function note(method:string,key:string,kind:string){await mkdir(root,{recursive:true});await appendFile(root+'events.jsonl',JSON.stringify({method,key,kind})+'\\n')}
export default class Handler {
 constructor(public options:any){}
 resetRequestCache(){}
 async get(key:string,ctx:any){await note('get',key,ctx.kind);const entry=await read('entry:'+key);if(!entry)return null;for(const tag of new Set([...entry.tags,...ctx.tags||[],...ctx.softTags||[]]))if((await read('tag:'+tag)||0)>=entry.lastModified)return null;return entry}
 async set(key:string,value:any,ctx:any){await note('set',key,value?.kind);if(value===null)return write('entry:'+key,null);await write('entry:'+key,{value,lastModified:Date.now(),tags:ctx.tags||[]})}
 async revalidateTag(tags:string|string[]){for(const tag of typeof tags==='string'?[tags]:tags)await write('tag:'+tag,Date.now())}
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
