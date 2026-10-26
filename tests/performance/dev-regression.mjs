import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export function checkDevRegression(current,baseline){
  if(current.complete!==true||current.pageErrors.length||current.edits<20)throw Error('Incomplete or failing development endurance report');
  if(!Number.isFinite(current.metrics.heapGrowthBytes)||current.metrics.heapGrowthBytes>128*1024*1024)throw Error('Development browser memory exceeded its growth budget');
  for(const kind of ['js','css'])if(!Number.isFinite(current.metrics[kind].p95)||current.metrics[kind].p95<=0)throw Error('Incomplete development refresh measurements');
  if(!baseline)return;
  for(const key of ['platform','arch','cpu','node'])if(current.machine[key]!==baseline.machine[key])throw Error('Performance baseline requires the same machine and Node version');
  if(current.fixture!==baseline.fixture||current.edits!==baseline.edits||baseline.complete!==true)throw Error('Performance baseline workload does not match');
  checkDevRegression(baseline);
  for(const kind of ['js','css']){
    const limit=baseline.metrics[kind].p95*1.25+25;
    if(!Number.isFinite(current.metrics[kind].p95)||current.metrics[kind].p95>limit)throw Error(`${kind} refresh p95 regressed: ${current.metrics[kind].p95.toFixed(1)} ms > ${limit.toFixed(1)} ms`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const current=JSON.parse(await readFile(process.argv[2],'utf8')),baseline=process.argv[3]?JSON.parse(await readFile(process.argv[3],'utf8')):undefined;
  checkDevRegression(current,baseline);console.log('Development endurance/performance checks passed.');
}
