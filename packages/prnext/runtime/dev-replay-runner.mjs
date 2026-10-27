import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createReplayStore} from './dev-replay-store.mjs';
import {validateReplay,replayId,replayParameters,exportReplay,replayLimits,replayOnScreen} from './dev-replay-model.mjs';

const setupInstructions='Install the optional browser adapter in this application: npm i -D @playwright/test, then npx playwright install chromium.';
class ReplayProblem extends Error {constructor(state,message){super(message);this.state=state;}}
const problem=(state,message)=>new ReplayProblem(state,message);
const summary=run=>run&&Object.fromEntries(['runId','id','scenarioHash','state','verified','reason','startedAt','finishedAt','durationMs','before','after'].filter(key=>run[key]!==undefined).map(key=>[key,run[key]]));
const scenarioHash=scenario=>createHash('sha256').update(JSON.stringify(validateReplay(scenario))).digest('hex');
const generation=state=>({buildId:typeof state?.buildId==='string'?state.buildId.slice(0,128):null,sequence:Number.isSafeInteger(state?.sequence)?state.sequence:0,session:typeof state?.session==='string'?state.session.slice(0,128):null});
const equalGeneration=(a,b)=>a.buildId===b.buildId&&a.sequence===b.sequence&&a.session===b.session;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function localAppUrl(value){
  let url;try{url=new URL(value);}catch{throw problem('inconclusive','The local application URL is unavailable. Start PRNext dev first.');}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw problem('inconclusive','Replay requires the current loopback application origin.');
  return url;
}
async function defaultBrowser({root}){
  const require=createRequire(path.join(root,'package.json'));let chromium;
  for(const name of ['@playwright/test','playwright']){
    try{chromium=require(name).chromium;if(chromium)break;}catch(error){if(error.code!=='MODULE_NOT_FOUND'&&error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw problem('inconclusive','The optional Playwright adapter could not be loaded. '+setupInstructions);}
  }
  if(!chromium)throw problem('inconclusive',setupInstructions);
  try{return await chromium.launch({headless:true});}catch{throw problem('inconclusive','Chromium could not start. '+setupInstructions);}
}
function locatorFor(page,target){
  if(target.kind==='role')return page.getByRole(target.role,{name:target.name,exact:true});
  if(target.kind==='label')return page.getByLabel(target.value,{exact:true});
  if(target.kind==='testId')return page.getByTestId(target.value);
  if(target.kind==='text')return page.getByText(target.value,{exact:true});
  return page.locator(target.value);
}
const browserGeneration=()=>{
  const state=globalThis.__PRNEXT_DEV__;
  if(!state)return null;
  return {buildId:state.buildId,sequence:state.sequence||0,session:state.session,confirmed:state.confirmed===true,building:state.devBuildState==='building'||state.applying===true,issues:(state.typeErrors?.length||0)+(state.issue?1:0)+(state.recoverableIssue?1:0)+(state.bootstrapFailed?1:0)};
};
function parametersFor(scenario,value){
  if(value===null||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw problem('inconclusive','Provide fixture parameters as an object.');
  const expected=replayParameters(scenario),provided=Object.keys(value),result={};
  if(provided.some(key=>!expected.includes(key)))throw problem('inconclusive','Only this scenario\'s named fixture parameters are accepted.');
  let size=0;
  for(const name of expected){
    if(!Object.hasOwn(value,name)||typeof value[name]!=='string')throw problem('inconclusive','Supply the fixture parameter '+name+' for this run. Its value is never saved.');
    if(value[name].length>4096||(size+=value[name].length)>16384)throw problem('inconclusive','Fixture parameters exceed the local run size limit.');
    result[name]=value[name];
  }
  return result;
}

/** Local-only, isolated functional checks. There is no agent or automatic repair here. */
export function createReplayManager({root,getAppUrl=()=>null,snapshot=()=>({}),ensureRoute,now=Date.now,loadBrowser=defaultBrowser}={}){
  const storePromise=createReplayStore({root});storePromise.catch(()=>{});
  let active=null,starting=false,closed=false;
  const open=()=>{if(closed)throw Error('Replay manager is closed.');};
  const publicActive=record=>({...record.run,state:'running',verified:false,reason:record.run.state==='running'?record.run.reason:'Saving local replay evidence.'});
  function previousResult(run){return run?{...summary(run),steps:run.steps,errors:run.errors,screenshotOmitted:!!run.screenshots}:undefined;}
  async function execute(record,scenario,input){
    const run=record.run,start=performance.now();let browser,context,page,timer,fixtures={};
    // Reserve a short part of the public 30 second budget for browser teardown.
    const executionMs=replayLimits.timeoutMs-1000,deadline=start+executionMs,errors=run.errors;
    const remaining=()=>Math.max(1,Math.floor(deadline-performance.now()));
    const assertActive=()=>{if(record.cancelled||closed)throw problem('inconclusive','The development session closed before replay completed.');if(performance.now()>=deadline)throw problem('inconclusive','Replay reached its 30 second time limit.');};
    const addError=message=>{if(errors.length<20&&!errors.includes(message))errors.push(message);};
    async function dispose(){
      // Teardown is attempted even if the browser's transport is already gone.
      await Promise.race([Promise.resolve().then(()=>context?.close()).catch(()=>{}),wait(300)]);
      await Promise.race([Promise.resolve().then(()=>browser?.close()).catch(()=>{}),wait(300)]);
    }
    let cancelReject;
    const cancelled=new Promise((_resolve,reject)=>{cancelReject=reject;});
    record.cancel=()=>{record.cancelled=true;cancelReject(problem('inconclusive','The development session closed before replay completed.'));void dispose();};
    async function resource(promise){
      const value=await promise;
      if(record.cancelled||closed){await Promise.race([Promise.resolve().then(()=>value?.close()).catch(()=>{}),wait(300)]);assertActive();}
      return value;
    }
    function checkServer(expected){
      assertActive();const state=snapshot();
      if(state.state==='error'||state.typeErrors?.length)throw problem('failed','The current development generation has compilation or TypeScript errors.');
      if(state.state!=='ready')throw problem('inconclusive','The development generation is not ready. Wait for the build and replay again.');
      const current=generation(state);
      if(!current.buildId||!current.session||!Number.isSafeInteger(state.sequence))throw problem('inconclusive','The current development generation is unavailable.');
      if(expected&&!equalGeneration(current,expected))throw problem('inconclusive','The development generation changed during replay. Replay the finished build again.');
      return current;
    }
    async function confirm(expected){
      const until=Math.min(deadline,performance.now()+5000);
      while(performance.now()<until){
        checkServer(expected);const observed=await page.evaluate(browserGeneration);assertActive();
        if(observed?.issues)throw problem('failed','The replay browser reports a current runtime, hydration or TypeScript issue.');
        if(observed&&!observed.building&&observed.confirmed&&equalGeneration(generation(observed),expected))return generation(observed);
        await wait(40);
      }
      throw problem('inconclusive','The replay browser did not confirm the exact current build and session.');
    }
    async function screenshot(){
      try{
        assertActive();
        const mask=[page.locator('input, textarea, [contenteditable], [data-prnext-private]')];
        for(const value of Object.values(fixtures))if(value)mask.push(page.getByText(value,{exact:false}));
        const width=Math.min(scenario.viewport.width,720),height=Math.min(scenario.viewport.height,540);
        const png=await page.screenshot({type:'png',scale:'css',animations:'disabled',timeout:Math.min(1500,remaining()),clip:{x:0,y:0,width,height},mask,style:'#__prnext_dev_tools__, #__prnext_dev_error__ { visibility: hidden !important; }'});
        if(png.length>replayLimits.maxScreenshotBytes||!Buffer.from(png).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {omitted:true,reason:'Screenshot exceeded the local evidence size limit.'};
        return {mimeType:'image/png',data:Buffer.from(png).toString('base64'),width,height,cropped:width<scenario.viewport.width||height<scenario.viewport.height};
      }catch{return {omitted:true,reason:'Screenshot was unavailable.'};}
    }
    async function task(){
      fixtures=parametersFor(scenario,input);input=null;assertActive();const app=localAppUrl(getAppUrl());
      // Compile every explicit destination before selecting a stable baseline.
      if(ensureRoute)for(const pathname of new Set(scenario.steps.filter(step=>step.type==='visit'||step.type==='expectURL').map(step=>step.path))){assertActive();await ensureRoute(pathname);}
      assertActive();run.before=checkServer();browser=await resource(loadBrowser({root}));assertActive();
      if(!browser?.newContext)throw problem('inconclusive','The browser adapter does not provide an isolated context. '+setupInstructions);
      context=await resource(browser.newContext({viewport:scenario.viewport,serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false}));assertActive();
      record.context=context;
      await context.addInitScript(()=>{globalThis.__PRNEXT_REPLAY__=true;});
      await context.route('**/*',route=>{
        try{const url=new URL(route.request().url());if(url.origin===app.origin&&['http:','https:'].includes(url.protocol))return route.continue();}catch{}
        addError('Replay blocked a request outside the application origin.');return route.abort('blockedbyclient');
      });
      if(typeof context.routeWebSocket!=='function')throw problem('inconclusive','Update the optional Playwright adapter to support isolated WebSocket routing.');
      await context.routeWebSocket('**/*',socket=>{
        try{const url=new URL(socket.url());url.protocol=url.protocol==='wss:'?'https:':'http:';if(url.origin===app.origin)return socket.connectToServer();}catch{}
        addError('Replay blocked a WebSocket outside the application origin.');socket.close();
      });
      page=await resource(context.newPage());assertActive();
      context.on('page',popup=>{if(popup!==page){addError('Replay blocked an unexpected popup.');void popup.close().catch(()=>{});}});
      page.on('pageerror',()=>addError('The replay browser reported an uncaught runtime error.'));
      page.on('console',message=>{if(message.type()==='error')addError('The replay browser reported a console error.');});
      page.on('download',download=>{addError('Replay blocked an unexpected download.');void download.cancel().catch(()=>{});});
      page.on('framenavigated',frame=>{
        try{const url=new URL(frame.url());if(url.origin===app.origin&&['http:','https:'].includes(url.protocol))return;}catch{}
        addError('Replay navigated outside the application origin.');void page.close().catch(()=>{});
      });
      page.setDefaultTimeout(Math.min(3000,remaining()));page.setDefaultNavigationTimeout(Math.min(5000,remaining()));
      for(let index=0;index<scenario.steps.length;index++){
        assertActive();checkServer(run.before);const step=scenario.steps[index],entry=run.steps[index],stepStarted=performance.now();
        try{
          if(step.type==='visit'){
            const current=new URL(page.url());
            const response=index===0||current.origin!==app.origin||current.pathname!==step.path?await page.goto(new URL(step.path,app.origin).href,{waitUntil:'domcontentloaded',timeout:Math.min(5000,remaining())}):null;
            if(response&&response.status()>=400)throw problem('failed','The application page returned an HTTP error.');
            const confirmed=await confirm(run.before);if(!run.browserBefore)run.browserBefore=confirmed;if(!run.screenshots.before)run.screenshots.before=await screenshot();
          }else if(step.type==='expectURL'){
            const until=Math.min(deadline,performance.now()+3000);let matches=false;
            do{assertActive();const url=new URL(page.url());matches=url.origin===app.origin&&url.pathname===step.path;if(matches)break;await wait(40);}while(performance.now()<until);
            if(!matches)throw problem('failed','The expected application pathname was not reached.');
          }else{
            await confirm(run.before);const locator=locatorFor(page,step.target),untilTarget=Math.min(deadline,performance.now()+3000);let count=await locator.count();
            while(!count&&performance.now()<untilTarget){assertActive();await wait(40);count=await locator.count();}
            if(count!==1)throw problem('failed',count>1?'The target is ambiguous ('+count+' matches). Use a unique target.':'The target was not found.');
            if(step.type==='click')await locator.click({timeout:Math.min(3000,remaining())});
            if(step.type==='fill')await locator.fill(fixtures[step.parameter],{timeout:Math.min(3000,remaining())});
            if(step.type==='expectVisible'){
              const until=Math.min(deadline,performance.now()+3000);let visible=false;
              do{assertActive();visible=await locator.evaluate(replayOnScreen,{},{timeout:Math.min(1000,remaining())});if(visible)break;await wait(40);}while(performance.now()<until);
              if(!visible)throw problem('failed','The target is not fully visible and unobstructed in the current viewport.');
            }
            if(step.type==='expectText'){
              const expected=step.text.replace(/\s+/g,' ').trim(),until=Math.min(deadline,performance.now()+3000);let matches=false;
              do{assertActive();matches=(await locator.innerText({timeout:Math.min(1000,remaining())})).replace(/\s+/g,' ').trim()===expected;if(matches)break;await wait(40);}while(performance.now()<until);
              if(!matches)throw problem('failed','The target text did not match the expectation.');
            }
          }
          entry.state='passed';entry.durationMs=Math.round(performance.now()-stepStarted);
        }catch(error){entry.state='failed';entry.durationMs=Math.round(performance.now()-stepStarted);entry.reason=error instanceof ReplayProblem?error.message:'The target was unavailable or its action/expectation failed.';throw error instanceof ReplayProblem?error:problem('failed',entry.reason);}
      }
      run.after=checkServer(run.before);run.browserAfter=run.browser=await confirm(run.before);run.screenshots.after=await screenshot();
      // Let already scheduled effects and hydration diagnostics reach the browser.
      await wait(Math.min(150,remaining()));run.after=checkServer(run.before);run.browserAfter=run.browser=await confirm(run.before);
      if(errors.length)throw problem('failed','The replay browser reported errors or a blocked operation.');
      run.state='verified';run.verified=true;run.reason='Every expectation passed in an isolated browser on the exact recorded development generation.';
    }
    try{
      const timeout=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{record.cancelled=true;void dispose();reject(problem('inconclusive','Replay reached its 30 second time limit.'));},executionMs);});
      await Promise.race([task(),timeout,cancelled]);
    }catch(error){
      run.state=record.cancelled?'inconclusive':error instanceof ReplayProblem?error.state:'inconclusive';run.verified=false;
      run.reason=record.cancelled?(closed?'The development session closed before replay completed.':'Replay reached its 30 second time limit.'):error instanceof ReplayProblem?error.message:'The browser replay could not complete. Check the optional adapter and local application.';
      if(errors.length&&run.state!=='inconclusive')run.state='failed';
      run.after=generation(snapshot());
      if(run.before&&!equalGeneration(run.before,run.after)&&!record.cancelled){run.state='inconclusive';run.reason='The development generation changed during replay. Replay the finished build again.';}
      if(page&&!record.cancelled&&!closed)try{const observed=await Promise.race([page.evaluate(browserGeneration),wait(250).then(()=>null)]);if(observed)run.browserAfter=generation(observed);}catch{}
      if(page&&!record.cancelled&&!closed)run.screenshots.after=await screenshot();
    }finally{
      clearTimeout(timer);input=null;for(const key of Object.keys(fixtures))fixtures[key]='';fixtures={};
      await dispose();run.finishedAt=now();run.durationMs=Math.round(performance.now()-start);
      try{await (await storePromise).saveResult(run);}catch{run.state='inconclusive';run.verified=false;run.reason='Replay evidence could not be saved safely. Check the local replay storage.';}
      if(active===record)active=null;
    }
    return run;
  }
  return {
    async list(){open();const store=await storePromise,scenarios=await store.list(),items=[];
      for(const scenario of scenarios){const runs=await store.results(scenario.id);items.push({...scenario,latest:active?.run.id===scenario.id?summary(publicActive(active)):summary(runs[0])});}
      return {scenarios:items};
    },
    async get(id){open();return (await storePromise).get(replayId(id));},
    async save(value){open();const scenario=validateReplay(value);if(starting||(active&&active.run.id===scenario.id))throw Error('Wait for this scenario\'s replay to finish before editing it.');return {scenario:await (await storePromise).save(scenario)};},
    async start({id,parameters={}}={}){
      open();id=replayId(id);if(active||starting)throw Object.assign(Error('A replay is already running in this project.'),{code:'replay_busy',status:409});starting=true;
      try{
        const scenario=await (await storePromise).get(id);open();
        const run={runId:randomUUID(),id:scenario.id,scenarioHash:scenarioHash(scenario),state:'running',verified:false,reason:'Replaying the recorded scenario.',startedAt:now(),steps:scenario.steps.map((step,index)=>({index,type:step.type,state:'pending'})),errors:[],screenshots:{}};
        const record={run,cancelled:false};active=record;record.task=execute(record,scenario,parameters);record.task.catch(()=>{});
        return {runId:run.runId,id:scenario.id,state:'running'};
      }finally{starting=false;}
    },
    async result({id,runId}={}){
      open();id=replayId(id);if(runId)runId=replayId(runId);const store=await storePromise,scenario=await store.get(id),runs=await store.results(id);
      let run=active?.run.id===id&&(!runId||active.run.runId===runId)?publicActive(active):runId?runs.find(item=>item.runId===runId):runs[0];
      if(runId&&!run)throw Error('Unknown replay run.');
      if(run)run=JSON.parse(JSON.stringify(run));
      const previous=runs.find(item=>item.runId!==run?.runId&&(run?.startedAt===undefined||item.startedAt<=run.startedAt));
      return {id,scenario,run,previous:previousResult(previous),scenarioChanged:!!run&&run.scenarioHash!==scenarioHash(scenario),comparisonChanged:!!run&&!!previous&&run.scenarioHash!==previous.scenarioHash};
    },
    async export(id){open();const scenario=await (await storePromise).get(replayId(id));return {filename:'prnext-replay-'+scenario.id+'.spec.mjs',code:exportReplay(scenario)};},
    async remove(id){open();id=replayId(id);if(starting||active?.run.id===id)throw Error('Wait for this scenario\'s replay to finish before deleting it.');return (await storePromise).remove(id);},
    async close(){if(closed)return;closed=true;const running=active;running?.cancel?.();if(running?.task)await Promise.race([running.task,wait(1000)]);},
  };
}
