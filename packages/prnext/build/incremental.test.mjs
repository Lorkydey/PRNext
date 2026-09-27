import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {incrementalBuild,closeIncrementalCompiler,incrementalCompilerStats} from './incremental.mjs';
test('incremental contexts rebind plugins and stage paths, recover from errors and observe dependency edits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-incremental-'));
  try{
    await writeFile(path.join(root,'module.js'),'export default "first"');
    let loads=0;
    async function compile(index,marker){
      const stage=path.join(root,`.prnext-build-${index}`);await mkdir(stage,{recursive:true});
      const entry=path.join(stage,'entry.js');await writeFile(entry,'import value from "../module.js";console.log(value)');
      return incrementalBuild({absWorkingDir:root,entryPoints:[entry],outdir:path.join(stage,'out'),bundle:true,write:false,metafile:true,plugins:[{name:'test-transform',setup(builder){builder.onLoad({filter:/module\.js$/,namespace:'file'},async args=>{loads++;return {contents:(await readFile(args.path,'utf8'))+`;console.log(${JSON.stringify(marker)})`,loader:'js'}})}}]}, {root,stage});
    }
    const first=await compile(1,'one');assert.match(first.outputFiles[0].text,/first/);assert.match(first.outputFiles[0].text,/one/);
    const second=await compile(2,'two');assert.match(second.outputFiles[0].text,/two/);assert.doesNotMatch(second.outputFiles[0].text,/one/);assert.match(second.outputFiles[0].path,/build-2/);
    assert.ok(Object.keys(second.metafile.outputs).every(file=>!file.includes('incremental-stage')));
    await writeFile(path.join(root,'module.js'),'export default "changed"');assert.match((await compile(3,'three')).outputFiles[0].text,/changed/);
    await writeFile(path.join(root,'module.js'),'export default (');await assert.rejects(compile(4,'four'));
    await writeFile(path.join(root,'module.js'),'export default "fixed"');assert.match((await compile(5,'five')).outputFiles[0].text,/fixed/);assert.ok(loads>=5);assert.equal(incrementalCompilerStats().created,1);assert.equal(incrementalCompilerStats().reused,4);
  }finally{await closeIncrementalCompiler();await rm(root,{recursive:true,force:true})}
});

test('auxiliary compiler reuse has a separate bounded budget and sees changes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-incremental-aux-'));
  try{
    const before=incrementalCompilerStats();
    const stage=path.join(root,'stage');await mkdir(stage);
    const entry=path.join(root,'vendor.js');await writeFile(entry,'export const value=1');
    const options={entryPoints:[entry],outdir:path.join(stage,'out'),bundle:true,format:'esm',write:false};
    await incrementalBuild(options,{root,stage,group:'project'});
    await incrementalBuild(options,{root,stage,group:'auxiliary'});
    await writeFile(entry,'export const value=2');
    assert.match((await incrementalBuild(options,{root,stage,group:'auxiliary'})).outputFiles[0].text,/value = 2/);
    for(let index=0;index<4;index++)await incrementalBuild({...options,define:{A:String(index)}},{root,stage,group:'auxiliary'});
    assert.equal(incrementalCompilerStats().contexts,3,'one project plus two auxiliary contexts');
    const reused=incrementalCompilerStats().reused;
    await incrementalBuild(options,{root,stage,group:'project'});
    assert.equal(incrementalCompilerStats().reused,reused+1,'auxiliary eviction leaves project graphs intact');
    assert.ok(incrementalCompilerStats().created>before.created);
  }finally{await closeIncrementalCompiler();await rm(root,{recursive:true,force:true});}
});
