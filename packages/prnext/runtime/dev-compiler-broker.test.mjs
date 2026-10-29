import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createDevCompilerBroker} from './dev-compiler-broker.mjs';

test('Compiler broker authenticates, bounds pending work, and only accepts discovered pattern requests',async t=>{
  let finish,entered;const started=new Promise(resolve=>entered=resolve),calls=[];
  const broker=await createDevCompilerBroker({maxPending:1,compile:async(...args)=>{calls.push(args);entered();await new Promise(resolve=>finish=resolve);return '.prnext-dev/session/generation';}});
  t.after(broker.close);const {port,token}=JSON.parse(broker.descriptor),url=`http://127.0.0.1:${port}/compile`;
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const first=fetch(url,{method:'POST',headers,body:JSON.stringify({pattern:'/article/[id]',sources:['/feed']})});await started;
  const excess=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(excess.status,503);await excess.body.cancel();
  finish();const response=await first;assert.equal(response.status,200);assert.deepEqual(await response.json(),{directory:'.prnext-dev/session/generation'});
  assert.deepEqual(calls,[['/article/[id]',['/feed']]]);
  for(const input of [{pattern:'relative'},{pattern:'/x',sources:['relative']},{pattern:'/x',sources:Array(33).fill('/a')}]){
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,500);await response.body.cancel();
  }
  assert.equal(calls.length,1);
});
test('Compiler control preserves UTF-8 names split across request chunks',async t=>{
  let captured;const broker=await createDevCompilerBroker({compile:async pattern=>{captured=pattern;return 'generation';}});t.after(broker.close);
  const {port,token}=JSON.parse(broker.descriptor),body=Buffer.from(JSON.stringify({pattern:'/café',sources:[]})),split=body.indexOf(Buffer.from('é'))+1;
  await new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path:'/compile',method:'POST',headers:{authorization:'Bearer '+token}},response=>{assert.equal(response.statusCode,200);response.resume();response.on('end',resolve);});
    request.on('error',reject);request.write(body.subarray(0,split));setTimeout(()=>request.end(body.subarray(split)),10);
  });assert.equal(captured,'/café');
});
