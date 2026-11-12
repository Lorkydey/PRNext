import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('artifacts/lock-diagnostic');
assert.ok(root.startsWith(process.cwd()+path.sep));
await mkdir(root,{recursive:true});
const results=[];let next=0;
async function lane(){
  for(;;){
    const index=next++;if(index>=32)return;
    const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=a killed publisher','packages/prnext/build/build-lock.test.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log=(log+data).slice(-65536);});
    const result=await new Promise(resolve=>{child.once('error',()=>resolve({exit:null,error:'spawn failed'}));child.once('exit',(exit,signal)=>resolve({exit,signal}));});
    await writeFile(path.join(root,`case-${index}.log`),log);
    results.push({index,...result});
  }
}
await Promise.all(Array.from({length:4},()=>lane()));
const report={node:process.version,platform:process.platform,planned:32,concurrency:4,results:results.sort((a,b)=>a.index-b.index)};
await writeFile(path.join(root,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({node:report.node,passed:results.filter(r=>r.exit===0).length,failed:results.filter(r=>r.exit!==0).length}));
process.exitCode=results.some(r=>r.exit!==0)?1:0;
