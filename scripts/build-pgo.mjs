// Reproducible native PGO without overwriting target/release or changing Node.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {cargoEnvironment,repositoryRoot} from './cargo.mjs';

const {values}=parseArgs({options:{phase:{type:'string',default:'all'},output:{type:'string',default:'target/pgo'},features:{type:'string',default:''},'train-script':{type:'string'}}});
if(!['all','generate','train','build'].includes(values.phase))throw new Error('phase must be all, generate, train or build');
if(['all','train'].includes(values.phase)&&!values['train-script'])throw new Error('Supply --train-script with a representative production workload');
const output=path.resolve(values.output), profiles=path.join(output,'profiles');
const env=cargoEnvironment();
if(env.RUSTFLAGS||env.CARGO_ENCODED_RUSTFLAGS)throw new Error('Unset inherited Rust flags for a reproducible PGO build');
async function run(command,args,environment=env,capture=false) {
  const child=spawn(command,args,{cwd:repositoryRoot,env:environment,stdio:capture?['ignore','pipe','inherit']:'inherit'});
  let text='';child.stdout?.on('data',chunk=>text+=chunk);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)))});
  return text.trim();
}
async function identity() {
  const hash=createHash('sha256');
  async function visit(file) {
    hash.update(path.relative(repositoryRoot,file));
    const entries=await readdir(file,{withFileTypes:true}).catch(()=>null);
    if(entries)for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name)))await visit(path.join(file,entry.name));
    else hash.update(await readFile(file));
  }
  for(const file of ['Cargo.toml','Cargo.lock','crates/rustyx'])await visit(path.join(repositoryRoot,file));
  return {sources:hash.digest('hex'),rustc:await run('rustc',['-vV'],env,true),features:values.features};
}
await mkdir(output,{recursive:true});
const generated=path.join(output,'instrumented'),optimized=path.join(output,'optimized');
const binary=path.join(generated,'release',process.platform==='win32'?'rustyx.exe':'rustyx');
const features=values.features?['--features',values.features]:[];
const stateFile=path.join(output,'build.json');
let state;
if(['all','generate'].includes(values.phase)) {
  await rm(stateFile,{force:true});
  // Dedicated generated profile directory; stale runs must not bias a new build.
  await rm(profiles,{recursive:true,force:true});await mkdir(profiles,{recursive:true});
  await run('cargo',['build','--release','--bin','rustyx','--target-dir',generated,...features],{...env,CARGO_ENCODED_RUSTFLAGS:`-Cprofile-generate=${profiles}`});
  state={...(await identity()),instrumented:binary,profiles,generatedAt:new Date().toISOString()};
  await writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
} else state=JSON.parse(await readFile(stateFile,'utf8'));
for(const [key,value]of Object.entries(await identity()))if(state[key]!==value)throw new Error(`PGO ${key} changed; regenerate and retrain`);
if(['all','train'].includes(values.phase)) {
  for(const key of ['trainedAt','trainer','trainerSha256','optimized','completedAt','profileFiles','binarySha256','profileSha256'])delete state[key];
  await writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
  // Cargo build scripts can themselves emit instrumented profiles. Train only
  // on the requested workload, never on compilation or a previous application.
  for(const name of await readdir(profiles))if(name.endsWith('.profraw'))await rm(path.join(profiles,name));
  await run(process.execPath,[path.resolve(values['train-script'])],{...env,RUSTYX_PGO_BINARY:binary,LLVM_PROFILE_FILE:path.join(profiles,'%m-%p.profraw')});
  state.trainedAt=new Date().toISOString();state.trainer=path.resolve(values['train-script']);
  state.trainerSha256=createHash('sha256').update(await readFile(state.trainer)).digest('hex');
  await writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
}
if(['all','build'].includes(values.phase)) {
  const files=(await readdir(profiles)).filter(name=>name.endsWith('.profraw')).map(name=>path.join(profiles,name));
  if(!files.length||!state.trainedAt)throw new Error('No completed PGO training run');
  if(shaProfile(await readFile(state.trainer))!==state.trainerSha256)throw new Error('PGO trainer changed; retrain before building');
  const sysroot=await run('rustc',['--print','sysroot'],env,true), host=state.rustc.match(/^host: (.+)$/m)[1];
  const tool=path.join(sysroot,'lib','rustlib',host,'bin',process.platform==='win32'?'llvm-profdata.exe':'llvm-profdata');
  try{await access(tool)}catch{await run('rustup',['component','add','llvm-tools-preview'])}
  const merged=path.join(output,'merged.profdata');
  await run(tool,['merge','-o',merged,...files]);
  const profile=await readFile(merged),profileHash=shaProfile(profile);
  const immutable=path.join(output,`profile-${profileHash}.profdata`);
  await writeFile(immutable,profile);
  // The content-addressed filename changes Cargo's flags when retraining.
  // Merely replacing merged.profdata would otherwise reuse the previous binary.
  await run('cargo',['build','--release','--bin','rustyx','--target-dir',optimized,...features],{...env,CARGO_ENCODED_RUSTFLAGS:`-Cprofile-use=${immutable}\x1f-Cllvm-args=-pgo-warn-missing-function`});
  state.optimized=path.join(optimized,'release',process.platform==='win32'?'rustyx.exe':'rustyx');
  state.completedAt=new Date().toISOString();state.profileFiles=files.length;
  state.profileSha256=profileHash;
  state.binarySha256=createHash('sha256').update(await readFile(state.optimized)).digest('hex');
  await writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
}
console.log(JSON.stringify(state,null,2));
function shaProfile(bytes){return createHash('sha256').update(bytes).digest('hex')}
