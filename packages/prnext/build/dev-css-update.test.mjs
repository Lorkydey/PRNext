import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from './index.mjs';
import {tryDevCssUpdate} from './dev-css-update.mjs';
import {snapshotDevelopmentBuild} from '../runtime/development.mjs';
test('CSS updates preserve original artifacts and fall back when JS-visible class names change',async t=>{
  const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(path.join(repo,'.prnext-fast-css-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'app'));
  for(const [name,source]of Object.entries({'package.json':'{"type":"module"}','app/layout.jsx':'export default({children})=><html><body>{children}</body></html>',
    'app/page.jsx':`import Counter from './counter';export default()=> <Counter/>;`,
    'app/counter.jsx':`'use client';import styles from './counter.module.css';export default()=> <button className={styles.counter}>Counter</button>`,
    'app/counter.module.css':'.counter{color:red}'}))await writeFile(path.join(root,name),source);
  const manifest=await build(root,{dev:true});assert.ok(manifest.devStyles.bundles.length);
  const css=manifest.devStyles.bundles[0][0],original=await readFile(path.join(manifest.outputDirectory,'assets',css),'utf8');
  await writeFile(path.join(root,'app/counter.module.css'),'.counter{color:blue}');
  const options={root,source:manifest.outputDirectory,destination:path.join(root,'.prnext-style-update'),manifest,changed:['app/counter.module.css'],sequence:2,snapshot:snapshotDevelopmentBuild};
  const updated=await tryDevCssUpdate(options);assert.ok(updated,'same class map admits CSS-only update');
  assert.notEqual(updated.buildId,manifest.buildId);assert.equal(updated.devSequence,2);
  assert.match(await readFile(path.join(updated.outputDirectory,'assets',css),'utf8'),/color:\s*(?:blue|#00f)/);
  assert.equal(await readFile(path.join(manifest.outputDirectory,'assets',css),'utf8'),original);
  const publicManifest=JSON.parse(await readFile(path.join(updated.outputDirectory,'assets',path.basename(updated.devClient)),'utf8'));
  assert.ok(publicManifest.app.css.every(url=>url.includes('?v='+updated.buildId)));
  await writeFile(path.join(root,'app/counter.module.css'),'.counter{color:green}.newClass{color:red}');
  const destination=path.join(root,'.prnext-style-fallback');assert.equal(await tryDevCssUpdate({...options,destination}),undefined);
  await assert.rejects(stat(destination),{code:'ENOENT'});
});

test('CSS fast path only republishes affected bundles and learns shared imports',async t=>{
  const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(path.join(repo,'.prnext-selective-css-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'pages'));
  for(const[name,source]of Object.entries({'package.json':'{"type":"module"}',
    'pages/a.jsx':"import './a.css';export default()=> <h1>A</h1>",
    'pages/b.jsx':"import styles from './b.module.scss';export default()=> <h1 className={styles.box}>B</h1>",
    'pages/a.css':'@import "./shared.css";h1{color:red}',
    'pages/b.module.scss':'$color:green;.box{color:$color}', 'pages/shared.css':':root{--shared:1}',
    'pages/new.css':':root{--fresh:2}'}))await writeFile(path.join(root,name),source);
  let manifest=await build(root,{dev:true});
  const a=manifest.routes.find(route=>route.pattern==='/a').css[0],b=manifest.routes.find(route=>route.pattern==='/b').css[0];
  assert.notEqual(a,b);assert.ok(manifest.devStyles.dependencies.some(([,files])=>files.includes(path.join(root,'pages/shared.css'))));
  const originalB=await readFile(path.join(manifest.outputDirectory,'assets',path.basename(b)));
  const update=async(file,content)=>{
    await writeFile(path.join(root,file),content);
    const next=await tryDevCssUpdate({root,source:manifest.outputDirectory,destination:path.join(root,'.prnext-style-'+Math.random().toString(36).slice(2)),manifest,changed:[file],sequence:2,snapshot:snapshotDevelopmentBuild});
    assert.ok(next);manifest=next;
    return JSON.parse(await readFile(path.join(next.outputDirectory,'assets',path.basename(next.devClient)),'utf8'));
  };
  let client=await update('pages/a.css','@import "./shared.css";@import "./new.css";h1{color:blue}');
  assert.match(client.pages.find(page=>page.pattern==='/a').css[0],/\?v=/);
  assert.equal(client.pages.find(page=>page.pattern==='/b').css[0],b);
  assert.deepEqual(await readFile(path.join(manifest.outputDirectory,'assets',path.basename(b))),originalB);
  assert.ok(manifest.devStyles.dependencies.find(([name])=>name===path.basename(a))[1].includes(path.join(root,'pages/new.css')));
  client=await update('pages/new.css',':root{--fresh:3}');
  assert.match(await readFile(path.join(manifest.outputDirectory,'assets',path.basename(a)),'utf8'),/--fresh:\s*3/);
  await update('pages/a.css','h1{color:purple}');
  assert.ok(!manifest.devStyles.dependencies.find(([name])=>name===path.basename(a))[1].includes(path.join(root,'pages/new.css')),'removed imports leave the bundle graph');
});

test('CSS Module updates with image/font URLs retain dependencies and immutable assets',async t=>{
  const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(path.join(repo,'.prnext-css-url-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await writeFile(path.join(root,'pages/index.jsx'),"import styles from './style.module.css';export default()=> <h1 className={styles.hero}>Image style</h1>");
  const style=color=>'@font-face{font-family:Fixture;src:url("./fixture.woff2")}.hero{color:'+color+';background-image:url("./pixel.png")}';
  await writeFile(path.join(root,'pages/style.module.css'),style('red'));
  const pixel=Buffer.from([137,80,78,71,13,10,26,10]);await writeFile(path.join(root,'pages/pixel.png'),pixel);
  const font=Buffer.from([119,79,70,50,0,1,2,3]);await writeFile(path.join(root,'pages/fixture.woff2'),font);
  const manifest=await build(root,{dev:true});
  const assets=path.join(manifest.outputDirectory,'assets'),css=path.basename(manifest.routes.find(route=>route.pattern==='/').css[0]);
  const original=await readFile(path.join(assets,css),'utf8');
  for(const asset of ['pixel.png','fixture.woff2']){
    assert.ok(manifest.devStyles.modules.some(module=>module.watchFiles.includes(path.join(root,'pages',asset))));
    assert.ok(manifest.devStyles.dependencies.some(([,files])=>files.includes(path.join(root,'pages',asset))));
  }
  await writeFile(path.join(root,'pages/style.module.css'),style('blue'));
  const next=await tryDevCssUpdate({root,source:manifest.outputDirectory,destination:path.join(root,'.prnext-style-url'),manifest,changed:['pages/style.module.css'],sequence:2,snapshot:snapshotDevelopmentBuild});
  assert.ok(next,'a URL asset is a stylesheet dependency, not an extra stylesheet root');
  const current=await readFile(path.join(next.outputDirectory,'assets',css),'utf8');
  assert.match(current,/color:\s*(?:blue|#00f)/);assert.deepEqual(current.match(/url\([^)]*\)/g),original.match(/url\([^)]*\)/g),'unchanged image/font resources keep their immutable URLs');
  assert.equal(await readFile(path.join(assets,css),'utf8'),original);
  const image=(await readdir(path.join(next.outputDirectory,'assets'))).find(file=>file.startsWith('pixel-')&&file.endsWith('.png'));
  assert.deepEqual(await readFile(path.join(next.outputDirectory,'assets',image)),pixel);
  const fontFile=(await readdir(path.join(next.outputDirectory,'assets'))).find(file=>file.startsWith('fixture-')&&file.endsWith('.woff2'));
  assert.deepEqual(await readFile(path.join(next.outputDirectory,'assets',fontFile)),font);
});
