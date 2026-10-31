import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,unlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
test('validation CLIs really execute through a linked checkout instead of silently succeeding',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-cli-alias-')),alias=path.join(directory,'linked checkout');let linked=false;
  try{
    await symlink(root,alias,process.platform==='win32'?'junction':'dir');linked=true;
    const {stdout}=await execute(process.execPath,[path.join(alias,'scripts/vendor-nft.mjs'),'verify'],{windowsHide:true,timeout:10000});
    assert.equal(JSON.parse(stdout).files,42);
    for(const [file,args,message]of [
      ['tests/performance/prepare-candidate-comparison.mjs',[],/exact baseline/],
      ['tests/performance/release-regression-prepare.mjs',[],/absolute paths/],
      ['tests/performance/release-regression.mjs',['check',path.join(directory,'missing.json')],/ENOENT/],
      ['tests/reference/run.mjs',['--invalid-reference-option'],/Unknown option/],
    ])await assert.rejects(execute(process.execPath,[path.join(alias,file),...args],{windowsHide:true,timeout:10000}),error=>message.test(error.stderr));
  }finally{
    if(linked)await unlink(alias);
    const physical=await realpath(directory),parent=await realpath(tmpdir());assert.equal(path.dirname(physical),parent);assert.ok(path.basename(physical).startsWith('prnext-cli-alias-'));
    await rm(physical,{recursive:true,force:true});
  }
});
