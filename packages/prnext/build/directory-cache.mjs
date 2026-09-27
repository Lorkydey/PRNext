import {readdir} from 'node:fs/promises';

const entries=new Map();
let bytes=0,hits=0,misses=0;
const limit=1024*1024,countLimit=256;
export const directoryCacheStats=()=>({entries:entries.size,bytes,hits,misses});
export function clearDirectoryCache(){entries.clear();bytes=0;}

/** Validate names on every scan: Linux directory timestamps and sizes may be
 * identical across rapid additions/renames. A stat-only cache can miss routes.
 * Keep bounded snapshots, with one readdir instead of two stat calls on misses.
 * File contents remain handled separately by the source/configuration caches. */
export async function readDirectory(directory){
  const files=await readdir(directory,{withFileTypes:true});
  const value=JSON.stringify(files.map(item=>[item.name,item.isDirectory()?'d':item.isFile()?'f':'o']));
  let entry=entries.get(directory);
  if(entry?.value===value){hits++;entries.delete(directory);entries.set(directory,entry);return decode(entry.value);}
  misses++;
  if(entry){entries.delete(directory);bytes-=entry.bytes;}
  const size=2*(directory.length+value.length);
  if(size<=64*1024){
    while(entries.size && (entries.size>=countLimit || bytes+size>limit)){
      const [key,old]=entries.entries().next().value;entries.delete(key);bytes-=old.bytes;
    }
    entries.set(directory,{value,bytes:size});bytes+=size;
  }
  return decode(value);
}
function decode(value){return JSON.parse(value).map(([name,kind])=>({name,isDirectory:()=>kind==='d',isFile:()=>kind==='f'}));}
