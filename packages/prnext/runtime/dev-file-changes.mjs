import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat, lstat, readdir, opendir} from 'node:fs/promises';
import {shouldWatchProjectFile} from './env.mjs';

function directoryFingerprint(entries) {
  const hash=createHash('sha256');
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) hash.update(`${entry.isDirectory()?'d':entry.isSymbolicLink()?'l':'f'}:${entry.name}\0`);
  return 'directory:'+hash.digest('hex');
}

// Remember the bytes actually consumed by webpack, not the file's contents at
// the end of a build: an edit made after a read must still trigger a rebuild.
export function createDevInputSnapshot(roots, {maxEntries=process.platform==='darwin'?8192:512,maxBytes=1024*1024}={}) {
  const inputs=new Map();
  const limitedPrefixes=new Set();let globalLimited=false;
  let bytes=0;
  function limited(relative) {
    // Source files may overflow in many sibling folders. One source-root
    // prefix remains bounded without invalidating a captured disjoint generator.
    relative=relative==='.contentlayer/generated'||relative.startsWith('.contentlayer/generated/')?'.contentlayer/generated':relative.split('/')[0];
    if(globalLimited)return;
    if([...limitedPrefixes].some(prefix=>relative===prefix||relative.startsWith(prefix+'/')))return;
    for(const prefix of limitedPrefixes)if(prefix.startsWith(relative+'/'))limitedPrefixes.delete(prefix);
    limitedPrefixes.add(relative);
    if(limitedPrefixes.size>32||[...limitedPrefixes].reduce((sum,value)=>sum+value.length*2,0)>4096){globalLimited=true;limitedPrefixes.clear();}
  }
  function remember(relative,value) {
    if (inputs.has(relative)) {
      if (inputs.get(relative)!==value) inputs.set(relative,null);
      return;
    }
    const size=relative.length*2+value.length*2+64;
    if (inputs.size>=maxEntries || bytes+size>maxBytes) {limited(value.startsWith('directory:')?relative:path.posix.dirname(relative)==='.'?relative:path.posix.dirname(relative));return;}
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
      if (!shouldWatchProjectFile(relative))return;
      if(inputs.size>=maxEntries || bytes>=maxBytes){limited(relative);return;}
      const file=path.join(roots[0],relative);
      let entries;
      try {entries=await readdir(file,{withFileTypes:true});}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      remember(relative,directoryFingerprint(entries));
      for(const entry of entries) {
        if(inputs.size>=maxEntries || bytes>=maxBytes){limited(relative);break;}
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
    entries:()=>{
      const values=[...inputs],coverage={version:1,limitedPrefixes:[...limitedPrefixes],globalLimited};
      if(values.length)values[0]=[...values[0],coverage];
      else values.push([null,null,coverage]);
      return values;
    },
  };
}

// Generators may rewrite identical JSON/modules on every compilation. Retain
// only bounded path/digest pairs, never file contents or full directory lists.
export function createDevChangeFilter(root, {directoryEventsAreRecursive=false,maxEntries=directoryEventsAreRecursive?8192:512,maxBytes=1024*1024,ignore=()=>false,maxTreeEntries=8192,maxTreeBytes=1024*1024,onUncertainDirectory=()=>{}}={}) {
  const fingerprints=new Map();
  // Before the first build there are no consumed inputs to lose. A later
  // acceptInputs without coverage metadata deliberately replaces this proof.
  const trees=new Map(),diagnostics=new Map();let treeBytes=0,coverage={version:1,limitedPrefixes:[],globalLimited:false},consumedInputs=new Map();
  const contains=(parent,file)=>file===parent||file.startsWith(parent+'/');
  const allowed=file=>shouldWatchProjectFile(file)&&!ignore(file);
  const limitedFor=file=>!coverage||coverage.globalLimited||coverage.limitedPrefixes.some(prefix=>contains(file,prefix)||contains(prefix,file));
  function discardTree(file){const previous=trees.get(file);if(previous){trees.delete(file);treeBytes-=previous.bytes;}}
  function uncertain(file,reason){
    discardTree(file);
    if(diagnostics.get(file)!==reason){
      diagnostics.delete(file);diagnostics.set(file,reason);while(diagnostics.size>32)diagnostics.delete(diagnostics.keys().next().value);
      onUncertainDirectory({directory:file.slice(0,256),reason});
    }
    return Object.assign(Error(`Cannot verify a coalesced directory change in ${file.slice(0,256)} (${reason}). The previous build is kept. Run a full build or narrow generated inputs before retrying.`),{code:'PRNEXT_RECURSIVE_CHANGE_UNVERIFIED'});
  }
  async function treeSnapshot(relative){
    const observed=new Map();let entriesRead=0,retainedBytes=relative.length*2+128;
    const incomplete=reason=>{throw Object.assign(Error('Incomplete recursive source snapshot'),{snapshotReason:reason});};
    async function visit(name){
      const file=path.join(root,name),before=await lstat(file);let value,semantic;
      if(before.isSymbolicLink())incomplete('symbolic-link');
      if(before.isDirectory()){
        const entries=[],directory=await opendir(file);
        for await(const entry of directory){if(++entriesRead>maxTreeEntries)incomplete('entry-capacity');entries.push(entry);}
        value=directoryFingerprint(entries);
        const watched=entries.filter(entry=>allowed(name+'/'+entry.name));semantic=directoryFingerprint(watched);
        rememberObserved(name,value,semantic);
        for(const entry of watched)await visit(name+'/'+entry.name);
      }else if(before.isFile()){
        const hash=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:64*1024}))hash.update(chunk);
        value='file:'+hash.digest('hex');rememberObserved(name,value,value);
      }else incomplete('special-file');
      const after=await lstat(file);
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)incomplete('changed-during-read');
    }
    function rememberObserved(file,value,semantic){
      retainedBytes+=2*(file.length+value.length+semantic.length)+96;
      if(observed.size>=maxTreeEntries||retainedBytes>maxTreeBytes)incomplete('memory-capacity');
      observed.set(file,{value,semantic});
    }
    try{
      await visit(relative);const hash=createHash('sha256');
      for(const [file,value]of [...observed].sort(([a],[b])=>a.localeCompare(b)))hash.update(JSON.stringify([file,value.semantic]));
      return {complete:true,observed,digest:hash.digest('hex'),bytes:retainedBytes};
    }catch(error){return {complete:false,reason:error.snapshotReason||'read-failure'};}
  }
  function retainTree(file,snapshot){
    discardTree(file);
    while(trees.size&&(trees.size>=32||treeBytes+snapshot.bytes>maxTreeBytes))discardTree(trees.keys().next().value);
    trees.set(file,snapshot);treeBytes+=snapshot.bytes;
  }
  function observeTree(file,snapshot){
    for(const [name,previous]of [...fingerprints])if(contains(file,name)&&allowed(name)&&!snapshot.observed.has(name)&&previous.value!=='missing')remember(name,'missing');
    for(const [name,value]of consumedInputs)if(contains(file,name)&&allowed(name)&&snapshot.observed.get(name)?.value!==value)consumedInputs.delete(name);
    for(const [directory,previous]of trees){
      if(!contains(file,directory)&&!contains(directory,file))continue;
      const same=[...previous.observed].every(([name,value])=>!contains(file,name)||snapshot.observed.get(name)?.semantic===value.semantic)
        &&[...snapshot.observed].every(([name,value])=>!contains(directory,name)||previous.observed.get(name)?.semantic===value.semantic);
      if(!same)discardTree(directory);
    }
  }
  function observePath(file,value){
    for(const [directory,snapshot]of trees){
      if(contains(directory,file)){
        const observed=snapshot.observed.get(file);
        if(value===undefined||(value==='missing'?observed!==undefined:observed?.value!==value))discardTree(directory);
      }else if(contains(file,directory))discardTree(directory);
    }
    for(const [name,previous]of consumedInputs)if(contains(file,name)&&(name!==file||previous!==value))consumedInputs.delete(name);
    if(!value?.startsWith('directory:'))for(const [name]of [...fingerprints])if(name!==file&&contains(file,name))remember(name,value===undefined?undefined:'missing');
  }
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
      if(directoryEventsAreRecursive&&allowed(file)){
        let directory=false;try{directory=(await stat(path.join(root,file))).isDirectory();}catch{}
        if(directory){
          const snapshot=await treeSnapshot(file);
          if(!snapshot.complete)throw uncertain(file,snapshot.reason);
          if(limitedFor(file))throw uncertain(file,'input-coverage');
          observeTree(file,snapshot);
          const previous=trees.get(file);
          const consumed=[...snapshot.observed].every(([name,value])=>consumedInputs.get(name)===value.value)
            &&[...consumedInputs].every(([name,value])=>!contains(file,name)||!allowed(name)||!value.startsWith('file:')||snapshot.observed.has(name));
          if((!previous||previous.digest!==snapshot.digest)&&!consumed)changed.push(file);
          retainTree(file,snapshot);
          diagnostics.delete(file);
          continue;
        }
      }
      const value=await fingerprint(file), previous=fingerprints.get(file);
      if(directoryEventsAreRecursive)observePath(file,value);
      if (value===undefined || !previous || previous.value!==value) changed.push(file);
      remember(file,value);
    }
    return changed;
  };
  filter.acceptInputs=inputs=>{
    coverage=inputs.find(entry=>entry[2]?.version===1)?.[2];
    // Only the latest bounded compiler receipt can acknowledge an uncached
    // subtree. Event deduplication may keep older values in its independent LRU.
    consumedInputs=new Map();for(const [file,value]of inputs)if(typeof file==='string'&&typeof value==='string')consumedInputs.set(file,value);
    for(const [directory,snapshot]of trees){
      if(limitedFor(directory)||inputs.some(([file,value])=>typeof file==='string'&&contains(directory,file)&&allowed(file)&&(value===null||snapshot.observed.get(file)?.value!==value)))discardTree(directory);
    }
    const changed=[];for(const [file,value] of inputs){if(typeof file!=='string')continue;if(fingerprints.get(file)?.value!==value)changed.push(file);remember(file,value);}return changed;
  };
  filter.recursiveDiagnostics=()=>[...diagnostics].map(([directory,reason])=>({directory,reason}));
  return filter;
}
