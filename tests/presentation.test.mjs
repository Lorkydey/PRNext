import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationFixture,presentationSecrets} from './presentation-fixture.mjs';
import {startServer} from './support.mjs';

test('production compact Flight preserves private request context, concurrent SSR, streaming cancellation and fallback',async()=>{
  const fixture=await presentationFixture();
  let server;
  try {
    await fixture.write('app/edge/page.jsx',`import Table from'../Table';import{rows}from'../data';export const runtime='edge';export default()=> <Table rows={rows(3,'Edge owner')} title="Edge presentation"/>`);
    await fixture.build();server=await startServer(fixture.root);
    const inspect=async(owner,rsc=false,count=100)=>{
      const response=await fetch(`${server.url}/?rows=${count}`,{headers:{cookie:`presentation_owner=${owner}`,...(rsc?{RSC:'1'}:{})}});
      assert.equal(response.status,200);
      const body=await response.text();
      assert.match(body,new RegExp(owner));
      for(const secret of presentationSecrets) assert.ok(!body.includes(secret));
      if(rsc){assert.match(response.headers.get('content-type'),/text\/x-component/);assert.match(body,/"__prnextPresentation":\[/);}
      else{assert.match(body,/<table>/);assert.match(body,/Product 99/);}
      return body;
    };
    await inspect('Request-A');await inspect('Request-B',true,1000);
    const responses=await Promise.all(Array.from({length:8},(_,index)=>inspect(`Isolated-${index}`,index%2===0,100)));
    for(let index=0;index<responses.length;index++) for(let other=0;other<responses.length;other++) if(index!==other) assert.ok(!responses[index].includes(`Isolated-${other}`),'request data never leaks between renders');
    const controller=new AbortController();
    const stream=await fetch(`${server.url}/stream`,{signal:controller.signal});
    const reader=stream.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});
    const recovered=await fetch(`${server.url}/stream`);assert.equal(recovered.status,200);assert.match(await recovered.text(),/Streamed products/);
    const fallback=await fetch(`${server.url}/fallback`);assert.equal(fallback.status,200);assert.match(await fallback.text(),/data-testid="fallback">7</);
    const edge=await fetch(`${server.url}/edge`,{headers:{RSC:'1'}});assert.equal(edge.status,200);const edgeBody=await edge.text();assert.match(edgeBody,/Edge owner/);assert.ok(!edgeBody.includes('__prnextPresentation'),'Edge stays on its ordinary React representation');
    await inspect('Still-healthy',true);
  }finally{await server?.close();await fixture.remove();}
});
