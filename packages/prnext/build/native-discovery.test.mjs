import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createNativeDiscovery } from './native-discovery.mjs';

test('native discovery keeps computed loaders in .cts and .mts in its conservative boundary', async () => {
  for (const extension of ['cjs', 'cts', 'mts']) {
    const root = await mkdtemp(path.join(tmpdir(), 'prnext-native-discovery-'));
    const put = async (file, source) => { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source); };
    try {
      await put('package.json', '{"name":"application"}');
      await put('node_modules/wrapper/package.json', '{"name":"wrapper","main":"index.mjs","dependencies":{"native-leaf":"1.0.0"}}');
      await put('node_modules/wrapper/index.mjs', `import './loader.${extension}';export default 1;`);
      await put('node_modules/wrapper/loader.' + extension, extension === 'cjs'
        ? `const id=['native','leaf'].join('-');exports.load=()=>require(id);`
        : `const id:string=['native','leaf'].join('-');export const load=()=>require(id);`);
      await put('node_modules/wrapper/unused.d.' + (extension === 'cjs' ? 'ts' : extension), `'use client';declare const unused:string;`);
      await put('node_modules/native-leaf/package.json', '{"name":"native-leaf","main":"index.cjs"}');
      await put('node_modules/native-leaf/index.cjs', 'module.exports=require("./binding.node");');
      await put('node_modules/native-leaf/binding.node', 'not executed');
      const discovery = createNativeDiscovery({ projectRoot: root, isClientSource: source => source.includes('use client') });
      let owner;
      await build({ stdin: { contents: '', resolveDir: root }, bundle: true, write: false, platform: 'node', logLevel: 'silent', plugins: [{
        name: 'inspect-native-loader', setup(api) {
          discovery.setResolver('ssr', (name, importer, kind) => api.resolve(name, { importer, resolveDir: path.dirname(importer), kind }));
          api.onStart(async () => { owner = await discovery.externalOwner(path.join(root, 'node_modules/wrapper/index.mjs'), 'ssr'); });
        },
      }] });
      // This checks discovery, not Node's ability to execute TypeScript under
      // node_modules (which requires a separate package/runtime qualification).
      assert.equal(owner?.name, 'wrapper', extension);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

async function graphFixture(packages,run){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-native-proof-'));
  const put=async(name,contents)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,contents);};
  try{
    await put('package.json','{"name":"application"}');
    for(const[name,dependencies]of Object.entries(packages)){
      await put('node_modules/'+name+'/package.json',JSON.stringify({name,main:'index.cjs',dependencies:Object.fromEntries(dependencies.map(name=>[name,'1.0.0']))}));
      await put('node_modules/'+name+'/index.cjs','module.exports=1');
    }
    await run({root,put,entry:name=>path.join(root,'node_modules',name,'index.cjs')});
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^prnext-native-proof-/);
    await rm(root,{recursive:true,force:true});
  }
}

test('complete native-free closure proofs reuse diamond dependencies within one discovery only',async()=>{
  await graphFixture({top:['left','right'],left:['shared'],right:['shared'],shared:[]},async({root,put,entry})=>{
    const discovery=createNativeDiscovery({projectRoot:root,isClientSource:()=>false});
    assert.equal(await discovery.externalOwner(entry('top'),'ssr'),undefined);
    const before=discovery.stats();assert.equal(before.declaredVisits,4);assert.equal(before.nativeAbsent,4);
    assert.equal(await discovery.externalOwner(entry('right'),'ssr'),undefined);
    assert.equal(discovery.stats().declaredVisits,before.declaredVisits);assert.ok(discovery.stats().declaredProofHits>before.declaredProofHits);
    await put('node_modules/shared/binding.node','never executed');
    const fresh=createNativeDiscovery({projectRoot:root,isClientSource:()=>false});
    assert.equal((await fresh.externalOwner(entry('top'),'ssr'))?.name,'top','a new build must observe the newly added addon');
  });
});

test('cycle-local absence is never promoted to a negative proof when another branch reaches native code',async()=>{
  await graphFixture({a:['b','leaf'],b:['a'],c:['b'],leaf:[]},async({root,put,entry})=>{
    await put('node_modules/leaf/binding.node','never executed');
    const discovery=createNativeDiscovery({projectRoot:root,isClientSource:()=>false});
    const owners=await Promise.all([discovery.externalOwner(entry('a'),'ssr'),discovery.externalOwner(entry('b'),'ssr')]);
    assert.deepEqual(owners.map(owner=>owner?.name),['a','b']);
    assert.equal((await discovery.externalOwner(entry('c'),'ssr'))?.name,'c');
    assert.equal(discovery.stats().nativeAbsent,0);
  });
});
