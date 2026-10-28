import offline from '../compat/offline-store.cjs';

export function networkFailure(error){
  return error?.name==='NetworkError'||((error instanceof TypeError||error?.name==='TypeError')&&/fetch|network|load failed|terminated/i.test(error.message||''))||/^Connection closed\.?$/.test(error?.message||'');
}
function waitForConnection({signal,events,online,milliseconds,waitingOffline}){
  return new Promise((resolve,reject)=>{
    const finish=callback=>value=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);events?.removeEventListener('online',connected);callback(value);};
    const done=finish(resolve),fail=finish(reject),aborted=()=>fail(signal.reason||new DOMException('Navigation cancelled','AbortError'));
    const connected=()=>{if(online())done();};
    const timer=setTimeout(()=>done(),milliseconds);
    signal?.addEventListener('abort',aborted,{once:true});events?.addEventListener('online',connected);
    if(signal?.aborted)aborted();
    else if(waitingOffline&&online())done();
  });
}
// Called exclusively around navigation GETs. Server Actions never enter this
// path: a lost response does not prove their mutation failed to execute.
export async function recoverNavigation(read,{signal,events=globalThis.window,online=()=>globalThis.navigator?.onLine!==false,budgetMs=30000,maxAttempts=3}={}){
  const until=performance.now()+budgetMs;let waiting,lastError,attempts=0;
  const failure=()=>Object.assign(new Error('Unable to load the page. Check your connection and try again.',{cause:lastError}),{code:'PRNEXT_NAVIGATION_NETWORK'});
  const deadline=new AbortController(),combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  const timer=setTimeout(()=>deadline.abort(failure()),budgetMs);
  try{
    for(;;){
      combined.throwIfAborted();
      if(online()||attempts===0){
        try{return await read(combined);}catch(error){if(combined.aborted)throw combined.reason;if(!networkFailure(error))throw error;lastError=error;attempts++;waiting||=offline.beginWait();}
      }
      const remaining=until-performance.now();
      if(remaining<=0||attempts>=maxAttempts)throw failure();
      const waitingOffline=!online();
      await waitForConnection({signal:combined,events,online,waitingOffline,milliseconds:Math.min(remaining,waitingOffline?remaining:250*2**Math.max(0,attempts-1))});
    }
  }finally{clearTimeout(timer);waiting?.();}
}
