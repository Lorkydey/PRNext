import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { executeReplay, parseReplayArgs } from './dev-replay-cli.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';

test('replay CLI parses one project and explicit operation without accepting arbitrary commands', () => {
  const cwd = path.resolve('project');
  assert.equal(parseReplayArgs([], cwd).action, 'list');
  assert.deepEqual(parseReplayArgs(['other folder', '--run', id, '--parameters', 'test.json', '--json'], cwd), { directory: path.join(cwd,'other folder'), action:'run', id, runId:undefined, parameters:path.join(cwd,'test.json'), json:true });
  for (const args of [['--run'],['--run',id,'--list'],['--run',id,'--run',id],['--result','../.env'],['--export',id,'--out','private'],['one','two'],['--parameters','test.json'],['--run-id',runId],['--json','--json'],['--result',id,'--parameters','test.json']]) assert.throws(() => parseReplayArgs(args,cwd));
});

test('replay help and invalid JSON arguments never contact a development server', async () => {
  let calls = 0;
  const call = () => { calls++; throw Error('must not call'); };
  assert.match((await executeReplay(['--help'],{call})).output,/optional project dependency/);
  const result = await executeReplay(['--run','bad','--json'],{call});
  assert.equal(result.exitCode,2); assert.equal(JSON.parse(result.output).ok,false); assert.equal(calls,0);
});

test('CLI list/export read the selected project and identify themselves as a human CLI', async () => {
  const calls=[];
  const call = async (directory,name,args,meta) => { calls.push({directory,name,args,meta}); return name==='dev_replay_list'?{scenarios:[{id,name:'Cart',latest:{state:'failed'}}]}:{filename:'cart.spec.mjs',code:'// ordinary test\n'}; };
  const listed = await executeReplay(['--list'],{call});
  assert.match(listed.output,/Cart.*failed/);
  const exported = await executeReplay(['--export',id],{call});
  assert.equal(exported.output,'// ordinary test\n'); assert.equal(exported.exitCode,0);
  assert.equal(calls[0].meta.client,'PRNext replay CLI');
  assert.deepEqual(calls[1].args,{id});
});

test('CLI run supplies explicit fixture strings, starts once and polls the returned run', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-replay-cli-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'fixtures.json'),JSON.stringify({field1:'private test fixture'}));
  const calls=[]; let polls=0;
  const call=async(directory,name,args)=>{
    calls.push({name,args});
    if(name==='dev_replay_run')return {id,runId,state:'running'};
    return {id,scenario:{name:'Cart'},run:{runId,id,state:++polls===1?'running':'verified',verified:polls>1,steps:[],after:{buildId:'observed',sequence:2}}};
  };
  const result=await executeReplay(['--run',id,'--parameters','fixtures.json','--json'],{cwd:root,call,sleep:async()=>{}});
  assert.equal(result.exitCode,0); assert.equal(JSON.parse(result.output).run.state,'verified');
  assert.deepEqual(calls[0].args,{id,parameters:{field1:'private test fixture'}});
  assert.equal(calls.filter(item=>item.name==='dev_replay_run').length,1);
  assert.deepEqual(calls[1].args,{id,runId});
  assert.doesNotMatch(result.output,/private test fixture/);
});

test('CLI statuses never infer successful behavior from missing evidence or failed assertions',async()=>{
  for(const [state,verified,code] of [['verified',true,0],['verified',false,2],['failed',false,1],['inconclusive',false,2],['cancelled',false,130],['running',false,0],[undefined,false,2],['unknown',false,2]]){
    const result=await executeReplay(['--result',id,'--run-id',runId,'--json'],{call:async()=>({run:{runId,state,verified}})});
    assert.equal(result.exitCode,code,state);
  }
  const missing=await executeReplay(['--list','--json'],{call:async()=>{throw Error('Start prnext dev in this project.');}});
  assert.equal(missing.exitCode,2);assert.match(JSON.parse(missing.output).error,/Start prnext dev/);
  const malformed=await executeReplay(['--run',id,'--json'],{call:async(directory,name)=>name==='dev_replay_run'?{id,runId,state:'running'}:{run:{runId,id,verified:false}}});
  assert.equal(malformed.exitCode,2);
});

test('CLI wait timeout is inconclusive, never retries the application interactions',async()=>{
  let clock=0,starts=0;
  const result=await executeReplay(['--run',id,'--json'],{waitMs:100,now:()=>clock,sleep:async()=>{clock+=60;},call:async(directory,name)=>{
    if(name==='dev_replay_run'){starts++;return {id,runId,state:'running'};}
    return {run:{id,runId,state:'running',verified:false}};
  }});
  assert.equal(starts,1);assert.equal(result.exitCode,2);assert.equal(JSON.parse(result.output).run.state,'inconclusive');
});

test('CLI rejects unexpected parameter file shapes before starting the application',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-replay-parameters-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const value of [['array'],{field1:123},{field1:'x'.repeat(4097)}]){
    await writeFile(path.join(root,'fixtures.json'),JSON.stringify(value));
    let calls=0;
    const result=await executeReplay(['--run',id,'--parameters','fixtures.json','--json'],{cwd:root,call:async()=>{calls++;}});
    assert.equal(result.exitCode,2);assert.equal(calls,0);assert.equal(JSON.parse(result.output).ok,false);
  }
  const privateContent='PRIVATE_FIXTURE_SECRET_INVALID_JSON';
  await writeFile(path.join(root,'fixtures.json'),privateContent);
  for(const format of [[],['--json']]){
    const result=await executeReplay(['--run',id,'--parameters','fixtures.json',...format],{cwd:root,call:async()=>assert.fail('must not run')});
    assert.equal(result.exitCode,2);assert.match(result.output,/valid JSON/);assert.doesNotMatch(result.output,/PRIVATE|FIXTURE|SECRET/);
  }
});
