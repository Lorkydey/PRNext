import {availableParallelism} from 'node:os';

// A shared finite worker set, with deterministic results and full settlement
// before a caller discards its stage. No new work starts after a failure.
export async function mapConcurrent(items,run,limit=Math.min(4,availableParallelism())) {
  if(!Number.isInteger(limit)||limit<1||limit>32)throw new RangeError('Invalid build concurrency');
  const values=Array.from(items),results=new Array(values.length);let next=0,failure,failed=false;
  await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{
    while(!failed&&next<values.length){const index=next++;try{results[index]=await run(values[index],index);}catch(error){if(!failed){failed=true;failure=error;}}}
  }));
  if(failed)throw failure;return results;
}
