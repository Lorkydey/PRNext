// Share Flight allocations with the SSR decoder, then group only already
// available bootstrap bytes. Never wait for a future Suspense chunk to fill a
// block. The queue's pre-shell ceiling remains the overall response budget.
export function flightTap(source, metrics) {
  const reader=source.getReader(),queue=[];
  let head=0,bytes=0,done=false,failure,outputStarted=false,wakeData,wakeSpace,cancelled;
  const finish=error=>{done=true;failure=error;wakeData?.();wakeData=undefined;wakeSpace?.();wakeSpace=undefined;};
  const cancel=reason=>cancelled??=(async()=>{finish(reason);queue.length=0;head=0;bytes=0;await reader.cancel(reason).catch(()=>{});})();
  const body=new ReadableStream({
    async pull(controller){try{
      while(!done&&outputStarted&&bytes>=128*1024)await new Promise(resolve=>{wakeSpace=resolve;});
      if(done){if(failure)controller.error(failure);else controller.close();return;}
      const next=await reader.read();if(next.done){finish();controller.close();return;}
      queue.push(next.value);bytes+=next.value.byteLength;
      if(metrics){metrics.chunk(next.value.byteLength);metrics.peakQueuedBytes=Math.max(metrics.peakQueuedBytes,bytes);}
      wakeData?.();wakeData=undefined;controller.enqueue(next.value);
    }catch(error){finish(error);controller.error(error);}},cancel,
  },{highWaterMark:0});
  return {body,cancel,startOutput(){outputStarted=true;},async next(){
    while(head===queue.length&&!done)await new Promise(resolve=>{wakeData=resolve;});
    if(head<queue.length){
      const first=queue[head];queue[head++]=undefined;
      let size=first.byteLength,parts;
      while(head<queue.length&&size+queue[head].byteLength<=32*1024){
        parts??=[first];const value=queue[head];queue[head++]=undefined;parts.push(value);size+=value.byteLength;
      }
      bytes-=size;if(head===queue.length){queue.length=0;head=0;}else if(head>=64){queue.splice(0,head);head=0;}
      wakeSpace?.();wakeSpace=undefined;
      return {value:parts?Buffer.concat(parts,size):first,done:false};
    }
    if(failure)throw failure;return {done:true};
  }};
}
