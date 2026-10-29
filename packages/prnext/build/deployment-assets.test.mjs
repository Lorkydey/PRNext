import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { retainDeploymentAssets } from './deployment-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-deployment-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  let count=0;
  async function build(files, previous, options={}) {
    const stage=path.join(root,String(++count));await mkdir(path.join(stage,'assets'),{recursive:true});
    for(const [name,contents]of Object.entries(files))await writeFile(path.join(stage,'assets',name),contents);
    const manifest={cacheId:String(count),config:{},...options.manifest};
    const result=await retainDeploymentAssets({stage,destination:previous?.stage||path.join(root,'missing'),manifest,now:1000+count,...options});
    return {stage,manifest,result};
  }
  return {root,build};
}

test('retains only immutable public assets, their exact bytes and original expiry',async t=>{
  const {build}=await fixture(t);
  const one=await build({'page-ABCDEFGH.js':'import "./image-ABCDEFGH.png"','base-12345678.css':'body{}','image-ABCDEFGH.png':'png','secret.json':'private','source-ABCDEFGH.js.map':'source','index.html':'html'});
  const two=await build({'page-IJKLMNOP.js':'new'},one);
  assert.deepEqual((await readdir(path.join(two.stage,'assets'))).sort(),['base-12345678.css','image-ABCDEFGH.png','page-ABCDEFGH.js','page-IJKLMNOP.js']);
  assert.equal(await readFile(path.join(two.stage,'assets','page-ABCDEFGH.js'),'utf8'),'import "./image-ABCDEFGH.png"');
  assert.equal(two.manifest.config.retainedAssets['page-ABCDEFGH.js'],3601001);
  const three=await build({'page-QRSTUVWX.js':'newest'},two);
  assert.equal(three.manifest.config.retainedAssets['page-ABCDEFGH.js'],3601001);
});

test('generation count, age, byte cap and explicit revocation bound retention',async t=>{
  const {build}=await fixture(t);let previous;
  for(let i=0;i<5;i++)previous=await build({[`page-${String(i).repeat(8)}.js`]:'abcd'},previous);
  assert.equal((await readdir(path.join(previous.stage,'assets'))).length,3);
  const expired=await build({'page-ABCDEFGH.js':'new'},previous,{now:3602000});
  assert.equal(expired.result.files,0);
  const capped=await build({'page-IJKLMNOP.js':'new'},previous,{policy:{maxBytes:3}});
  assert.equal(capped.result.files,0);
  const disabled=await build({'page-QRSTUVWX.js':'new'},previous,{policy:false});
  assert.equal(disabled.result.files,0);
});

test('tampered, missing, symlinked and conflicting previous files are not published',async t=>{
  const {root,build}=await fixture(t);
  const first=await build({'page-ABCDEFGH.js':'one','chunk-ABCDEFGH.js':'two'});
  await writeFile(path.join(first.stage,'assets','chunk-ABCDEFGH.js'),'tampered');
  assert.equal((await build({'page-IJKLMNOP.js':'new'},first)).result.files,0);
  const second=await build({'page-ABCDEFGH.js':'one'});
  assert.equal((await build({'page-ABCDEFGH.js':'different'},second)).result.generations,0);
  const outside=path.join(root,'outside.js');await writeFile(outside,'one');
  await rm(path.join(second.stage,'assets','page-ABCDEFGH.js'));
  try {await symlink(outside,path.join(second.stage,'assets','page-ABCDEFGH.js'));}
  catch(error){if(process.platform==='win32'&&error.code==='EPERM')return;throw error;}
  assert.equal((await build({'page-QRSTUVWX.js':'new'},second)).result.files,0);
});

test('malformed previous index is a bounded optimization miss',async t=>{
  const {build}=await fixture(t),first=await build({'page-ABCDEFGH.js':'one'});
  await writeFile(path.join(first.stage,'deployment-assets.json'),JSON.stringify({version:1,generations:[{id:'bad',createdAt:1000,files:[{name:'../server.js',bytes:1,hash:'a'.repeat(64)}]}]}));
  assert.equal((await build({'page-IJKLMNOP.js':'new'},first)).result.files,0);
});

test('overlapping older generations cannot substitute a chunk with different bytes',async t=>{
  const {build}=await fixture(t);
  const first=await build({'shared-ABCDEFGH.js':'old shared','page-11111111.js':'old entry'});
  const oldIndex=JSON.parse(await readFile(path.join(first.stage,'deployment-assets.json'),'utf8'));
  const second=await build({'shared-ABCDEFGH.js':'new shared','page-22222222.js':'new entry'});
  const nextIndex=JSON.parse(await readFile(path.join(second.stage,'deployment-assets.json'),'utf8'));
  nextIndex.generations.push(oldIndex.generations[0]);
  await writeFile(path.join(second.stage,'deployment-assets.json'),JSON.stringify(nextIndex));
  await writeFile(path.join(second.stage,'assets','page-11111111.js'),'old entry');
  const third=await build({'page-33333333.js':'latest'},second);
  assert.equal(await readFile(path.join(third.stage,'assets','shared-ABCDEFGH.js'),'utf8'),'new shared');
  assert.equal(third.result.generations,1);
  await assert.rejects(readFile(path.join(third.stage,'assets','page-11111111.js')),{code:'ENOENT'});
});


test('oversized assets, oversized graphs and unknown auxiliary assets disable only optional retention',async t=>{
  const {build}=await fixture(t);
  for(const files of [
    {'page-ABCDEFGH.js':Buffer.alloc(8*1024*1024+1)},
    Object.fromEntries(Array.from({length:1025},(_,i)=>[`chunk-${String(i).padStart(8,'0')}.js`,'x'])),
    {'page-ABCDEFGH.js':'ok','movie-ABCDEFGH.mp4':'video'},
  ]){
    const large=await build(files);
    assert.equal(JSON.parse(await readFile(path.join(large.stage,'deployment-assets.json'),'utf8')).generations[0].eligible,false);
    assert.equal((await build({'page-IJKLMNOP.js':'new'},large)).result.files,0);
  }
});


test('Windows case aliases cannot overwrite a current immutable asset or abort a valid new build',{skip:process.platform!=='win32'},async t=>{
  const {build}=await fixture(t);
  const previous=await build({'chunk-ABCDEFGH.js':'same'});
  const next=await build({'CHUNK-ABCDEFGH.js':'same','page-IJKLMNOP.js':'new'},previous);
  assert.equal(next.result.files,0);
  assert.equal(await readFile(path.join(next.stage,'assets','CHUNK-ABCDEFGH.js'),'utf8'),'same');
  const changed=await build({'CHUNK-ABCDEFGH.js':'different'},previous);
  assert.equal(changed.result.generations,0);
});
