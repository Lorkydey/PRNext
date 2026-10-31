// Synthetic encoder profiling, deliberately separate from HTTP/release gates.
// Preparation freezes the source bytes before the exclusive measurement window.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Session} from 'node:inspector';
import {cpus,totalmem} from 'node:os';
import {mkdir,readFile,realpath,lstat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {isMainModule} from '../../scripts/main-module.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const moduleFiles=['runtime/flight-delta.mjs','compat/flight-delta.cjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),half=Math.floor(sorted.length/2);return sorted.length%2?sorted[half]:(sorted[half-1]+sorted[half])/2;};
const validateSettings=({iterations,repetitions})=>{
  if(!Number.isSafeInteger(iterations)||iterations<1||iterations>128||!Number.isSafeInteger(repetitions)||repetitions<3||repetitions>12)throw Error('Use 1–128 iterations and 3–12 paired repetitions.');
};

export function flightDeltaFixtures(){
  let seed=0x93a4c178;
  const random=Buffer.alloc(2*1024*1024);
  for(let index=0;index<random.length;index++){
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;random[index]=seed>>>24;
  }
  const changed=Buffer.from(random.subarray(0,32768));changed.fill(97,16000,16064);
  const rows=revision=>Buffer.from(Array.from({length:512},(_,id)=>JSON.stringify({id,title:'shared row '+id,value:id*7,revision})).join('\n'));
  return[
    {name:'useful-random-base',description:'A useful 32 KiB changed chunk against a 256 KiB base.',base:random.subarray(0,256*1024),parts:[changed]},
    {name:'gzip-repeated-rows',description:'Repeated JSON rows with changed revisions; the report records whether compression is probed.',base:rows('before'),parts:[rows('after')]},
    {name:'tiny-first-chunk',description:'A 10-byte first chunk cannot negotiate delta, even with a full 2 MiB base.',base:random,parts:[Buffer.from('0:{"a":1}\n'),random.subarray(0,32768)]},
    {name:'oversized-probe-chunk',description:'A first chunk above the existing 64 KiB compression-probe ceiling.',base:random.subarray(0,256*1024),parts:[random.subarray(0,128*1024)]},
  ];
}

function fixtureIdentity(fixtures){
  return fixtures.map(({name,description,base,parts})=>({name,description,baseBytes:base.length,baseSha256:sha(base),chunkBytes:parts.map(part=>part.length),inputSha256:sha(Buffer.concat(parts))}));
}

async function evidenceDirectory(value,{fresh=false}={}){
  const target=path.resolve(value),artifacts=await realpath(path.join(root,'artifacts'));
  if(!inside(artifacts,target))throw Error('Use a private profile directory under checkout artifacts/.');
  if(!inside(artifacts,await realpath(path.dirname(target))))throw Error('Profile parent escapes checkout artifacts/.');
  if(fresh){await mkdir(target);}
  const info=await lstat(target);
  if(!info.isDirectory()||info.isSymbolicLink()||!inside(artifacts,await realpath(target)))throw Error('Invalid profile evidence directory.');
  return target;
}

export async function prepareFlightDeltaProfile({baseline,candidate,output,iterations=12,repetitions=6}){
  validateSettings({iterations,repetitions});
  const directory=await evidenceDirectory(output,{fresh:true});
  const variants={};
  for(const[name,source]of Object.entries({baseline,candidate})){
    const sourceRoot=await realpath(source),files=[];
    for(const relative of moduleFiles){
      const file=path.join(sourceRoot,'packages/prnext',relative),info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024||!inside(sourceRoot,await realpath(file)))throw Error('Invalid or oversized Flight source file.');
      const bytes=await readFile(file),target=path.join(directory,name,relative);
      await mkdir(path.dirname(target),{recursive:true});
      await writeFile(target,bytes,{flag:'wx',mode:0o400});
      files.push({file:relative,bytes:bytes.length,sha256:sha(bytes)});
    }
    variants[name]={declaredSourceDirectory:sourceRoot,files};
  }
  const preparation={version:1,preparedAt:new Date().toISOString(),node:process.version,settings:{iterations,repetitions,warmupIterations:3,maximumMeasurementMs:60000},variants,fixtures:fixtureIdentity(flightDeltaFixtures())};
  await writeFile(path.join(directory,'preparation.json'),JSON.stringify(preparation,null,2)+'\n',{flag:'wx',mode:0o400});
  return{directory,preparationSha256:sha(await readFile(path.join(directory,'preparation.json'))),variants,settings:preparation.settings};
}

async function frozenModules(directory,preparation){
  const variants={};
  for(const name of ['baseline','candidate']){
    assert.deepEqual(preparation.variants[name].files.map(value=>value.file),moduleFiles);
    for(const file of preparation.variants[name].files){
      const location=path.join(directory,name,file.file),info=await lstat(location);
      assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size===file.bytes&&inside(directory,await realpath(location)),'Profile source snapshot changed.');
      assert.equal(sha(await readFile(location)),file.sha256,'Profile source snapshot hash changed.');
    }
    const runtime=await import(pathToFileURL(path.join(directory,name,moduleFiles[0])).href);
    const transport=await import(pathToFileURL(path.join(directory,name,moduleFiles[1])).href);
    variants[name]={...runtime,...transport.default};
  }
  return variants;
}

async function encode(module,fixture,{validate=false}={}){
  let probes=0;
  const policy=module.compressedDeltaPolicy('gzip');
  const source=new ReadableStream({start(controller){for(const part of fixture.parts)controller.enqueue(part);controller.close();}},{highWaterMark:0});
  const encoded=await module.deltaStream(source,fixture.base,{assess:(raw,wire)=>{probes++;return policy(raw,wire);}});
  let bytes=0,chunks=0;const output=[];
  for await(const value of encoded.body){bytes+=value.length;chunks++;if(validate)output.push(value);}
  if(validate){
    const wire=Buffer.concat(output,bytes),decoded=encoded.delta?module.decodeStream(new ReadableStream({start(c){c.enqueue(wire);c.close();}}),fixture.base):wire;
    assert.deepEqual(Buffer.from(await new Response(decoded).arrayBuffer()),Buffer.concat(fixture.parts),'Profile fixture failed its exact round-trip.');
  }
  return{delta:encoded.delta,bytes,chunks,probes};
}

function summarizeProfile(profile){
  const hits=new Map();for(const id of profile.samples||[])hits.set(id,(hits.get(id)||0)+1);
  const count=(profile.samples||[]).length;
  return{samplingIntervalMicroseconds:1000,samples:count,topSelfSamples:profile.nodes.map(node=>({
    function:node.callFrame.functionName||'(anonymous)',url:node.callFrame.url,hits:hits.get(node.id)||0,
    percent:count?100*(hits.get(node.id)||0)/count:0,
  })).filter(value=>value.hits).sort((a,b)=>b.hits-a.hits).slice(0,24)};
}

export async function runFlightDeltaProfile(preparedDirectory,{profile=false}={}){
  const directory=await evidenceDirectory(preparedDirectory);
  const preparationBytes=await readFile(path.join(directory,'preparation.json'));
  if(preparationBytes.length>1024*1024)throw Error('Oversized profile preparation.');
  const preparation=JSON.parse(preparationBytes),fixtures=flightDeltaFixtures();
  validateSettings(preparation.settings);
  assert.equal(preparation.version,1);assert.equal(preparation.node,process.version);
  assert.equal(preparation.settings.warmupIterations,3);assert.equal(preparation.settings.maximumMeasurementMs,60000);
  assert.deepEqual(fixtureIdentity(fixtures),preparation.fixtures,'Profile fixture identities changed.');
  const modules=await frozenModules(directory,preparation);
  const driverSha256=sha(await readFile(fileURLToPath(import.meta.url)));
  await writeFile(path.join(directory,'run-started.json'),JSON.stringify({startedAt:new Date().toISOString(),preparationSha256:sha(preparationBytes),profile})+'\n',{flag:'wx',mode:0o600});
  const report={version:1,complete:false,scope:'Synthetic in-process Flight encoder CPU profile only. It does not measure HTTP throughput, production latency, event-loop tail latency, or total application memory. Paired order alternates; every retained scenario remains in the report.',node:process.version,environment:{platform:process.platform,arch:process.arch,cpuModels:[...new Set(cpus().map(value=>value.model))],logicalCpus:cpus().length,totalMemoryBytes:totalmem(),zlib:process.versions.zlib,sharedHostContention:'unmeasured',profilerEnabled:profile},driverSha256,preparationSha256:sha(preparationBytes),settings:preparation.settings,fixtures:preparation.fixtures,variants:preparation.variants,validation:{},samples:[]};
  let session,post;
  const started=performance.now();
  try{
    for(const[name,module]of Object.entries(modules)){
      report.validation[name]={};
      for(const fixture of fixtures){
        report.validation[name][fixture.name]=await encode(module,fixture,{validate:true});
        for(let n=0;n<preparation.settings.warmupIterations;n++)await encode(module,fixture);
      }
    }
    if(profile){
      session=new Session();session.connect();
      post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,value)=>error?reject(error):resolve(value)));
      await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');
    }
    for(let repetition=0;repetition<preparation.settings.repetitions;repetition++)for(const fixture of fixtures){
      const order=repetition%2?['candidate','baseline']:['baseline','candidate'];
      for(const name of order){
        await nextTurn();
        const cpu=process.cpuUsage(),at=performance.now();let wireBytes=0,chunks=0,probes=0;
        for(let iteration=0;iteration<preparation.settings.iterations;iteration++){
          const result=await encode(modules[name],fixture);
          assert.deepEqual(result,report.validation[name][fixture.name],'Measured encoding differs from its validated deterministic result.');
          wireBytes+=result.bytes;chunks+=result.chunks;probes+=result.probes;
          if(performance.now()-started>preparation.settings.maximumMeasurementMs)throw Error('Flight profile exceeded its bounded measurement deadline.');
        }
        const elapsedMs=performance.now()-at,used=process.cpuUsage(cpu);
        report.samples.push({variant:name,scenario:fixture.name,repetition,order,iterations:preparation.settings.iterations,elapsedMs,cpuUserMicroseconds:used.user,cpuSystemMicroseconds:used.system,wireBytes,chunks,probes});
      }
    }
    if(profile){
      const{profile:cpu}=await post('Profiler.stop');
      const bytes=Buffer.from(JSON.stringify(cpu));if(bytes.length>16*1024*1024)throw Error('Flight CPU profile exceeded its output budget.');
      await writeFile(path.join(directory,'encoder.cpuprofile'),bytes,{flag:'wx',mode:0o600});
      report.cpuProfile={sha256:sha(bytes),bytes:bytes.length,...summarizeProfile(cpu)};
    }
    await frozenModules(directory,preparation);
    assert.equal(sha(await readFile(path.join(directory,'preparation.json'))),report.preparationSha256,'Profile preparation changed.');
    assert.equal(sha(await readFile(fileURLToPath(import.meta.url))),driverSha256,'Profile driver changed during measurement.');
    report.summary=fixtures.map(fixture=>{
      const variants=Object.fromEntries(['baseline','candidate'].map(variant=>{
        const samples=report.samples.filter(value=>value.scenario===fixture.name&&value.variant===variant);
        return[variant,{medianElapsedMs:median(samples.map(value=>value.elapsedMs)),medianCpuMicroseconds:median(samples.map(value=>value.cpuUserMicroseconds+value.cpuSystemMicroseconds))}];
      }));
      const paired=Array.from({length:preparation.settings.repetitions},(_,repetition)=>{
        const samples=report.samples.filter(value=>value.scenario===fixture.name&&value.repetition===repetition);
        return samples.find(value=>value.variant==='candidate').elapsedMs/samples.find(value=>value.variant==='baseline').elapsedMs;
      });
      return{scenario:fixture.name,variants,pairedElapsedRatios:paired,medianPairedElapsedRatio:median(paired)};
    });
    report.complete=true;
    await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return report;
  }catch(error){
    await writeFile(path.join(directory,'failure.json'),JSON.stringify({...report,error:'The bounded encoder profile did not complete; preserve all partial samples.'},null,2)+'\n',{flag:'wx',mode:0o600});
    throw error;
  }finally{session?.disconnect();}
}

if(isMainModule(import.meta.url)){
  try{
    const[mode,...arguments_]=process.argv.slice(2);
    if(mode==='--prepare'&&arguments_.length===3)console.log(JSON.stringify(await prepareFlightDeltaProfile({baseline:arguments_[0],candidate:arguments_[1],output:arguments_[2]})));
    else if(mode==='--run'&&(arguments_.length===1||arguments_.length===2&&arguments_[1]==='--profile')){
      const report=await runFlightDeltaProfile(arguments_[0],{profile:arguments_[1]==='--profile'});
      console.log(JSON.stringify({complete:report.complete,summary:report.summary,cpuProfile:report.cpuProfile}));
    }else throw Error('Use --prepare BASELINE_ROOT CANDIDATE_ROOT OUTPUTDIR, then --run PREPARED_DIR [--profile].');
  }catch(error){console.error('Flight encoder profile failed: '+error.message);process.exitCode=1;}
}
