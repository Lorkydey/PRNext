import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat, readdir} from 'node:fs/promises';
import {shouldWatchProjectFile} from './env.mjs';

function directoryFingerprint(entries) {
  const hash=createHash('sha256');
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) hash.update(`${entry.isDirectory()?'d':entry.isSymbolicLink()?'l':'f'}:${entry.name}\0`);
  return 'directory:'+hash.digest('hex');
}

// Remember the bytes actually consumed by webpack, not the file's contents at
// the end of a build: an edit made after a read must still trigger a rebuild.
export function createDevInputSnapshot(roots, {maxEntries=512,maxBytes=1024*1024}={}) {
  const inputs=new Map();
  let bytes=0;
  function remember(relative,value) {
    if (inputs.has(relative)) {
      if (inputs.get(relative)!==value) inputs.set(relative,null);
      return;
    }
    const size=relative.length*2+value.length*2+64;
    if (inputs.size>=maxEntries || bytes+size>maxBytes) return;
    inputs.set(relative,value);bytes+=size;
  }
  return {
    record(file, source) {
      const root=roots.find(root=>file.startsWith(root+path.sep));
      if (!root) return;
      const relative=path.relative(root,file).replaceAll(path.sep,'/');
      if (!shouldWatchProjectFile(relative)) return;
      const value='file:'+createHash('sha256').update(source).digest('hex');
      // Different targets consuming different bytes cannot acknowledge this
      // event, even when the file is changed back before compilation ends.
      remember(relative,value);
    },
    async captureDirectory(relative) {
      // Called after an awaited content generator and before graph resolution.
      // Include its types/aggregate indexes, which may not be runtime imports.
      if (!shouldWatchProjectFile(relative) || inputs.size>=maxEntries || bytes>=maxBytes) return;
      const file=path.join(roots[0],relative);
      let entries;
      try {entries=await readdir(file,{withFileTypes:true});}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      remember(relative,directoryFingerprint(entries));
      for(const entry of entries) {
        if(inputs.size>=maxEntries || bytes>=maxBytes)break;
        const child=relative+'/'+entry.name;
        if(!shouldWatchProjectFile(child))continue;
        if(entry.isDirectory())await this.captureDirectory(child);
        else if(entry.isFile()) {
          const hash=createHash('sha256');
          try {
            for await(const chunk of createReadStream(path.join(file,entry.name),{highWaterMark:64*1024}))hash.update(chunk);
            remember(child,'file:'+hash.digest('hex'));
          } catch(error) {if(error.code!=='ENOENT')throw error;}
        }
      }
    },
    entries:()=>[...inputs],
  };
}

// Generators may rewrite identical JSON/modules on every compilation. Retain
// only bounded path/digest pairs, never file contents or full directory lists.
export function createDevChangeFilter(root, {maxEntries=512,maxBytes=1024*1024}={}) {
  const fingerprints=new Map();
  let bytes=0;
  function remember(file,value) {
    const previous=fingerprints.get(file);
    if (previous) {fingerprints.delete(file);bytes-=previous.size;}
    if (value==null) return;
    const size=file.length*2+value.length*2+64;
    if (size>maxBytes || maxEntries<1) return;
    while(fingerprints.size>=maxEntries || bytes+size>maxBytes) {
      const [key,oldest]=fingerprints.entries().next().value;
      fingerprints.delete(key);bytes-=oldest.size;
    }
    fingerprints.set(file,{value,size});bytes+=size;
  }
  async function fingerprint(relative) {
    const file=path.join(root,relative), hash=createHash('sha256');
    try {
      const info=await stat(file);
      if (info.isDirectory()) {
        const entries=await readdir(file,{withFileTypes:true});
        return directoryFingerprint(entries);
      }
      if (!info.isFile()) return `special:${info.mode}:${info.mtimeMs}`;
      for await (const chunk of createReadStream(file,{highWaterMark:64*1024})) hash.update(chunk);
      return 'file:'+hash.digest('hex');
    } catch (error) {
      if (error.code==='ENOENT' || error.code==='ENOTDIR') return 'missing';
      // An unreadable/changing file must still trigger the compiler diagnostic.
      return undefined;
    }
  }
  const filter=async files => {
    const changed=[];
    for (const file of files) {
      const value=await fingerprint(file), previous=fingerprints.get(file);
      if (value===undefined || !previous || previous.value!==value) changed.push(file);
      remember(file,value);
    }
    return changed;
  };
  filter.acceptInputs=inputs=>{for(const [file,value] of inputs)remember(file,value);};
  return filter;
}
