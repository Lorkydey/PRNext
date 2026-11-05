// Cancellation owns only a queued request. An executing build can also serve
// another navigation or a watcher update, and must finish normally.
export function createDevelopmentQueue({isStopping=()=>false,now=Date.now}={}) {
  const waiting=[];let running=false;const idle=[];
  const expired=()=>Error('Development request expired before compilation started');
  function drain(){
    if(running)return;
    const entry=waiting.shift();
    if(!entry){for(const resolve of idle.splice(0))resolve();return;}
    entry.clean();running=true;
    Promise.resolve().then(()=>{
      if(isStopping())throw Error('Development is stopping');
      if(entry.signal?.aborted||entry.deadlineMs!==undefined&&now()>=entry.deadlineMs)throw expired();
      return entry.run();
    }).then(entry.resolve,entry.reject).finally(()=>{running=false;drain();});
  }
  return {
    enqueue(run,{signal,deadlineMs}={}) {
      if(signal?.aborted||deadlineMs!==undefined&&(!Number.isSafeInteger(deadlineMs)||now()>=deadlineMs))return Promise.reject(expired());
      return new Promise((resolve,reject)=>{
        let timer;
        const cancel=()=>{const index=waiting.indexOf(entry);if(index<0)return;waiting.splice(index,1);entry.clean();reject(expired());if(!running)drain();};
        const entry={run,resolve,reject,signal,deadlineMs,clean(){clearTimeout(timer);signal?.removeEventListener('abort',cancel);}};
        waiting.push(entry);signal?.addEventListener('abort',cancel,{once:true});
        if(deadlineMs!==undefined)timer=setTimeout(cancel,Math.max(0,deadlineMs-now()));
        // Defer the first start so same-turn cancellation cannot start work.
        queueMicrotask(drain);
      });
    },
    idle(){return running||waiting.length?new Promise(resolve=>idle.push(resolve)):Promise.resolve();},
    get pending(){return waiting.length;},
  };
}
