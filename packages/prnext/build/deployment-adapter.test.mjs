import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from './index.mjs';
import {loadProjectConfig} from './config.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(t){const root=await mkdtemp(path.join(repo,'.prnext-adapter-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'package.json'),'{}');await writeFile(path.join(root,'pages/index.jsx'),'export default()=> <h1>Adapter</h1>');return root}
test('adapter modifies validated config and sees a complete native output before atomic publication',async t=>{
  const root=await fixture(t);
  await writeFile(path.join(root,'prnext.config.mjs'),`export default{experimental:{adapterPath:'./adapter.mjs'},prerender:{workers:1}}`);
  await writeFile(path.join(root,'adapter.mjs'),`import{writeFile,access}from'node:fs/promises';import path from'node:path';export default{name:'fixture',prnextAdapterVersion:1,modifyConfig(config,context){if(context.framework!=='prnext'||!context.prnextVersion)throw Error('invalid context');return{...config,basePath:'/adapted'}},async onBuildComplete(ctx){await access(path.join(ctx.distDir,ctx.output.manifest));if(ctx.output.server.entry!=='runtime/worker.mjs'||!ctx.runtimeContract)throw Error('missing worker');await writeFile(path.join(ctx.projectDir,'observed.json'),JSON.stringify({framework:ctx.framework,buildId:ctx.buildId,configBase:ctx.config.basePath,routes:ctx.manifest.routes.map(x=>x.pattern)}));}}`);
  const initial=await build(root),before=await readFile(path.join(initial.outputDirectory,'manifest.json'),'utf8');
  const observed=JSON.parse(await readFile(path.join(root,'observed.json'),'utf8'));assert.equal(observed.framework,'prnext');assert.equal(observed.configBase,'/adapted');assert.equal(observed.buildId,JSON.parse(before).buildId);assert.ok(observed.routes.includes('/'));
  await writeFile(path.join(root,'adapter.mjs'),`export default{name:'failure',prnextAdapterVersion:1,onBuildComplete(){throw Error('expected adapter failure')}}`);
  await assert.rejects(build(root),/expected adapter failure/);assert.equal(await readFile(path.join(initial.outputDirectory,'manifest.json'),'utf8'),before);
});
test('unqualified Next adapters and invalid modified configuration fail explicitly',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'prnext.config.mjs'),`export default{adapterPath:'./adapter.mjs'}`);
  await writeFile(path.join(root,'adapter.mjs'),`export default{name:'next-only',onBuildComplete(){}}`);await assert.rejects(loadProjectConfig(root),/prnextAdapterVersion/);
  await writeFile(path.join(root,'adapter.mjs'),`export default{name:'bad-config',prnextAdapterVersion:1,modifyConfig(){return{unknownNativeOption:true}}}`);await assert.rejects(loadProjectConfig(root),/unknownNativeOption/);
});
