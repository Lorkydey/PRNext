import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createTypeScriptWatchSystem} from './typescript-watch.mjs';

const ts=createRequire(import.meta.url)('typescript');
const compilerFile=createRequire(import.meta.url).resolve('typescript'),execute=promisify(execFile);

async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-typescript-watch-')));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await mkdir(path.join(root,'node_modules/fixture-types'),{recursive:true});
  await writeFile(path.join(root,'node_modules/fixture-types/package.json'),'{"name":"fixture-types","types":"index.d.ts"}');
  await writeFile(path.join(root,'node_modules/fixture-types/index.d.ts'),'export interface Shape {id:string}');
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  return root;
}

async function watchRegression(root,explicit,compilerFile,watchSystem){
  const ts=createRequire(compilerFile)(compilerFile),filename=path.join(root,'tsconfig.json'),source=path.join(root,'check.ts');
  const calls=[],active=new Set();let latest;
  // Model a native backend that silently loses every event. Only the real
  // TypeScript polling backend can observe the edit and update diagnostics.
  const system={...ts.sys,watchDirectory(){return {close(){}};},watchFile(file,callback,interval,options){
    calls.push({file:path.resolve(file),kind:options?.watchFile});
    const polling=Number.isInteger(options?.watchFile)&&options.watchFile<ts.WatchFileKind.UseFsEvents;
    let open=true;
    const original=polling?ts.sys.watchFile(file,(...args)=>{if(open)callback(...args);},interval,options):{close(){}};
    const watcher={close(){if(!open)return;open=false;original.close();active.delete(watcher);}};active.add(watcher);return watcher;
  }};
  const host=ts.createWatchCompilerHost(filename,{noEmit:true},watchSystem({...ts,sys:system},root,{platform:'darwin',env:{}}),ts.createSemanticDiagnosticsBuilderProgram,()=>{},()=>{});
  host.afterProgramCreate=builder=>{latest=ts.getPreEmitDiagnostics(builder.getProgram()).filter(diagnostic=>diagnostic.category===ts.DiagnosticCategory.Error);};
  const watcher=ts.createWatchProgram(host);
  try{
  assert.ok(latest.some(diagnostic=>diagnostic.code===2322));
  await writeFile(source,'import type {Shape} from "fixture-types";export const value:number=42;export type Item=Shape;');
  const deadline=Date.now()+10000;
  while(latest.length&&Date.now()<deadline)await delay(25);
  assert.deepEqual(latest.map(diagnostic=>ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n')),[]);
  const expected=explicit?ts.WatchFileKind.FixedPollingInterval:ts.WatchFileKind.DynamicPriorityPolling;
  for(const file of [filename,source])assert.ok(calls.some(call=>call.file===file&&call.kind===expected),'No project polling watcher: '+path.basename(file));
  const dependency=calls.find(call=>call.file===path.join(root,'node_modules/fixture-types/index.d.ts'));
  assert.ok(dependency,'The real program must load an installed type dependency.');
  if(!explicit)assert.equal(dependency.kind,undefined,'Dependencies retain their native default rather than joining the polling queue.');
  watcher.close();assert.equal(active.size,0,'Closing the watch program releases polling and native subscriptions.');
  return {passed:true,subscriptions:active.size};
  }finally{watcher.close();}
}

for(const explicit of [false,true])test('macOS TypeScript '+(explicit?'explicit polling':'default project watchers')+' clear real errors when native events are lost',{timeout:20000},async t=>{
  const root=await fixture(t);
  await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,types:[],noEmit:true},include:['check.ts'],...(explicit?{watchOptions:{watchFile:'fixedPollingInterval'}}:{})}));
  await writeFile(path.join(root,'check.ts'),'import type {Shape} from "fixture-types";export const value:number="wrong";export type Item=Shape;');
  // Production owns TypeScript's shared polling queues in a child worker and
  // closes its subscriptions before exiting. Exercise that same lifecycle;
  // never force the test-runner process to exit around leaked resources.
  const code=[
    "import assert from 'node:assert/strict';import path from 'node:path';",
    "import {createRequire} from 'node:module';import {writeFile} from 'node:fs/promises';",
    "import {setTimeout as delay} from 'node:timers/promises';",
    'const run='+watchRegression.toString()+';const factory='+createTypeScriptWatchSystem.toString()+';',
    'run('+JSON.stringify(root)+','+explicit+','+JSON.stringify(compilerFile)+',factory).then(result=>process.stdout.write(JSON.stringify(result),()=>process.exit(0)),error=>{console.error(error.stack);process.exit(1);});',
  ].join('\n');
  const {stdout}=await execute(process.execPath,['--input-type=module','-e',code],{timeout:15000,windowsHide:true,maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(stdout),{passed:true,subscriptions:0});
});

test('macOS polling preserves explicit native strategies and environment overrides',async t=>{
  const root=await fixture(t),file=path.join(root,'check.ts'),calls=[];
  await writeFile(file,'export {};');
  const system={...ts.sys,watchFile(...args){calls.push(args);return {close(){}};}},compiler={...ts,sys:system};
  const watch=createTypeScriptWatchSystem(compiler,root,{platform:'darwin',env:{}});
  const options={watchFile:ts.WatchFileKind.UseFsEvents,excludeFiles:['ignored.ts']};
  watch.watchFile(file,()=>{},250,options).close();assert.equal(calls[0][3],options);
  for(const env of [{TSC_WATCHFILE:'UseFsEvents'},{TSC_NONPOLLING_WATCHER:'1'}])assert.equal(createTypeScriptWatchSystem(compiler,root,{platform:'darwin',env}),system);
  for(const platform of ['win32','linux'])assert.equal(createTypeScriptWatchSystem(compiler,root,{platform,env:{}}),system);
});

test('project aliases are polled while linked external files and dependencies stay native',async t=>{
  const root=await fixture(t),alias=path.join(root,'root-alias'),outside=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-typescript-external-'))),calls=[];
  t.after(()=>rm(outside,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await writeFile(path.join(root,'check.ts'),'export {};');await writeFile(path.join(outside,'external.ts'),'export {};');
  await symlink(root,alias,process.platform==='win32'?'junction':'dir');
  await symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  const system={...ts.sys,watchFile(file,callback,interval,options){calls.push({file,kind:options?.watchFile});return {close(){}};}};
  const watch=createTypeScriptWatchSystem({...ts,sys:system},alias,{platform:'darwin',env:{}});
  for(const file of [path.join(root,'check.ts'),path.join(alias,'check.ts'),path.join(root,'linked/external.ts'),path.join(alias,'node_modules/fixture-types/index.d.ts')])watch.watchFile(file,()=>{},250).close();
  assert.deepEqual(calls.map(call=>call.kind),[ts.WatchFileKind.DynamicPriorityPolling,ts.WatchFileKind.DynamicPriorityPolling,undefined,undefined]);
});
