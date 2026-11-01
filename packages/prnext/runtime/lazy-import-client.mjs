// Only emitted by the opt-in development compiler. Successful imports retain
// native ESM caching; failed compilation is retryable after a source correction.
const pending=new Map(),styles=new Map();
function stylesheet(url){
  const existing=[...document.querySelectorAll('link[rel="stylesheet"]')].find(link=>link.href===new URL(url,location.href).href);
  if(existing?.sheet)return Promise.resolve();
  if(existing&&styles.has(url))return styles.get(url);
  const promise=new Promise((resolve,reject)=>{
    const link=existing||document.createElement('link');
    const timer=setTimeout(()=>finish(Error('Deferred stylesheet timed out')),30000);
    const finish=error=>{clearTimeout(timer);link.removeEventListener('load',loaded);link.removeEventListener('error',failed);if(error){styles.delete(url);if(!existing)link.remove();reject(error);}else resolve();};
    const loaded=()=>finish(),failed=()=>finish(Error('Deferred stylesheet failed to load'));
    link.addEventListener('load',loaded,{once:true});link.addEventListener('error',failed,{once:true});
    if(!existing){link.rel='stylesheet';link.href=url;document.head.appendChild(link);}
  });
  styles.set(url,promise);
  void promise.then(()=>styles.delete(url),()=>styles.delete(url));
  return promise;
}
export function lazyImport(id,basePath=''){
  const key=basePath+':'+id;
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    const path='/_prnext/lazy/'+id;
    const response=await fetch(`${basePath}/_prnext/ensure?path=${encodeURIComponent(path)}`,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(await response.text());
    const value=await response.json(),target=value.lazy;
    if(!target||typeof target.url!=='string'||!Array.isArray(target.css))throw Error('Invalid deferred import response');
    for(const url of [target.url,...target.css]){
      const parsed=new URL(url,location.href);
      if(parsed.origin!==location.origin||!parsed.pathname.includes('/_prnext/assets/'))throw Error('Invalid deferred import asset URL');
    }
    await Promise.all(target.css.map(stylesheet));
    const module=await import(target.url);
    return target.native?module:module.__prnextLazyModule;
  })().finally(()=>pending.delete(key));
  pending.set(key,task);return task;
}
