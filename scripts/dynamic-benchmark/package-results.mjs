import {readFile,writeFile,readdir,cp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {files} from './fixture.mjs';
import {directory,rootFor,sha,exec,here,sourceHash} from './harness.mjs';

const data=JSON.parse(await readFile(path.join(directory,'results.json'),'utf8'));
assert.equal(data.status,'complete','finish the campaign before packaging');
const sourceFiles=[];
for(const [name,content] of Object.entries(files)){
  const expected=sha(content),next=sha(await readFile(path.join(rootFor('next'),name))),rustyx=sha(await readFile(path.join(rootFor('rustyx'),name)));
  assert.equal(next,expected,name+': Next source changed');assert.equal(rustyx,expected,name+': Rustyx source changed');
  sourceFiles.push({path:name,sha256:expected,nextSha256:next,rustyxSha256:rustyx});
}
assert.equal(data.preparation.sourceHash,sourceHash);
const scriptFiles=[];
for(const name of(await readdir(here)).sort()){
  const content=await readFile(path.join(here,name));scriptFiles.push({path:'scripts/dynamic-benchmark/'+name,sha256:sha(content)});
}
const require=createRequire(path.join(rootFor('next'),'package.json'));
const rustyxVersion=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
const integrity={rustyxVersion,harnessSha256:data.preparation.harnessSha256,checkedAt:new Date().toISOString(),sourceHash,sourceFiles,scriptFiles,
  nextBundledReact:require('next/dist/compiled/react').version,nextBundledReactDOM:require('next/dist/compiled/react-dom').version,
  note:'Both engines receive byte-identical application files and declared dependency versions. Next App Router uses its bundled React/RSC runtime; Rustyx uses the installed React/RSC packages. Core framework implementations are intentionally not assumed identical.'};
await writeFile(path.join(directory,'integrity.json'),JSON.stringify(integrity,null,2)+'\n');
const selected=['benchmark-results.html','benchmark-results.md','metrics.csv','results.json','parity.json','summary.json','preparation.json','integrity.json','README.md','next-ssr-10000.ndjson','rustyx-ssr-10000.ndjson'];
for(const optional of ['excluded-runs.json','verification.json']){try{await readFile(path.join(directory,optional));selected.push(optional)}catch{}}
// A single archive contains the reviewable report, raw evidence and fixture.
// No node_modules, credentials, copied projects or native executables.
const staging=path.join(directory,'share');await rm(staging,{recursive:true,force:true});await mkdir(staging,{recursive:true});
for(const name of selected)await cp(path.join(directory,name),path.join(staging,name));
await cp(here,path.join(staging,'scripts/dynamic-benchmark'),{recursive:true});
for(const [name,content] of Object.entries(files)){const file=path.join(staging,'fixture',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content)}
await writeFile(path.join(staging,'REPRODUCTION.txt'),'Run the included scripts inside the Rustyx checkout identified by the report, after copying scripts/dynamic-benchmark into it. See README.md. The package contains application fixture source and raw evidence, not the full Rustyx framework or installed dependencies.\n');
const archive=path.join(directory,'rustyx-next-dynamic-benchmark.zip');await rm(archive,{force:true});
await exec('zip',['-q','-r',archive,'.'],{cwd:staging,maxBuffer:1024*1024});
console.log(archive);
