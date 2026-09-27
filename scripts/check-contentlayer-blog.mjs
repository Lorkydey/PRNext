// Exercise the downloaded tailwind-nextjs-starter-blog without changing it.
// Uses its installed dependencies, including the versioned Yarn patches.
import {cp,mkdtemp,symlink,readFile,writeFile,rm,appendFile} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {freePort,repositoryRoot,binary} from '../tests/support.mjs';

if(!process.argv[2])throw new Error('Usage: node scripts/check-contentlayer-blog.mjs /path/to/nextjs-test-blog');
const original=path.resolve(process.argv[2]);
const root=await mkdtemp(path.join(os.tmpdir(),'rustyx-contentlayer-check-'));
const log=path.join(os.tmpdir(),`rustyx-contentlayer-check-${process.pid}.log`);
const cli=path.join(repositoryRoot,'packages/prnext/cli.mjs');
const report={startupBuilds:{},productionRoutes:[],browserWarnings:[],exceptions:[]};
let child,browser,page,output='',writes=Promise.resolve();
const env={...process.env,PWD:repositoryRoot,INIT_CWD:repositoryRoot,PRNEXT_BINARY:binary};
const forbidden=/Critical dependency|DEP0040|Build failed|export .* was not found|module has no exports/;
async function newPage(mode) {
  const next=await browser.newPage();next.setDefaultTimeout(20000);
  next.on('pageerror',error=>report.exceptions.push({mode,message:error.message}));
  next.on('console',message=>{
    if(message.type()==='error')report.browserWarnings.push({mode,message:message.text()});
  });
  return next;
}
async function stop() {
  if(child?.exitCode===null){
    try{process.kill(-child.pid,'SIGTERM');}catch{}
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);
    try{process.kill(-child.pid,'SIGKILL');}catch{}
  }
  child=undefined;
}
function launch(command,port) {
  output='';
  child=spawn(process.execPath,[cli,command,root,'--port',String(port)],{
    cwd:repositoryRoot,detached:true,env,stdio:['ignore','pipe','pipe'],
  });
  const record=data=>{output=(output+data).slice(-100000);writes=writes.then(()=>appendFile(log,data));};
  child.stdout.on('data',record);child.stderr.on('data',record);
}
async function settled() {
  let stable=0,last='';
  for(let attempt=0;attempt<480;attempt++){
    if(child.exitCode!==null)throw new Error('dev exited: '+output);
    const state=await readFile(path.join(root,'.prnext-dev.json'),'utf8').then(JSON.parse).catch(()=>({}));
    if(state.state==='ready'&&state.buildId===last){if(++stable>=16)return;}else stable=0;
    last=state.state==='ready'?state.buildId:'';
    await delay(250);
  }
  throw new Error('dev did not settle: '+output);
}
try {
  await cp(original,root,{recursive:true,filter:src=>!path.relative(original,src).split(path.sep).some(part=>
    ['node_modules','.git','.yarn','.next','.contentlayer'].includes(part)||part.startsWith('.prnext')||part.startsWith('.env'))});
  await symlink(path.join(original,'node_modules'),path.join(root,'node_modules'));
  await writeFile(log,'');
  const port=await freePort(),url=`http://127.0.0.1:${port}`;
  console.log(JSON.stringify({temporaryProject:root,log,url}));
  for(const kind of ['cold','warm']){
    launch('dev',port);await settled();
    report.startupBuilds[kind]=(output.match(/PRNext built /g)||[]).length;
    assert.equal(report.startupBuilds[kind],1,`${kind} startup must compile once`);
    assert.doesNotMatch(output,forbidden);
    console.log(`${kind} startup: one build, no startup warnings`);
    if(kind==='cold')await stop();
  }
  browser=await chromium.launch({headless:true});
  page=await newPage('development');
  // The theme must be applied by the original SSR script before React loads.
  // Removing that script to hide a warning would introduce a theme flash.
  await page.addInitScript(()=>localStorage.setItem('theme','dark'));
  let releaseScripts;
  const scriptsReady=new Promise(resolve=>{releaseScripts=resolve;});
  await page.route('**/_prnext/assets/*.js',async route=>{
    await scriptsReady;
    await route.continue().catch(error=>report.exceptions.push({mode:'diagnostic',message:error.message}));
  });
  try {
    assert.equal((await page.goto(url,{waitUntil:'commit'})).status(),200);
    await expect(page.locator('html')).toHaveClass(/dark/);
  } finally {
    releaseScripts();
  }
  await expect(page.getByRole('heading',{level:1})).toHaveText('Latest');
  await page.waitForFunction(()=>globalThis.__PRNEXT_DEV__?.modules.has('data/siteMetadata.js'));
  await page.getByRole('button',{name:'Theme switcher'}).click();
  await page.getByRole('menuitem',{name:'Dark',exact:true}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.evaluate(()=>window.__prnextSmoke='preserved');
  await page.getByRole('link',{name:'Blog',exact:true}).first().click();
  await expect(page.getByRole('heading',{level:3,name:'All Posts',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.__prnextSmoke),'preserved');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Toggle Menu',exact:true}).first().click();
  await expect(page.getByRole('dialog').getByRole('link',{name:'Home',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Toggle Menu',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('link',{name:'Home',exact:true})).toBeHidden();
  await page.setViewportSize({width:1280,height:720});
  assert.deepEqual(report.browserWarnings,[],'initial hydration and interactions must be clean');
  console.log('Hydration, theme, client navigation and mobile menu passed');
  await page.goto(url);
  const main=path.join(root,'app/Main.tsx');
  await writeFile(main,(await readFile(main,'utf8')).replace('Latest','Contentlayer dev update'));
  await expect(page.getByRole('heading',{level:1})).toHaveText('Contentlayer dev update',{timeout:90000});
  await expect(page.locator('html')).toHaveClass(/dark/);
  const metadata=path.join(root,'data/siteMetadata.js');
  await writeFile(metadata,(await readFile(metadata,'utf8')).replace("title: 'Next.js Starter Blog'","title: 'PRNext metadata updated'"));
  await expect(page).toHaveTitle('PRNext metadata updated',{timeout:90000});
  const mdx=path.join(root,'data/blog/guide-to-using-images-in-nextjs.mdx');
  await writeFile(mdx,(await readFile(mdx,'utf8'))+'\n\nContentlayer live MDX verification.\n');
  await page.goto(url+'/blog/guide-to-using-images-in-nextjs/');
  await expect(page.getByText('Contentlayer live MDX verification.',{exact:true})).toBeVisible({timeout:90000});
  await settled();
  assert.doesNotMatch(output,forbidden);
  assert.deepEqual(report.browserWarnings,[],'hot updates must keep the browser console clean');
  console.log('TSX, CommonJS metadata and MDX hot updates passed');

  // Invalid generator configuration must fail clearly and preserve the last
  // working HTTP server. Recovery must require only fixing that source file.
  const configuration=path.join(root,'contentlayer.config.ts');
  const valid=await readFile(configuration,'utf8');
  await writeFile(configuration,valid+'\nconst = invalid syntax;\n');
  let failure;
  for(let attempt=0;attempt<240;attempt++){
    const state=await readFile(path.join(root,'.prnext-dev.json'),'utf8').then(JSON.parse).catch(()=>({}));
    if(state.state==='error'){failure=state;break;}await delay(250);
  }
  assert.equal(failure?.state,'error','invalid Contentlayer config must report a build error');
  assert.equal((await fetch(url)).status,200,'previous valid server survives failed compilation');
  await writeFile(configuration,valid);await settled();
  console.log('Contentlayer error reporting and recovery passed');
  await page.close();
  await stop();

  const built=await promisify(execFile)(process.execPath,[cli,'build',root],{cwd:repositoryRoot,env,timeout:120000,maxBuffer:4*1024*1024});
  await appendFile(log,built.stdout+built.stderr);assert.doesNotMatch(built.stdout+built.stderr,forbidden);
  launch('start',port);
  let listening=false;
  for(let attempt=0;attempt<200;attempt++){
    try{if((await fetch(url)).ok){listening=true;break;}}catch{}await delay(100);
  }
  assert.ok(listening,'production server must start');
  page=await newPage('production');
  for(const route of ['/','/blog/','/tags/','/projects/','/about/','/blog/guide-to-using-images-in-nextjs/','/blog/new-features-in-v1/']){
    const response=await page.goto(url+route);assert.equal(response.status(),200,route);
    await page.waitForLoadState('networkidle');
    report.productionRoutes.push({route,status:response.status()});
  }
  assert.deepEqual(report.exceptions,[]);
  assert.deepEqual(report.browserWarnings.filter(item=>item.mode==='production'),[]);
  console.log('Production: seven HTTP 200 pages, zero browser exceptions or console errors');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(error.stack);console.error(output.slice(-12000));process.exitCode=1;
} finally {
  await browser?.close();await stop();await writes;await rm(root,{recursive:true,force:true});
  console.log(`Temporary app and processes removed. Diagnostic log: ${log}`);
}
