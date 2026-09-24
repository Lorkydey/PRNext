import test from 'node:test';
import assert from 'node:assert/strict';
import {edgeActionsFixture} from './edge-actions-fixture.mjs';
import {startServer} from './support.mjs';
test('Edge Server Actions execute RPC and encrypted native forms in their Web realm',async()=>{
  const f=await edgeActionsFixture();let server;
  try{
    await f.build();server=await startServer(f.root);
    const response=await fetch(server.url);assert.equal(response.status,200);const html=await response.text();
    const id=/name="\$ACTION_ID_([^"]+)"/.exec(html)?.[1];assert.ok(id,html);
    const rpc=await fetch(server.url,{method:'POST',headers:{origin:server.url,'Next-Action':id,'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify([{value:'rpc'}])});
    assert.equal(rpc.status,200);const flight=await rpc.text();assert.match(flight,/"runtime":"edge"/);assert.match(flight,/"node":"undefined"/);assert.match(rpc.headers.get('set-cookie'),/edge-action=rpc/);
    const nodeHtml=await(await fetch(server.url+'/node')).text();
    const nodeId=/name="\$ACTION_ID_([^"]+)"/.exec(nodeHtml)?.[1];assert.equal(nodeId,id,'shared action keeps one public reference');
    for(const [route,runtime,node]of [['/node','nodejs','function'],['/','edge','undefined']]){
      const response=await fetch(server.url+route,{method:'POST',headers:{origin:server.url,'Next-Action':id,'content-type':'text/plain'},body:JSON.stringify([{value:'shared'}])});
      assert.equal(response.status,200);const body=await response.text();
      assert.match(body,new RegExp('"runtime":"'+runtime+'"'));assert.match(body,new RegExp('"node":"'+node+'"'));
    }
    const inline=/<form id="inline"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1];assert.ok(inline,html);
    const data=new FormData();
    for(const input of inline.matchAll(/<input\b[^>]*>/g)){
      const name=/name="([^"]+)"/.exec(input[0])?.[1],value=/value="([^"]*)"/.exec(input[0])?.[1]||'';
      if(name)data.append(name,value.replaceAll('&quot;','"').replaceAll('&#x27;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
    }
    const form=await fetch(server.url,{method:'POST',headers:{origin:server.url},body:data});assert.equal(form.status,200,await form.clone().text());assert.match(form.headers.get('set-cookie'),/inline-edge=encrypted-edge%3Abound/);
  }finally{await server?.close();await f.remove()}
});
