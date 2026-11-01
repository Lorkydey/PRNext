import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {executeNpm} from '../../packages/prnext/native/npm.mjs';
import {nativePlatform,nativeBinaryName} from '../../packages/prnext/native/resolve.mjs';
import {prepareCandidateComparison,verifyArchiveSource,verifyComparisonPair} from './prepare-candidate-comparison.mjs';

test('controlled comparison refuses ambiguous source labels and unsafe affinity before any preparation',async()=>{
  for(const baseline of [undefined,'main','a'.repeat(39),'a'.repeat(41),'$(touch file)'])await assert.rejects(prepareCandidateComparison({baseline}),/exact baseline/);
  for(const affinityCpus of [undefined,'0;echo','0 1','-1'])await assert.rejects(prepareCandidateComparison({baseline:'a'.repeat(40),affinityCpus}),/CPU affinity/);
  await assert.rejects(verifyArchiveSource('unused','main'),/exact Git/);
});

test('independently versioned comparison archives reject a swapped native or damaged executable',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-comparison-versions-')),target=nativePlatform();
  let sequence=0;
  async function packed(version,native,{changedBytes=false,wrongPlatform=false}={}){
    const dir=path.join(root,'package-'+sequence++),out=path.join(dir,'archive');
    await mkdir(out,{recursive:true});
    const manifest=native?{name:target.package,version,os:[target.os],cpu:[target.cpu],...(target.libc?{libc:[target.libc]}:{})}:
      {name:'@thomas.f/prnext',version,optionalDependencies:{[target.package]:version}};
    await writeFile(path.join(dir,'package.json'),JSON.stringify(manifest));
    if(native){
      const bytes=Buffer.from('fixed comparison executable bytes');
      await mkdir(path.join(dir,'bin'));
      const binary=path.join(dir,'bin',nativeBinaryName(target.os));
      await writeFile(binary,changedBytes?Buffer.concat([bytes,Buffer.from('tampered')]):bytes);
      if(process.platform!=='win32')await chmod(binary,0o755);
      await writeFile(path.join(dir,'native.json'),JSON.stringify({...target,id:wrongPlatform?'unrelated-target':target.id,version,sha256:createHash('sha256').update(bytes).digest('hex')}));
    }
    const result=await executeNpm(['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:dir,timeout:60000,maxBuffer:1024**2});
    return readFile(path.join(out,JSON.parse(result.stdout)[0].filename));
  }
  try{
    const main18=await packed('0.1.18-alpha',false),native18=await packed('0.1.18-alpha',true);
    const main19=await packed('0.1.19-alpha',false),native19=await packed('0.1.19-alpha',true);
    assert.equal(verifyComparisonPair(main18,native18).version,'0.1.18-alpha');
    assert.equal(verifyComparisonPair(main19,native19).version,'0.1.19-alpha');
    assert.throws(()=>verifyComparisonPair(main19,native18),/mismatched/);
    assert.throws(()=>verifyComparisonPair(main18,native19),/mismatched/);
    assert.throws(()=>verifyComparisonPair(main19,main19),/mismatched/);
    const damaged=await packed('0.1.19-alpha',true,{changedBytes:true});
    const wrong=await packed('0.1.19-alpha',true,{wrongPlatform:true});
    assert.throws(()=>verifyComparisonPair(main19,damaged),/mismatched/);
    assert.throws(()=>verifyComparisonPair(main19,wrong),/mismatched/);
  }finally{await rm(root,{recursive:true,force:true});}
});
