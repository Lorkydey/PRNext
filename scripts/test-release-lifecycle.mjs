// Run compatibility controls against the executable extracted from the archive
// that will be published. Refuse source/package drift, even at the same version.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repositoryRoot } from './cargo.mjs';
import { archiveFilename, readArchive, verifyArtifacts, releaseLifecycleTests } from './verify-npm-artifacts.mjs';
import { nativePlatform, nativeBinaryName, packageRoot } from '../packages/prnext/native/resolve.mjs';

const directory=path.resolve(process.argv[2] || 'artifacts/npm');
const target=nativePlatform();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
await verifyArtifacts({directory,hostOnly:true});
const main=await readFile(path.join(directory,archiveFilename()));
for(const [name,entry] of readArchive(main)) {
  if(entry.type==='5') continue;
  const relative=name.replace(/^package\//,'');
  const file=path.resolve(packageRoot,relative);
  assert.ok(file.startsWith(path.resolve(packageRoot)+path.sep),'Archive source must remain inside the package');
  assert.ok(entry.data.equals(await readFile(file)),`Archive differs from lifecycle test source: ${relative}`);
}
const archive=await readFile(path.join(directory,archiveFilename(target.package)));
const entries=readArchive(archive);
const binary=entries.get('package/bin/'+nativeBinaryName(target.os)).data;
const descriptor=JSON.parse(entries.get('package/native.json').data);
assert.equal(descriptor.sha256,digest(binary));
const temporary=await mkdtemp(path.join(tmpdir(),'prnext-release-lifecycle-'));
const executable=path.join(temporary,nativeBinaryName(target.os));
const tests=releaseLifecycleTests;
const report={platform:target.id,node:process.version,binarySha256:digest(binary),mainArchiveSha256:digest(main),nativeArchiveSha256:digest(archive),tests,passed:false};
try {
  await writeFile(executable,binary,{mode:0o700,flag:'wx'});
  const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...tests.map(name=>`tests/${name}.test.mjs`)],{
    cwd:repositoryRoot,env:{...process.env,PRNEXT_BINARY:executable},stdio:'inherit',windowsHide:true,
  });
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  Object.assign(report,result,{passed:result.code===0 && result.signal===null});
  if(!report.passed) process.exitCode=1;
} finally {
  await writeFile(path.join(directory,`lifecycle-${target.id}-node${process.versions.node.split('.')[0]}.json`),JSON.stringify(report,null,2)+'\n');
  assert.equal(path.dirname(temporary),path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('prnext-release-lifecycle-'));
  await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
