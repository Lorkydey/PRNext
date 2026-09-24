import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTurbopack} from './module-resolution.mjs';
import {turbopackRules} from './turbopack-conditions.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build,withCompilation,configureCompiler} from './compiler.mjs';

test('Turbopack conditions validate bounded expressions and rule variants',()=>{
  const rules={'*.svg':[{loaders:['loader'],condition:{all:[{not:'foreign'},{any:[{path:/^images\//},{content:/<svg/g}]}]}},{loaders:['other'],condition:'browser'}]};
  assert.equal(validateTurbopack({rules}).rules,rules);
  for(const condition of [true,'unknown',{},[],{all:'browser'},{path:3},{content:'svg'},{not:'browser',path:'*'},{any:['browser'],all:['node']}]){
    assert.throws(()=>validateTurbopack({rules:{'*':{loaders:['loader'],condition}}}),/condition/);
  }
  let deep='browser';for(let i=0;i<35;i++)deep={not:deep};
  assert.throws(()=>validateTurbopack({rules:{'*':{loaders:['loader'],condition:deep}}}),/complex/);
  assert.throws(()=>validateTurbopack({rules:{'*':[]}}),/variants/);
});

test('Turbopack root anchors path patterns and conditions to the configured workspace', async () => {
  const root = path.resolve('workspace');
  const file = path.join(root,'apps/blog/icon.svg');
  const [rule] = turbopackRules({'apps/blog/*.svg':{loaders:['svg-loader'],condition:{path:'apps/blog/*.svg'}}}, {root:path.join(root,'apps/blog'),config:{turbopack:{root}}}, 'browser');
  assert.equal(rule.test(file),true);
  assert.equal(await rule.rustyxCondition(file,()=>assert.fail('No content test')),true);
  assert.equal(rule.test(path.join(root,'other/icon.svg')),false);
});

test('conditional loader variants compile on Node, browser and Edge and reselect after source changes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'rustyx-turbo-conditions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'entry.js'),`import value from './value.js';export default value`);
  await writeFile(path.join(root,'value.js'),`export default 'magic'`);
  await writeFile(path.join(root,'loader.cjs'),`module.exports=function(){return 'export default '+JSON.stringify(this.getOptions().label)}`);
  const config={turbopack:validateTurbopack({rules:{'value.js':['node','browser','edge-light'].map(target=>({
    condition:{all:[target,'production',{not:'foreign'},{path:/value\.js$/,content:/magic/g}]},
    loaders:[{loader:'./loader.cjs',options:{label:target}}],as:'*.js',
  }))}})};
  const compile=target=>withCompilation(async()=>{
    configureCompiler({root,stage:path.join(root,'stage'),assetBase:'/_rustyx/assets',config});
    const result=await build({absWorkingDir:root,entryPoints:['entry.js'],bundle:true,write:false,format:'esm',platform:target==='node'?'node':'browser',
      define:{'process.env.NEXT_RUNTIME':JSON.stringify(target==='edge-light'?'edge':'nodejs')},plugins:[{name:'rustyx-pages-compatibility',setup(){}}]});
    return (await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))).default;
  });
  for(const target of ['node','browser','edge-light'])assert.equal(await compile(target),target);
  await writeFile(path.join(root,'value.js'),`export default 'plain'`);
  for(const target of ['node','browser','edge-light'])assert.equal(await compile(target),'plain');
});

test('Turbopack conditions distinguish runtime and mode, short-circuit reads and reset regexes',async()=>{
  const root='/project';
  const rule=condition=>({'*.svg':{loaders:['loader'],condition}});
  for(const target of ['browser','node','edge'])for(const dev of [true,false]){
    for(const name of ['browser','node','edge-light','development','production']){
      const [selected]=turbopackRules(rule(name),{root,dev},target);
      assert.equal(await selected.rustyxCondition('/project/img/a.svg',()=>{throw Error('unnecessary read');}),{browser:target==='browser',node:target==='node','edge-light':target==='edge',development:dev,production:!dev}[name]);
    }
  }
  let reads=0;const read=async()=>{reads++;return '<svg />';};
  const [selected]=turbopackRules(rule({all:[{not:'foreign'},{path:'img/*.svg',content:/<svg/g}]}),{root},'node');
  assert.equal(selected.test('/project/img/a.svg'),true);
  assert.equal(await selected.rustyxCondition('/project/node_modules/pkg/img/a.svg',read),false);
  assert.equal(await selected.rustyxCondition('/project/other/a.svg',read),false);assert.equal(reads,0);
  for(let i=0;i<2;i++)assert.equal(await selected.rustyxCondition('/project/img/a.svg',read),true);
  assert.equal(reads,2);
  const [workspace]=turbopackRules(rule({not:'foreign'}),{root},'node');
  assert.equal(await workspace.rustyxCondition('/workspace/lib/a.svg',read),true,'workspace siblings are application code');
});
