import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateImagesConfig} from './images-config.mjs';
import {build} from './index.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url);
for(const [loader,base,expected]of[
  ['imgix','https://images.example.test/source/','https://images.example.test/source/photo.png?auto=format&fit=max&w=256'],
  ['cloudinary','https://res.cloudinary.com/demo/image/upload/','https://res.cloudinary.com/demo/image/upload/f_auto,c_limit,w_256,q_auto/photo.png'],
  ['akamai','https://images.example.test/','https://images.example.test/photo.png?imwidth=256'],
])test(`${loader} builds real responsive SSR image URLs without the native optimizer`,async()=>{
  const root=await mkdtemp(path.join(repo,'.prnext-cdn-test-'));
  try{
    await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'package.json'),'{}');await writeFile(path.join(root,'pages/index.jsx'),`import Image from'next/image';export default()=> <Image src='/photo.png' width={200} height={100} alt='CDN photo'/>`);
    await writeFile(path.join(root,'prnext.config.mjs'),`export default{images:{loader:${JSON.stringify(loader)},path:${JSON.stringify(base)}}}`);
    const built=await build(root),entry=built.prerendered.find(x=>x.path==='/'),html=await readFile(path.join(built.outputDirectory,entry.file),'utf8');
    assert.ok(html.replaceAll('&amp;','&').includes(expected),html.slice(0,1600));assert.doesNotMatch(html,/_prnext\/image\?/);
  }finally{await rm(root,{recursive:true,force:true})}
});
test('CDN loaders preserve configured image query parameters and reject invalid URL configuration',()=>{
  for(const input of [{loader:'imgix'},{loader:'imgix',path:'/images'},{loader:'akamai',path:'javascript:alert(1)'},{loader:'cloudinary',path:'https://user:pass@host.test/'},{loader:'imgix',path:'https://host.test/?query=x'}])assert.throws(()=>validateImagesConfig(input));
  const config=require('../compat/image-config.cjs'),original={...config};
  try{Object.assign(config,validateImagesConfig({loader:'imgix',path:'https://images.example.test/source/'}));const file=require.resolve('../compat/image-shared.cjs');delete require.cache[file];const{getImageProps}=require(file);const{props}=getImageProps({src:'/photo.png?auto=compress&auto=enhance&fit=crop&w=11',width:200,height:100,alt:'x',quality:90});const url=new URL(props.src);assert.equal(url.searchParams.get('auto'),'compress,enhance');assert.equal(url.searchParams.get('fit'),'crop');assert.equal(url.searchParams.get('w'),'11');assert.equal(url.searchParams.get('q'),'90');}
  finally{for(const key of Object.keys(config))delete config[key];Object.assign(config,original);delete require.cache[require.resolve('../compat/image-shared.cjs')]}
});
