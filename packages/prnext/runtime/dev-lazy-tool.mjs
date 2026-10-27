// Capture user activation synchronously for detached windows, even on a slow
// connection. Import failures/disposal close reservations instead of leaking tabs.
const loaderRegistry = Symbol.for('prnext.dev.tool.loaders');

// The indicator survives Fast Refresh, while hashed import URLs belong to a
// build generation. Publish the current factories on module evaluation so an
// older, unopened indicator never requests a retired generation's lazy chunk.
// Existing tool instances remain owned by createLazyDevTool and keep their DOM.
export function registerDevToolLoaders(loaders, target = globalThis) {
  const registry = target[loaderRegistry] ||= Object.create(null);
  Object.assign(registry, loaders);
  return name => {
    const load = registry[name];
    if (typeof load !== 'function') throw Error('Development tool loader is unavailable.');
    return load();
  };
}

export function createLazyDevTool(load,{onError=console.error,reserve}={}) {
  let instance,pending,disposed=false,epoch=0;
  const get=()=>pending||=(async()=>{const value=await load();if(disposed){value.dispose();throw Error('Development tool was closed');}return instance=value;})().catch(error=>{pending=undefined;throw error;});
  return new Proxy({}, {get(_target,key){
    if(key==='dispose')return()=>{disposed=true;instance?.dispose();};
    if(key==='hide')return()=>{epoch++;instance?.hide();};
    if(key==='previewState')return()=>instance?.previewState()||{};
    return(...args)=>{
      if(disposed)return;
      if(instance)return instance[key](...args);
      const popup=reserve?.(key,args);
      const expected=epoch;
      void get().then(tool=>{if(disposed||expected!==epoch){popup?.close();return;}return tool[key](...args,...(popup!==undefined?[popup]:[]));}).catch(error=>{popup?.close();if(!disposed)onError(error);});
    };
  }});
}
