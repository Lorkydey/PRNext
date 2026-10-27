import {constants} from 'node:fs';
import {lstat,realpath,mkdir,open,rename,unlink,opendir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {validateReplay,replayId,replayLimits} from './dev-replay-model.mjs';

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const missing=error=>error?.code==='ENOENT';
function resultObject(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid replay result fields.');
}
function resultText(value,max){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('Invalid replay result text.');}
function resultGeneration(value){
  resultObject(value,['buildId','sequence','session']);
  if(!Number.isSafeInteger(value.sequence)||value.sequence<0)throw Error('Invalid replay generation.');
  for(const key of ['buildId','session'])if(value[key]!==null)resultText(value[key],128);
}
function validateResult(value){
  resultObject(value,['runId','id','scenarioHash','state','verified','reason','startedAt','finishedAt','durationMs','before','after','browser','browserBefore','browserAfter','steps','errors','screenshots']);
  replayId(value.id);replayId(value.runId);
  if(!['verified','failed','inconclusive'].includes(value.state)||value.verified!==(value.state==='verified')||!Number.isSafeInteger(value.startedAt)||value.startedAt<0||!Number.isSafeInteger(value.finishedAt)||value.finishedAt<0)throw Error('Invalid replay result.');
  if(value.scenarioHash!==undefined&&!/^[a-f0-9]{64}$/.test(value.scenarioHash))throw Error('Invalid replay definition hash.');
  if(value.reason!==undefined)resultText(value.reason,500);
  if(value.durationMs!==undefined&&(!Number.isSafeInteger(value.durationMs)||value.durationMs<0||value.durationMs>60000))throw Error('Invalid replay result duration.');
  for(const key of ['before','after','browser','browserBefore','browserAfter'])if(value[key]!==undefined)resultGeneration(value[key]);
  if(!Array.isArray(value.steps)||value.steps.length>replayLimits.maxSteps||!Array.isArray(value.errors)||value.errors.length>20)throw Error('Invalid replay result entries.');
  for(const entry of value.steps){
    resultObject(entry,['index','type','state','durationMs','reason']);
    if(!Number.isSafeInteger(entry.index)||entry.index<0||entry.index>=replayLimits.maxSteps||!['visit','click','fill','expectVisible','expectText','expectURL'].includes(entry.type)||!['pending','passed','failed'].includes(entry.state))throw Error('Invalid replay step result.');
    if(entry.durationMs!==undefined&&(!Number.isSafeInteger(entry.durationMs)||entry.durationMs<0||entry.durationMs>60000))throw Error('Invalid replay step duration.');
    if(entry.reason!==undefined)resultText(entry.reason,500);
  }
  for(const error of value.errors)resultText(error,500);
  if(value.state==='verified'){
    const before=value.before;
    if(!before?.buildId||!before.session||!value.scenarioHash||!value.steps.length||value.errors.length||value.steps.some(step=>step.state!=='passed')||!value.steps.some(step=>step.type.startsWith('expect')))throw Error('Verified replay evidence is incomplete.');
    for(const key of ['after','browserBefore','browserAfter']){
      const observed=value[key];if(!observed||observed.buildId!==before.buildId||observed.sequence!==before.sequence||observed.session!==before.session)throw Error('Verified replay generation evidence is inconsistent.');
    }
  }
  if(value.screenshots!==undefined){
    resultObject(value.screenshots,['before','after']);
    for(const screenshot of Object.values(value.screenshots)){
      if(screenshot?.omitted===true){resultObject(screenshot,['omitted','reason']);resultText(screenshot.reason,200);continue;}
      resultObject(screenshot,['mimeType','data','width','height','cropped']);
      if(screenshot.mimeType!=='image/png'||typeof screenshot.data!=='string'||screenshot.data.length>Math.ceil(replayLimits.maxScreenshotBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(screenshot.data))throw Error('Invalid replay screenshot.');
      const buffer=Buffer.from(screenshot.data,'base64');if(buffer.length>replayLimits.maxScreenshotBytes||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid replay PNG.');
      if(!Number.isSafeInteger(screenshot.width)||screenshot.width<1||screenshot.width>2560||!Number.isSafeInteger(screenshot.height)||screenshot.height<1||screenshot.height>2560||typeof screenshot.cropped!=='boolean')throw Error('Invalid replay screenshot dimensions.');
    }
  }
  return value;
}
async function inspectDirectory(directory){
  const absolute=path.resolve(directory),parsed=path.parse(absolute);
  let cursor=parsed.root;
  for(const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,component);const info=await lstat(cursor);
    if(info.isSymbolicLink()||!info.isDirectory())throw Error('Replay storage must not use linked directories.');
  }
  if(!samePath(await realpath(absolute),absolute))throw Error('Replay storage resolved outside its directory.');
}
export async function createReplayStore({root}={}){
  if(typeof root!=='string')throw Error('Replay storage requires a project root.');
  root=path.resolve(root);await inspectDirectory(root);
  const directory=path.join(root,'.prnext-replays'),scenarios=path.join(directory,'scenarios'),results=path.join(directory,'results');
  let queue=Promise.resolve();
  const exclusive=operation=>{const task=queue.then(operation);queue=task.catch(()=>{});return task;};
  async function prepare(){
    await inspectDirectory(root);
    for(const folder of [directory,scenarios,results]){
      try{await mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      await inspectDirectory(folder);
    }
  }
  async function fileInfo(file,limit){
    await inspectDirectory(path.dirname(file));
    const info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()||info.nlink!==1)throw Error('Replay storage must not use linked files.');
    if(info.size>limit)throw Error('Replay file exceeds its size limit.');
    if(!samePath(await realpath(file),file))throw Error('Replay file resolved outside storage.');
    return info;
  }
  async function read(file,limit){
    await fileInfo(file,limit);
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size>limit)throw Error('Unsafe replay file.');
      const buffer=Buffer.alloc(limit+1);let length=0;
      while(length<=limit){const result=await handle.read(buffer,length,buffer.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
      if(length>limit)throw Error('Replay file exceeds its size limit.');
      return JSON.parse(buffer.toString('utf8',0,length));
    }finally{await handle.close();}
  }
  async function write(file,value,limit){
    const content=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(content)>limit)throw Error('Replay file exceeds its size limit.');
    await inspectDirectory(path.dirname(file));
    try{await fileInfo(file,limit);}catch(error){if(!missing(error))throw error;}
    const temporary=path.join(path.dirname(file),'.tmp-'+randomUUID());
    const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
    try{
      await handle.writeFile(content);await handle.sync();await handle.close();
      await inspectDirectory(path.dirname(file));
      try{await fileInfo(file,limit);}catch(error){if(!missing(error))throw error;}
      await rename(temporary,file);
    }catch(error){await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
  }
  async function names(folder,kind){
    await inspectDirectory(folder);const found=[];let count=0;
    for await(const entry of await opendir(folder)){
      if(++count>1000)throw Error('Replay storage has too many entries.');
      const valid=kind==='scenario'?/^[0-9a-f-]{36}\.json$/.test(entry.name):/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/.test(entry.name);
      if(valid)found.push(entry.name);
    }
    return found.sort();
  }
  const scenarioFile=id=>path.join(scenarios,replayId(id)+'.json');
  const resultFile=(id,runId)=>path.join(results,replayId(id)+'.'+replayId(runId)+'.json');
  async function listUnlocked(){
    await prepare();const found=await names(scenarios,'scenario');
    if(found.length>replayLimits.maxScenarios)throw Error('Replay scenario limit exceeded.');
    const values=[];
    for(const name of found){const value=validateReplay(await read(path.join(scenarios,name),replayLimits.maxScenarioBytes));if(value.id+'.json'!==name)throw Error('Replay scenario identity does not match its file.');values.push(value);}
    if(Buffer.byteLength(JSON.stringify(values))>replayLimits.maxLibraryBytes)throw Error('Replay library exceeds its aggregate size limit.');
    return values;
  }
  async function readResult(file){
    const value=validateResult(await read(file,replayLimits.maxResultBytes));
    if(path.basename(resultFile(value.id,value.runId))!==path.basename(file))throw Error('Replay result identity does not match its file.');
    return value;
  }
  async function resultEntries(id){
    const found=await names(results,'result'),values=[];
    for(const name of found){if(!id||name.startsWith(replayId(id)+'.'))values.push({file:path.join(results,name),value:await readResult(path.join(results,name))});}
    return values.sort((a,b)=>b.value.startedAt-a.value.startedAt||b.value.finishedAt-a.value.finishedAt||b.value.runId.localeCompare(a.value.runId));
  }
  async function safeUnlink(file,limit){await fileInfo(file,limit);await inspectDirectory(path.dirname(file));await unlink(file);}
  return {
    list:()=>exclusive(listUnlocked),
    get:id=>exclusive(async()=>{await prepare();const value=validateReplay(await read(scenarioFile(id),replayLimits.maxScenarioBytes));if(value.id!==replayId(id))throw Error('Replay scenario identity mismatch.');return value;}),
    save:value=>exclusive(async()=>{
      const scenario=validateReplay(value),all=await listUnlocked();
      if(!scenario.id){if(all.length>=replayLimits.maxScenarios)throw Error('Replay scenario limit reached.');scenario.id=randomUUID();}
      else if(!all.some(item=>item.id===scenario.id))throw Error('Unknown replay scenario.');
      const updated=[...all.filter(item=>item.id!==scenario.id),scenario];
      if(Buffer.byteLength(JSON.stringify(updated))>replayLimits.maxLibraryBytes)throw Error('Replay library size limit reached. Export or remove an older scenario first.');
      await write(scenarioFile(scenario.id),scenario,replayLimits.maxScenarioBytes);return scenario;
    }),
    results:id=>exclusive(async()=>{replayId(id);await prepare();return (await resultEntries(id)).map(entry=>entry.value);}),
    saveResult:value=>exclusive(async()=>{
      await prepare();validateResult(value);
      await fileInfo(scenarioFile(value.id),replayLimits.maxScenarioBytes);
      await write(resultFile(value.id,value.runId),value,replayLimits.maxResultBytes);
      const entries=await resultEntries(),counts=new Map();
      for(let index=0;index<entries.length;index++){
        const entry=entries[index],count=(counts.get(entry.value.id)||0)+1;counts.set(entry.value.id,count);
        if(index>=replayLimits.maxResults||count>replayLimits.maxResultsPerScenario)await safeUnlink(entry.file,replayLimits.maxResultBytes);
      }
      return value;
    }),
    remove:id=>exclusive(async()=>{
      replayId(id);await prepare();const file=scenarioFile(id);await fileInfo(file,replayLimits.maxScenarioBytes);
      for(const entry of await resultEntries(id))await safeUnlink(entry.file,replayLimits.maxResultBytes);
      await safeUnlink(file,replayLimits.maxScenarioBytes);return {removed:true};
    }),
  };
}
