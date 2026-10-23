import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {devFixture} from './dev-fixture.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {repositoryRoot,binary} from './support.mjs';

test('development skips offline artifacts and renders Pages data on demand without losing validation', {timeout: 45_000}, async t => {
  const observations = await mkdtemp(path.join(tmpdir(), 'prnext-dev-on-demand-'));
  const log = path.join(observations, 'calls.txt');
  const observe = `import {appendFileSync} from 'node:fs';const record=value=>appendFileSync(${JSON.stringify(log)},value+'\\n');`;
  const staticPage = value => `${observe}import {randomUUID} from 'node:crypto';export function getStaticProps(){record('props');return {props:{value:${value},nonce:randomUUID()}}}export default function Page({value,nonce}){return <p>static-{value}-{nonce}</p>}`;
  let fixture;
  t.after(async () => {await fixture?.close();await rm(observations,{recursive:true,force:true});});
  fixture = await devFixture({files:{
    'pages/static.jsx': staticPage(1),
    'pages/unvisited.jsx': `export default function Page(){throw new Error('Unvisited page rendered during compilation')}`,
    'pages/dynamic/[slug].jsx': `${observe}export function getStaticPaths(){record('paths');return {paths:[{params:{slug:'allowed'}}],fallback:false}}export function getStaticProps({params}){record('dynamic-props');return {props:params}}export default function Page({slug}){return <p>dynamic-{slug}</p>}`,
    'pages/500.jsx': `export function getStaticProps(){return {props:{label:'custom failure'}}}export default function Page({label}){return <h1>{label}</h1>}`,
  }});
  const calls = () => readFile(log,'utf8').catch(error => {if(error.code==='ENOENT')return '';throw error;});
  assert.equal(await calls(),'','compilation must not invoke any static data functions');
  const manifest = JSON.parse(await fixture.read('.prnext/manifest.json'));
  assert.equal(manifest.dev,true);
  assert.deepEqual(manifest.prerendered,[]);
  assert.ok(!manifest.routes.some(route=>route.pattern==='/static'),'unvisited routes must not be compiled');
  for (const directory of ['assets','static']) assert.ok(!(await readdir(path.join(fixture.root,'.prnext',directory),{recursive:true})).some(name=>/\.(br|gz)$/.test(name)),'offline compression is production-only');
  const get = route => fetch(fixture.url+'/docs'+route);
  const first = await (await get('/static')).text();
  assert.equal(JSON.parse(await fixture.read('.prnext/manifest.json')).routes.find(route=>route.pattern==='/static').ssg,true);
  const second = await (await get('/static')).text();
  assert.match(first,/static-<!-- -->1/);
  assert.notEqual(first,second,'getStaticProps must run for each development request');
  assert.equal(await calls(),'props\nprops\n');
  assert.equal((await get('/dynamic/allowed')).status,200);
  const denied = await get('/dynamic/denied');
  assert.equal(denied.status,404,'fallback:false must still reject paths absent from getStaticPaths');
  await denied.text();
  const customError = await get('/500');
  assert.equal(customError.status,500);
  assert.match(await customError.text(),/custom failure/,'custom static error pages still render without a build-time seed');
  assert.equal(await calls(),'props\nprops\npaths\ndynamic-props\npaths\n');

  async function waitState(predicate) {
    let state;
    for(let attempt=0;attempt<600;attempt++){
      state=await fixture.read('.prnext-dev.json').then(JSON.parse).catch(()=>({}));
      if(predicate(state))return state;
      await delay(25);
    }
    assert.fail('Development state did not settle: '+JSON.stringify(state)+'\n'+fixture.output());
  }
  const before = await fixture.read('.prnext-dev.json').then(JSON.parse);
  await fixture.write('pages/static.jsx',staticPage(2));
  await waitState(state=>state.state==='ready'&&state.buildId!==before.buildId);
  assert.equal(await calls(),'props\nprops\npaths\ndynamic-props\npaths\n','a save must not execute unrelated static data');
  assert.match(await (await get('/static')).text(),/static-<!-- -->2/);
  await fixture.write('pages/invalid.jsx','export function getStaticPaths(){return {paths:[],fallback:false}}export default function Page(){return null}');
  const invalid=await get('/invalid');
  assert.equal(invalid.status,500,'an unvisited invalid route is diagnosed when requested');
  await invalid.text();
  const error=await waitState(state=>state.state==='error');
  assert.match(error.error,/getStaticPaths without getStaticProps/);
  assert.equal((await get('/static')).status,200,'invalid exports must preserve the last successful application');
  await fixture.write('pages/invalid.jsx','export default function Page(){return <p>recovered</p>}');
  await waitState(state=>state.state==='ready');
  assert.match(await (await get('/invalid')).text(),/recovered/);
});


test('stable dev listener serves warm routes during edits and drains an old streaming generation', {timeout:45_000}, async t=>{
  const fixture=await devFixture({files:{'pages/api/slow.js':`import {existsSync} from 'node:fs';import path from 'node:path';export default function handler(req,res){res.writeHead(200,{'content-type':'text/plain'});res.write('before\\n');const interval=setInterval(()=>{if(existsSync(path.join(process.cwd(),'.release-stream'))){clearInterval(interval);clearTimeout(timeout);res.end('after\\n');}},25);const timeout=setTimeout(()=>{clearInterval(interval);res.end('timed out');},25000);res.once('close',()=>{clearInterval(interval);clearTimeout(timeout);});}`}});
  t.after(fixture.close);
  const stream=await fetch(fixture.url+'/docs/api/slow',{signal:AbortSignal.timeout(30000)});
  const before=JSON.parse(await fixture.read('.prnext-dev.json'));
  await fixture.write('components/Counter.jsx', (await fixture.read('components/Counter.jsx')).replace('Original','Stream updated'));
  let state;
  for(let i=0;i<800;i++){state=JSON.parse(await fixture.read('.prnext-dev.json'));if(state.state==='building')break;await delay(10);}
  const warm=await fetch(fixture.url+'/docs/pages',{signal:AbortSignal.timeout(3000)});assert.equal(warm.status,200);await warm.text();
  for(let i=0;i<800;i++){state=JSON.parse(await fixture.read('.prnext-dev.json'));if(state.state==='ready'&&state.buildId!==before.buildId)break;await delay(25);}
  assert.equal(state.state,'ready');assert.notEqual(state.buildId,before.buildId);assert.equal(state.listenerPid,before.listenerPid);
  await fixture.write('.release-stream','release');assert.equal(await stream.text(),'before\nafter\n');
  assert.match(await (await fetch(fixture.url+'/docs/pages')).text(),/Stream updated/);
});

test('middleware and rewrite graphs retain eager routing compatibility', {timeout:45_000},async t=>{
  const fixture=await devFixture({config:`export default{basePath:'/docs',async rewrites(){return [{source:'/alias',destination:'/cold'}]}}`,files:{'pages/cold.jsx':`export default function Cold(){return <h1>Rewrite destination</h1>}`}});t.after(fixture.close);
  const manifest=JSON.parse(await fixture.read('.prnext/manifest.json'));assert.ok(manifest.routes.some(route=>route.pattern==='/cold'));
  const response=await fetch(fixture.url+'/docs/alias');assert.equal(response.status,200);assert.match(await response.text(),/Rewrite destination/);
});


test('restarting development reuses disk transforms and rejects overlapping sessions', {timeout:45_000},async t=>{
  const fixture=await devFixture();let restarted;t.after(async()=>{if(restarted&&restarted.exitCode===null){restarted.kill('SIGTERM');await new Promise(resolve=>restarted.once('close',resolve));}await fixture.close();});
  const cli=path.join(repositoryRoot,'packages/prnext/cli.mjs');
  await assert.rejects(promisify(execFile)(process.execPath,[cli,'dev',fixture.root,'--port','0'],{env:{...process.env,PRNEXT_BINARY:binary}}),/development server is already running/);
  const before=JSON.parse(await fixture.read('.prnext-dev.json'));await fixture.stop();
  const port=new URL(fixture.url).port;let output='';restarted=spawn(process.execPath,[cli,'dev',fixture.root,'--port',port],{env:{...process.env,NODE_ENV:'development',PRNEXT_BINARY:binary},stdio:['ignore','pipe','pipe']});
  restarted.stdout.on('data',chunk=>{output+=chunk;});restarted.stderr.on('data',chunk=>{output+=chunk;});
  let ready=false;for(let i=0;i<300;i++){if(restarted.exitCode!==null)throw Error(output);try{const response=await fetch(fixture.url+'/docs/pages');await response.text();if(response.ok){ready=true;break;}}catch{}await delay(25);}
  assert.equal(ready,true,output);const after=JSON.parse(await fixture.read('.prnext-dev.json'));assert.notEqual(after.session,before.session);assert.ok(after.transforms.diskHits>0,'fresh compiler must read the persisted development transform cache');
});
