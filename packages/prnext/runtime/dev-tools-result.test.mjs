import test from 'node:test';
import assert from 'node:assert/strict';
import {devToolResult} from './dev-tools-result.mjs';
test('MCP attaches the selected PNG once without duplicating base64 in text or mutating the snapshot',()=>{
  const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(80000,7)]).toString('base64');
  const snapshot={ai:{contexts:[{id:'context',context:{source:'components/Button.tsx:4:1',screenshot:{mimeType:'image/png',data:image,width:400,height:200}}}]}};
  const result=devToolResult(snapshot);assert.equal(result.content.length,2);assert.equal(result.content[1].data,image);
  assert.ok(!result.content[0].text.includes(image));assert.equal(result.structuredContent.ai.contexts[0].context.screenshot.attached,true);
  assert.equal(snapshot.ai.contexts[0].context.screenshot.data,image);
});

test('MCP selects the latest valid PNG and removes all omitted image data from text',()=>{
  const png=byte=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20,byte)]).toString('base64');
  const older=png(1),latest=png(2),invalid='not-png-unique-data',oversize='A'.repeat(350001);
  const value={ai:{contexts:[
    {context:{screenshot:{mimeType:'image/png',data:older}}},
    {context:{screenshot:{mimeType:'image/png',data:latest}}},
    {context:{screenshot:{mimeType:'image/png',data:invalid}}},
    {context:{screenshot:{mimeType:'image/png',data:oversize}}},
  ]},screenshot:'data:image/png;base64,not-a-real-png'};
  const result=devToolResult(value);assert.equal(result.content.length,2);assert.equal(result.content[1].data,latest);
  assert.equal(result.structuredContent.ai.contexts[0].context.screenshot.omitted,true);assert.equal(result.structuredContent.ai.contexts[1].context.screenshot.attached,true);
  for(const data of [older,latest,invalid,oversize,'data:image/png;base64,not-a-real-png'])assert.ok(!result.content[0].text.includes(data));
  assert.ok(result.structuredContent.ai.contexts[2].context.screenshot.reason);assert.ok(result.structuredContent.ai.contexts[3].context.screenshot.reason);
});

test('MCP normalizes nullable and primitive tool results to valid structured objects',()=>{
  for(const [input,expected] of [[undefined,null],[null,null],[3,3],['message','message'],[false,false],[[1,2],[1,2]]]){
    const result=devToolResult(input);assert.deepEqual(result.structuredContent,{value:expected});assert.equal(typeof result.content[0].text,'string');assert.deepEqual(JSON.parse(result.content[0].text),{value:expected});
  }
});
