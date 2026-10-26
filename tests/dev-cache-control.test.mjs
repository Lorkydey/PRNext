import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {devFixture} from './dev-fixture.mjs';
import {callLocalDevTool} from '../packages/prnext/runtime/dev-tools-mcp.mjs';

test('local tools expire only one native dev route cache without replacing its generation', {timeout:90000},async t=>{
  const counts={a:0,b:0};const origin=createServer((req,res)=>{const key=req.url.includes('/a')?'a':'b';counts[key]++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({key,count:counts[key]}));});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));t.after(async()=>{origin.closeAllConnections();await new Promise(resolve=>origin.close(resolve));});
  const base='http://127.0.0.1:'+origin.address().port;
  const fixture=await devFixture({files:{
    'app/api/a/route.js':`export async function GET(){console.log('server-info-marker');console.warn('server-warn-marker');return Response.json(await(await fetch(${JSON.stringify(base+'/a')},{cache:'force-cache'})).json());}`,
    'app/api/b/route.js':`export async function GET(){return Response.json(await(await fetch(${JSON.stringify(base+'/b')},{cache:'force-cache'})).json());}`,
  }});t.after(()=>fixture.close());
  async function get(route){const response=await fetch(fixture.url+'/docs/api/'+route);assert.equal(response.status,200,fixture.output());return response.json();}
  await get('a');await get('b');assert.equal((await get('a')).count,1);assert.equal((await get('b')).count,1);
  const before=await callLocalDevTool(fixture.root,'dev_snapshot');
  const result=await callLocalDevTool(fixture.root,'dev_cache_invalidate',{path:'/docs/api/a'});assert.equal(result.invalidated,true);assert.equal(result.scope,'native-route-cache');assert.equal(result.sequence,before.sequence);assert.equal(result.buildId,before.buildId);
  assert.equal((await get('a')).count,2);assert.equal((await get('b')).count,1);assert.deepEqual(counts,{a:2,b:1});
  const after=await callLocalDevTool(fixture.root,'dev_snapshot');assert.equal(after.sequence,before.sequence);assert.equal(after.buildId,before.buildId);
  const logs=await callLocalDevTool(fixture.root,'dev_logs');assert.ok(!JSON.stringify(logs).includes('PRNEXT_CACHE_TOKEN'));
  assert.ok(logs.logs.some(log=>log.text==='server-info-marker'&&log.level==='info'));assert.ok(logs.logs.some(log=>log.text==='server-warn-marker'&&log.level==='warn'));
  assert.ok(!fixture.output().includes('PRNEXT_DEV_LOG:'));assert.ok(logs.logs.some(log=>log.text==='server-info-marker'&&log.route==='/api/a'&&log.requestId));
});
