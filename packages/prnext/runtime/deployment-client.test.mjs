import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeploymentResponse, deploymentHeaders } from './deployment-client.mjs';
test('generation handshake rejects changed or missing acknowledgements before body decoding',async()=>{
  assert.deepEqual(deploymentHeaders(undefined),{});assert.deepEqual(deploymentHeaders('artifact'),{'x-prnext-deployment-id':'artifact'});
  await assertDeploymentResponse(new Response('ok',{headers:{'x-prnext-deployment-id':'artifact'}}),'artifact');
  for(const headers of [{},{'x-prnext-deployment-id':'different'}]){
    let cancelled=false;
    const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers});
    await assert.rejects(assertDeploymentResponse(response,'artifact'),{code:'PRNEXT_DEPLOYMENT_CHANGED'});
    assert.equal(cancelled,true);
  }
  await assert.rejects(assertDeploymentResponse(new Response('no',{status:409,headers:{'x-prnext-deployment-id':'artifact'}}),'artifact'),{code:'PRNEXT_DEPLOYMENT_CHANGED'});
});
test('legacy/dev bootstrap remains compatible without a deployment identity',async()=>{
  const response=new Response('ok');await assertDeploymentResponse(response);assert.equal(await response.text(),'ok');
});

test('document-only responses cannot enter either router as data, including a rewrite with a matching deployment',async()=>{
  for(const expected of [undefined,'artifact']) {
    let cancelled=false;
    const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:409,headers:{'x-prnext-deployment-id':'artifact','x-prnext-document-navigation':'1'}});
    await assert.rejects(assertDeploymentResponse(response,expected),{code:'PRNEXT_DOCUMENT_NAVIGATION'});
    assert.equal(cancelled,true);
  }
});
