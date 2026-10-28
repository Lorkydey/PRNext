import {Writable} from 'node:stream';
import {renderToPipeableStream} from 'react-dom/server';

// One bounded Node stream, without a second Web reader queue. Partial React
// continuations keep using their original Web API and opaque resume state.
export function nodeHtmlReader(element,options={}){
  return new Promise((resolve,reject)=>{
    const {signal,...renderOptions}=options;
    let renderer,settled=false,finished=false,slot,pending,acknowledge,failure;
    const cleanup=()=>signal?.removeEventListener('abort',aborted);
    const deliver=()=>{
      if(!pending)return;
      const {resolve,reject}=pending;
      if(failure){pending=undefined;reject(failure);}
      else if(slot){pending=undefined;const current=slot;slot=undefined;acknowledge=current.done;resolve({value:current.chunk,done:false});}
      else if(finished){pending=undefined;resolve({done:true});}
    };
    // A single writable replaces PassThrough's writable+readable machinery.
    // Keep its write callback until the next read: React may reuse a chunk only
    // after its consumer has finished, and native backpressure stays bounded.
    const stream=new Writable({highWaterMark:64*1024,
      write(chunk,_encoding,done){slot={chunk,done};deliver();},
      final(done){finished=true;cleanup();deliver();done();},
    });
    const fail=error=>{failure=error;if(!settled){settled=true;cleanup();reject(error);}deliver();stream.destroy(error);};
    stream.on('error',error=>{failure=error;cleanup();deliver();});
    const aborted=()=>{const error=signal.reason||new Error('HTML render was cancelled');renderer?.abort(error);fail(error);};
    if(signal?.aborted){aborted();return;}
    signal?.addEventListener('abort',aborted,{once:true});
    try{
      renderer=renderToPipeableStream(element,{...renderOptions,onShellError:fail,onShellReady(){
        if(settled)return;settled=true;
        resolve({
          read(){
            if(pending)return Promise.reject(new Error('HTML reads must be sequential.'));
            const done=acknowledge;acknowledge=undefined;done?.();
            return new Promise((resolve,reject)=>{pending={resolve,reject};deliver();});
          },
          async cancel(reason){if(finished)return;finished=true;cleanup();renderer.abort(reason);const done=acknowledge||slot?.done;acknowledge=undefined;slot=undefined;stream.destroy();done?.();deliver();},
          releaseLock(){if(finished)cleanup();},
        });
        renderer.pipe(stream);
      }});
    }catch(error){fail(error);}
  });
}
export const useNodeHtml=()=>process.env.PRNEXT_SSR_STREAM==='node';
