import path from 'node:path';

// macOS native file notifications can miss an edit while the watch program is
// compiling. Use TypeScript's adaptive metadata polling for project inputs;
// installed dependencies keep native watchers and incur no extra polling.
export function createTypeScriptWatchSystem(ts,root,{platform=process.platform,env=process.env}={}){
  const system=ts.sys;
  if(platform!=='darwin'||env.TSC_WATCHFILE||env.TSC_NONPOLLING_WATCHER)return system;
  const requestedRoot=path.resolve(root);
  const physical=filename=>{try{return path.resolve(system.realpath?.(filename)||filename);}catch{return path.resolve(filename);}};
  const physicalRoot=physical(requestedRoot),normalize=filename=>system.useCaseSensitiveFileNames?filename:filename.toLowerCase();
  const inside=(base,filename)=>{
    const relative=path.relative(normalize(base),normalize(filename));
    return relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)&&!relative.split(path.sep).includes('node_modules');
  };
  return {...system,watchFile(filename,callback,interval,options){
    const absolute=path.resolve(filename);
    if(options?.watchFile===undefined&&(inside(requestedRoot,absolute)||inside(physicalRoot,absolute))&&inside(physicalRoot,physical(absolute)))
      options={...options,watchFile:ts.WatchFileKind.DynamicPriorityPolling};
    return system.watchFile(filename,callback,interval,options);
  }};
}
