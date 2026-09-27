import {readdir,stat} from 'node:fs/promises';

const entries=new Map();
let bytes=0,hits=0,misses=0;
const limit=1024*1024,countLimit=256;
const signature=info=>[info.dev,info.ino,info.mtimeNs,info.ctimeNs,info.size].join(':');
export const directoryCacheStats=()=>({entries:entries.size,bytes,hits,misses});
export function clearDirectoryCache(){entries.clear();bytes=0;}

/** Directory changes invalidate names, while file contents are still read and
 * hashed by the source/configuration caches. Never infer contents from mtime. */
export async function readDirectory(directory){
  const before=signature(await stat(directory,{bigint:true}));
  let entry=entries.get(directory);
  if(entry?.signature===before){hits++;entries.delete(directory);entries.set(directory,entry);return decode(entry.value);}
  misses++;
  if(entry){entries.delete(directory);bytes-=entry.bytes;}
  const files=await readdir(directory,{withFileTypes:true});
  const after=signature(await stat(directory,{bigint:true}));
  const value=JSON.stringify(files.map(item=>[item.name,item.isDirectory()?'d':item.isFile()?'f':'o']));
  const size=2*(directory.length+value.length+after.length);
  if(before===after && size<=64*1024){
    while(entries.size && (entries.size>=countLimit || bytes+size>limit)){
      const [key,old]=entries.entries().next().value;entries.delete(key);bytes-=old.bytes;
    }
    entries.set(directory,{signature:after,value,bytes:size});bytes+=size;
  }
  return decode(value);
}
function decode(value){return JSON.parse(value).map(([name,kind])=>({name,isDirectory:()=>kind==='d',isFile:()=>kind==='f'}));}
