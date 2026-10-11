import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const [base, metrics] = process.argv.slice(2);
const get=route=>new Promise((resolve,reject)=>{
  const req=http.get(base+route,{headers:{'accept-encoding':'identity'}},res=>{let bytes=0;res.on('data',data=>bytes+=data.length);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes}));res.on('error',reject);});
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('request timeout')));
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const latest=()=>JSON.parse(readFileSync(metrics,'utf8').trim().split('\n').at(-1));
let slow;
try {
  const first=await new Promise((resolve,reject)=>{
    slow=http.get(base+'/large-v6.bin',{headers:{'accept-encoding':'identity'}},res=>{res.pause();res.on('error',()=>{});resolve({status:res.statusCode,length:res.headers['content-length']});});slow.on('error',reject);
  });
  assert.equal(first.status,200);assert.equal(Number(first.length),32*1024*1024);
  const rejected=await get('/payload.txt');
  assert.equal(rejected.status,503);assert.equal(rejected.headers['retry-after'],'1');assert.equal(rejected.headers['cache-control'],'no-store');
  await sleep(1100);const held=latest();assert.equal(held.fileAdmission.active,1);assert.equal(held.fileAdmission.waiting,0);assert.ok(held.fileAdmission.rejected>0);
  slow.destroy();
  let recovered;
  for(let i=0;i<50;i++){await sleep(50);recovered=await get('/payload.txt');if(recovered.status===200)break;}
  assert.equal(recovered.status,200);
  await sleep(1100);const after=latest();assert.equal(after.fileAdmission.active,0);assert.equal(after.fileAdmission.waiting,0);assert.equal(after.fileWorkAdmission.active,0);assert.equal(after.fileWorkAdmission.waiting,0);
  const ranged=await new Promise((resolve,reject)=>{http.get(base+'/large-v6.bin',{headers:{range:'bytes=0-31','accept-encoding':'identity'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks).length}));}).on('error',reject);});
  assert.deepEqual(ranged,{status:206,bytes:32});
  console.log(JSON.stringify({complete:true,first,rejected,recovered,held,after,ranged}));
} finally {slow?.destroy();}
