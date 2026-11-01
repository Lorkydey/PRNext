import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from './index.mjs';
import {tryDevCssUpdate} from './dev-css-update.mjs';
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
  const options={root,source:manifest.outputDirectory,destination:path.join(root,'.prnext-style-update'),manifest,changed:['app/counter.module.css'],sequence:2,snapshot:()=>{throw Error('CSS updates must not snapshot JavaScript generations');}};
  const updated=await tryDevCssUpdate(options);assert.ok(updated,'same class map admits CSS-only update');
  assert.notEqual(updated.buildId,manifest.buildId);assert.equal(updated.devSequence,2);
  assert.match(await readFile(path.join(updated.outputDirectory,'assets',css),'utf8'),/color:\s*(?:blue|#00f)/);
  assert.equal(await readFile(path.join(manifest.outputDirectory,'assets',css),'utf8'),original);
  assert.deepEqual((await readdir(updated.outputDirectory)).sort(),['assets','build-output.json','manifest.json']);
  assert.equal(updated.devStyles.baseClient,manifest.devClient);
  assert.equal(updated.devStyles.overlay.baseDirectory,path.relative(root,manifest.outputDirectory).replaceAll(path.sep,'/'));
  const publicManifest=JSON.parse(await readFile(path.join(updated.outputDirectory,'assets',path.basename(updated.devClient)),'utf8'));
  assert.ok(publicManifest.app.css.every(url=>url.includes('?v='+updated.buildId)));
  let fallback;
  const invalid=path.join(root,'.prnext-invalid-style-overlay');
  assert.equal(await tryDevCssUpdate({...options,source:updated.outputDirectory,baseSource:manifest.outputDirectory,destination:invalid,manifest:{...updated,devStyles:{...updated.devStyles,overlay:{...updated.devStyles.overlay,baseDirectory:'../outside'}}},onFallback:code=>{fallback=code;}}),undefined);
  assert.equal(fallback,'invalid-style-overlay-base');
  await assert.rejects(stat(invalid),{code:'ENOENT'});
  await rm(path.join(updated.outputDirectory,'assets',path.basename(updated.devClient)));
  const missing=path.join(root,'.prnext-missing-style-manifest');
  assert.equal(await tryDevCssUpdate({...options,source:updated.outputDirectory,baseSource:manifest.outputDirectory,destination:missing,manifest:updated,onFallback:code=>{fallback=code;}}),undefined);
  assert.equal(fallback,'missing-style-manifest');
  await assert.rejects(stat(missing),{code:'ENOENT'});
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
  const baseSource=manifest.outputDirectory;
  const a=manifest.routes.find(route=>route.pattern==='/a').css[0],b=manifest.routes.find(route=>route.pattern==='/b').css[0];
  assert.notEqual(a,b);assert.ok(manifest.devStyles.dependencies.some(([,files])=>files.includes(path.join(root,'pages/shared.css'))));
  const originalB=await readFile(path.join(manifest.outputDirectory,'assets',path.basename(b)));
  const update=async(file,content)=>{
    await writeFile(path.join(root,file),content);
    const next=await tryDevCssUpdate({root,source:manifest.outputDirectory,baseSource,destination:path.join(root,'.prnext-style-'+Math.random().toString(36).slice(2)),manifest,changed:[file],sequence:2,snapshot:()=>{throw Error('CSS updates must not traverse the JavaScript build');}});
    assert.ok(next);manifest=next;
    return JSON.parse(await readFile(path.join(next.outputDirectory,'assets',path.basename(next.devClient)),'utf8'));
  };
  let client=await update('pages/a.css','@import "./shared.css";@import "./new.css";h1{color:blue}');
  assert.match(client.pages.find(page=>page.pattern==='/a').css[0],/\?v=/);
  assert.equal(client.pages.find(page=>page.pattern==='/b').css[0],b);
  await assert.rejects(stat(path.join(manifest.outputDirectory,'assets',path.basename(b))),{code:'ENOENT'});
  assert.deepEqual(await readFile(path.join(baseSource,'assets',path.basename(b))),originalB,'untouched B remains available in the retained JavaScript generation');
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
  const next=await tryDevCssUpdate({root,source:manifest.outputDirectory,destination:path.join(root,'.prnext-style-url'),manifest,changed:['pages/style.module.css'],sequence:2,snapshot:()=>{throw Error('CSS updates must not copy JavaScript');}});
  assert.ok(next,'a URL asset is a stylesheet dependency, not an extra stylesheet root');
  const current=await readFile(path.join(next.outputDirectory,'assets',css),'utf8');
  assert.match(current,/color:\s*(?:blue|#00f)/);assert.deepEqual(current.match(/url\([^)]*\)/g),original.match(/url\([^)]*\)/g),'unchanged image/font resources keep their immutable URLs');
  assert.equal(await readFile(path.join(assets,css),'utf8'),original);
  const image=(await readdir(path.join(next.outputDirectory,'assets'))).find(file=>file.startsWith('pixel-')&&file.endsWith('.png'));
  assert.deepEqual(await readFile(path.join(next.outputDirectory,'assets',image)),pixel);
  const fontFile=(await readdir(path.join(next.outputDirectory,'assets'))).find(file=>file.startsWith('fixture-')&&file.endsWith('.woff2'));
  assert.deepEqual(await readFile(path.join(next.outputDirectory,'assets',fontFile)),font);
});

test('CSS overlays retain modified siblings after pruning and replace obsolete URL assets without copying a growing JS build', async t => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repo, '.prnext-css-overlay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pages'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'pages/a.jsx'), "import './a.css';export default()=> <h1>A</h1>");
  await writeFile(path.join(root, 'pages/b.jsx'), "import './b.css';export default()=> <h1>B</h1>");
  await writeFile(path.join(root, 'pages/a.css'), 'h1{color:red}');
  await writeFile(path.join(root, 'pages/b.css'), 'h1{color:green}');
  await writeFile(path.join(root, 'pages/a.png'), Buffer.from('modified-a-image'));
  for (let index = 0; index < 5; index++) await writeFile(path.join(root, `pages/b${index}.png`), Buffer.from(`image-b-${index}`));
  let manifest = await build(root, { dev: true });
  const baseSource = manifest.outputDirectory, retained = [];
  const a = path.basename(manifest.routes.find(route => route.pattern === '/a').css[0]);
  const b = path.basename(manifest.routes.find(route => route.pattern === '/b').css[0]);
  const initialA = await readFile(path.join(baseSource, 'assets', a), 'utf8');
  await mkdir(path.join(baseSource, 'server/unrelated'), { recursive: true });
  const growJS = async (from, until) => {
    for (let index = from; index < until; index++) await writeFile(path.join(baseSource, 'server/unrelated', `${index}.mjs`), 'export default 1');
  };
  await growJS(0, 100);
  let sequence = 1, snapshots = 0;
  const update = async (file, content) => {
    await writeFile(path.join(root, file), content);
    const next = await tryDevCssUpdate({
      root, source: manifest.outputDirectory, baseSource,
      destination: path.join(root, `.prnext-style-overlay-${++sequence}`),
      manifest, changed: [file], sequence,
      snapshot() { snapshots++; throw new Error('A CSS overlay must not snapshot JavaScript'); },
    });
    assert.ok(next);
    manifest = next;
    retained.push(next.outputDirectory);
    while (retained.length > 3) await rm(retained.shift(), { recursive: true, force: true });
    assert.deepEqual((await readdir(next.outputDirectory)).sort(), ['assets', 'build-output.json', 'manifest.json']);
    return JSON.parse(await readFile(path.join(next.outputDirectory, 'assets', path.basename(next.devClient)), 'utf8'));
  };
  const first = await update('pages/a.css', 'h1{color:blue;background:url("./a.png")}');
  const aURL = first.pages.find(page => page.pattern === '/a').css[0];
  const modifiedA = await readFile(path.join(manifest.outputDirectory, 'assets', a));
  await assert.rejects(stat(path.join(manifest.outputDirectory, 'assets', b)), { code: 'ENOENT' });
  assert.match(await readFile(path.join(baseSource, 'assets', b), 'utf8'), /green|#008000/);
  await growJS(100, 1000);
  for (let index = 0; index < 5; index++) {
    const client = await update('pages/b.css', `h1{color:rgb(${index},2,3);background:url("./b${index}.png")}`);
    assert.equal(client.pages.find(page => page.pattern === '/a').css[0], aURL, 'an older tab can still request its unchanged A URL');
    assert.deepEqual(await readFile(path.join(manifest.outputDirectory, 'assets', a)), modifiedA);
    const assets = await readdir(path.join(manifest.outputDirectory, 'assets'));
    assert.equal(assets.length, 5, 'two CSS files, two live images and the current public manifest only');
    assert.ok(assets.some(name => name.startsWith('a-') && name.endsWith('.png')));
    assert.ok(assets.some(name => name.startsWith(`b${index}-`) && name.endsWith('.png')));
    assert.ok(!assets.some(name => /\.m?js$/.test(name)), 'no JavaScript artifact is copied at either project size');
    for (let previous = 0; previous < index; previous++) assert.ok(!assets.some(name => name.startsWith(`b${previous}-`)), 'removed URL assets do not accumulate');
  }
  assert.equal(snapshots, 0);
  assert.equal(retained.length, 3);
  assert.equal(await readFile(path.join(baseSource, 'assets', a), 'utf8'), initialA);
  assert.equal(manifest.devStyles.overlay.bundles.length, 2);
});
