import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { imagePNG } from '../../../tests/images-fixture.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, run) {
  const root = await mkdtemp(path.join(repository, '.rustyx-images-test-'));
  try { for (const [name, data] of Object.entries(files)) { await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),data); } await run(root); }
  finally { await rm(root,{recursive:true,force:true}); }
}
test('static imports share image data, intrinsic dimensions and generated blur across modules',async()=>{
  await fixture({'photo.png':imagePNG(40,20),'pages/index.jsx':`import Image from 'next/image';import photo from '../photo.png';export default()=> <Image src={photo} width={20} alt="Test" placeholder="blur"/>`,'pages/second.jsx':`import Image from 'rustyx/image';import photo from '../photo.png';export default()=> <Image src={photo} alt="Second"/>`},async root=>{
    const result=await build(root);const assets=await readdir(path.join(result.outputDirectory,'assets'));assert.equal(assets.filter(name=>/^image-.*\.png$/.test(name)).length,1);
    const html=await readFile(path.join(result.outputDirectory,result.prerendered.find(page=>page.path==='/').file),'utf8');assert.match(html,/width="20" height="10"/);assert.match(html,/data:image\/webp;base64/);assert.match(html,/_rustyx\/image\?url=/);
  });
});
test('custom loaderFile is compiled from TypeScript and disables native URLs',async()=>{
  await fixture({'next.config.mjs':`export default{images:{loader:'custom',loaderFile:'./loader.ts'}}`,'loader.ts':`export default function imageLoader({src,width,quality}:{src:string;width:number;quality?:number}){return 'https://images.example'+src+'?width='+width+'&quality='+(quality||75)}`,'pages/index.jsx':`import Image from 'next/image';export default()=> <Image src="/photo.png" width={100} height={50} alt="Custom"/>`},async root=>{
    const result=await build(root);const html=await readFile(path.join(result.outputDirectory,result.prerendered.find(page=>page.path==='/').file),'utf8');assert.match(html,/https:\/\/images\.example\/photo\.png\?width=128/);assert.doesNotMatch(html,/\/_rustyx\/image\?/);
  });
});
test('disableStaticImages leaves imported files as URLs for third-party loaders',async()=>{
  await fixture({'next.config.mjs':`export default{images:{disableStaticImages:true}}`,'photo.png':imagePNG(1,1),'pages/index.jsx':`import photo from '../photo.png';export default()=> <img src={photo} alt="Raw"/>`},async root=>{
    const result=await build(root);const html=await readFile(path.join(result.outputDirectory,result.prerendered.find(page=>page.path==='/').file),'utf8');assert.match(html,/src="\/_rustyx\/assets\/photo-[^" ]+\.png"/);assert.doesNotMatch(html,/\[object Object\]/);
  });
});
