import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReplayManager} from './dev-replay-runner.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const definition=()=>({version:1,name:'Working basket',viewport:{width:390,height:844},steps:[{type:'visit',path:'/'},{type:'click',target:{kind:'role',role:'button',name:'Add'}},{type:'expectText',target:{kind:'testId',value:'count'},text:'1'}]});
function browserFixture(state,options={}){
  const context=new EventEmitter(),page=new EventEmitter();let url='about:blank',text='0';
  const locator={count:async()=>options.count??1,click:async()=>{text='1';await options.click?.({context,page});},fill:async value=>{options.fill?.(value);},innerText:async()=>text,evaluate:async()=>options.visible!==false};
  Object.assign(page,{goto:async value=>{url=value;page.emit('framenavigated',frame);return {status:()=>200};},url:()=>url,mainFrame:()=>frame,evaluate:async()=>({...state,confirmed:options.confirmed!==false,building:false,issues:options.issues||0}),getByRole:()=>locator,getByLabel:()=>locator,getByText:()=>locator,getByTestId:()=>locator,locator:()=>locator,setDefaultTimeout(){},setDefaultNavigationTimeout(){},screenshot:async()=>Buffer.from([137,80,78,71,13,10,26,10]),close:async()=>{page.closed=true;}});
  const frame={url:()=>url};
  Object.assign(context,{addInitScript:async script=>{context.initScript=script.toString();},route:async(_pattern,handler)=>{context.routeHandler=handler;},routeWebSocket:async(_pattern,handler)=>{context.socketHandler=handler;},newPage:async()=>page,close:async()=>{context.closed=true;}});
  const browser={newContext:async value=>{browser.contextOptions=value;return context;},close:async()=>{browser.closed=true;}};
  return {browser,context,page};
}
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-replay-run-')),state={state:'ready',buildId:'build-one',sequence:1,session:'session-one',typeErrors:[]},browsers=[];
  const manager=createReplayManager({root,getAppUrl:()=>options.appUrl||'http://127.0.0.1:3000',snapshot:()=>state,ensureRoute:options.ensureRoute,loadBrowser:options.loadBrowser||(async()=>{const fixture=browserFixture(state,options.browser);browsers.push(fixture);return fixture.browser;})});
  t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
  const saved=(await manager.save(options.scenario||definition())).scenario;
  async function complete(runId){const until=performance.now()+6000;while(performance.now()<until){const result=await manager.result({id:saved.id,runId});if(result.run?.state!=='running')return result;await pause(10);}throw Error('Test replay never completed.');}
  return {root,state,manager,scenario:saved,browsers,complete};
}
test('the manager executes actions and assertions in a fresh isolated browser with exact generation evidence',async t=>{
  const calls=[],{manager,scenario,browsers,complete}=await fixture(t,{ensureRoute:async pathname=>calls.push(pathname)}),started=await manager.start({id:scenario.id});
  assert.equal(started.state,'running');const {run}=await complete(started.runId);assert.equal(run.state,'verified');assert.equal(run.verified,true);assert.deepEqual(run.steps.map(step=>step.state),['passed','passed','passed']);assert.equal(run.before.buildId,'build-one');assert.equal(run.browser.sequence,1);assert.equal(run.after.session,'session-one');assert.equal(run.screenshots.before.mimeType,'image/png');assert.equal(run.screenshots.after.mimeType,'image/png');assert.deepEqual(calls,['/']);
  assert.equal(browsers[0].browser.contextOptions.serviceWorkers,'block');assert.equal(browsers[0].browser.contextOptions.acceptDownloads,false);assert.match(browsers[0].context.initScript,/__PRNEXT_REPLAY__/);assert.equal(browsers[0].context.closed,true);assert.equal(browsers[0].browser.closed,true);
  const next=await manager.start({id:scenario.id});await complete(next.runId);assert.equal(browsers.length,2);assert.notEqual(browsers[0].context,browsers[1].context);
});
test('a changed generation is inconclusive and cannot turn passed actions into verification',async t=>{
  let state;const fixtureValue=await fixture(t,{browser:{click:()=>{state.sequence=2;state.buildId='build-two';}}});state=fixtureValue.state;
  const {run}=await fixtureValue.complete((await fixtureValue.manager.start({id:fixtureValue.scenario.id})).runId);assert.equal(run.state,'inconclusive');assert.equal(run.verified,false);assert.match(run.reason,/generation changed/);assert.equal(run.before.buildId,'build-one');assert.equal(run.after.buildId,'build-two');
});
test('ambiguous targets fail explicitly without any automatic target repair',async t=>{
  let clicked=false;const {manager,scenario,complete}=await fixture(t,{browser:{count:2,click:()=>{clicked=true;}}}),{run}=await complete((await manager.start({id:scenario.id})).runId);
  assert.equal(run.state,'failed');assert.match(run.reason,/ambiguous \(2 matches\)/);assert.equal(clicked,false);
});
test('missing adapters and missing fixture values are inconclusive and never written as successful checks',async t=>{
  const {manager,scenario,complete}=await fixture(t,{loadBrowser:async()=>{throw Error('adapter not installed');}}),{run}=await complete((await manager.start({id:scenario.id})).runId);assert.equal(run.state,'inconclusive');assert.equal(run.verified,false);
  const value=definition();value.steps.splice(1,0,{type:'fill',target:{kind:'label',value:'Email'},parameter:'email'});const withFill=await fixture(t,{scenario:value}),missing=await withFill.complete((await withFill.manager.start({id:withFill.scenario.id})).runId);assert.equal(missing.run.state,'inconclusive');assert.match(missing.run.reason,/fixture parameter email/);assert.equal(withFill.browsers.length,0);
});
test('run parameters do not enter definitions, results, exports or browser error messages',async t=>{
  const secret='private-fixture-682993';let received;const value=definition();value.steps.splice(1,0,{type:'fill',target:{kind:'label',value:'Password'},parameter:'password'});
  const {root,manager,scenario,complete}=await fixture(t,{scenario:value,browser:{fill:value=>{received=value;},click:({page})=>page.emit('console',{type:()=> 'error',text:()=>secret})}}),result=await complete((await manager.start({id:scenario.id,parameters:{password:secret}})).runId);
  assert.equal(received,secret);assert.equal(result.run.state,'failed');assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));assert.doesNotMatch((await manager.export(scenario.id)).code,new RegExp(secret));
  for(const folder of ['scenarios','results'])for(const name of await readdir(path.join(root,'.prnext-replays',folder)))assert.doesNotMatch(await readFile(path.join(root,'.prnext-replays',folder,name),'utf8'),new RegExp(secret));
});
test('origin restrictions cover HTTP and WebSockets and a blocked operation fails the replay',async t=>{
  let continued=false,aborted=false,connected=false,socketClosed=false;
  const {manager,scenario,complete}=await fixture(t,{browser:{click:async({context})=>{
    await context.routeHandler({request:()=>({url:()=> 'http://127.0.0.1:9999/v1/tools/dev_snapshot'}),continue:()=>{continued=true;},abort:()=>{aborted=true;}});
    context.socketHandler({url:()=> 'ws://outside.example/socket',connectToServer:()=>{connected=true;},close:()=>{socketClosed=true;}});
  }}}),{run}=await complete((await manager.start({id:scenario.id})).runId);
  assert.equal(run.state,'failed');assert.equal(continued,false);assert.equal(aborted,true);assert.equal(connected,false);assert.equal(socketClosed,true);assert.equal(run.errors.length,2);
});
test('closing cancels a pending adapter, releases the lock and safely closes a late browser',async t=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const {manager,scenario,root}=await fixture(t,{loadBrowser:()=>pending});await manager.start({id:scenario.id});await assert.rejects(manager.start({id:scenario.id}),/already running/);const before=performance.now();await manager.close();assert.ok(performance.now()-before<1500);
  const files=await readdir(path.join(root,'.prnext-replays','results')),saved=JSON.parse(await readFile(path.join(root,'.prnext-replays','results',files[0]),'utf8'));assert.equal(saved.state,'inconclusive');assert.match(saved.reason,/session closed/);
  const late={closed:false,close:async()=>{late.closed=true;}};resolve(late);await pause(20);assert.equal(late.closed,true);await manager.close();
});
test('previous results retain their immutable definition hash when expectations are edited',async t=>{
  const {manager,scenario,complete}=await fixture(t),first=await complete((await manager.start({id:scenario.id})).runId);scenario.name='Changed intention';await manager.save(scenario);
  const historic=await manager.result({id:scenario.id,runId:first.run.runId});assert.equal(historic.scenarioChanged,true);const second=await complete((await manager.start({id:scenario.id})).runId);assert.equal(second.comparisonChanged,true);assert.equal(second.previous.runId,first.run.runId);assert.notEqual(second.previous.scenarioHash,second.run.scenarioHash);assert.equal(second.previous.screenshots,undefined);
});
test('remote application URLs cannot launch a browser',async t=>{
  const {manager,scenario,complete,browsers}=await fixture(t,{appUrl:'https://outside.example'}),{run}=await complete((await manager.start({id:scenario.id})).runId);assert.equal(run.state,'inconclusive');assert.equal(browsers.length,0);assert.match(run.reason,/loopback/);
});
test('a ready compiler without exact browser confirmation is inconclusive',async t=>{
  const {manager,scenario,complete}=await fixture(t,{browser:{confirmed:false}}),{run}=await complete((await manager.start({id:scenario.id})).runId);
  assert.equal(run.state,'inconclusive');assert.equal(run.verified,false);assert.match(run.reason,/exact current build and session/);assert.equal(run.steps[0].state,'failed');assert.equal(run.steps[1].state,'pending');
});
test('a generation with TypeScript diagnostics fails before opening a browser',async t=>{
  const {manager,scenario,complete,state,browsers}=await fixture(t);state.typeErrors=['Type error'];const {run}=await complete((await manager.start({id:scenario.id})).runId);
  assert.equal(run.state,'failed');assert.equal(run.verified,false);assert.match(run.reason,/TypeScript errors/);assert.equal(browsers.length,0);
});
