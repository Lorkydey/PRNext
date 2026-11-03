import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from '../packages/prnext/build/index.mjs';
import {routeCssFiles} from './route-css-fixture.mjs';
import {repositoryRoot,startServer} from './support.mjs';

test('parallel App style emission preserves CSS scopes/modules/assets and Actions, and drains failed writes before discarding its stage',async t=>{
  const root=await fs.mkdtemp(path.join(repositoryRoot,'.prnext-parallel-styles-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const config=enabled=>`export default{generateBuildId:()=> 'parallel-style-parity',deploymentRetention:false,experimental:{parallelBuilds:${enabled?'{maxWorkers:4,maxMemoryMb:1024}':'false'}}}`;
  const files={...routeCssFiles({parallel:true,interception:true}),
    'prnext.config.mjs':config(false),
    'components/shared.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="red" d="M0 0h2v2H0z"/></svg>',
    'components/shared.module.css':'.asset{--shared-asset:1;background-image:url("./shared.svg")}',
    'components/Shared.jsx':`'use client';import styles from './shared.module.css';export default function Shared(){return <span className={styles.asset}>Shared asset</span>}`,
    'app/b/actions.js':`'use server';export async function save(){return 'parallel-action-ok'}`,
    'app/b/page.jsx':`import './page.css';import Shared from '../../components/Shared';import{save}from './actions';export const dynamic='force-dynamic';export default()=> <main data-page="b"><h1>Page B</h1><Shared/><form action={save}><button>Save</button></form></main>`,
    'app/c/page.jsx':`import './page.css';import Shared from '../../components/Shared';export const dynamic='force-dynamic';export default()=> <main data-page="c"><Shared/></main>`,
  };
  // The shared routing fixture opts into custom PostCSS. Exercise native CSS
  // parallelism here, and prove the custom-pipeline serial fallback below.
  delete files['postcss.config.json'];
  for(const name of ['a','b'])files[`app/${name}/page.css`]+=`main[data-page="${name}"]{--shared-global-asset:1;background-image:url("../../components/shared.svg")}`;
  for(const[name,source]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),source);}
  const snapshot=async built=>{
    const contents=async urls=>Promise.all((urls||[]).map(url=>fs.readFile(path.join(built.outputDirectory,'assets',path.basename(url)),'utf8')));
    const routes=await Promise.all(built.routes.filter(route=>!route.internal).map(async route=>({pattern:route.pattern,css:await contents(route.css),scopes:await Promise.all((route.cssScopes||[]).map(async scope=>({...scope,css:await contents(scope.css)})))})));
    const assets=(await fs.readdir(path.join(built.outputDirectory,'assets'))).filter(name=>name.endsWith('.svg'));
    assert.equal(assets.length,1,'the shared CSS asset has one owner');
    assert.equal(Object.keys(built.app.actions).length,1);
    const assetSha=createHash('sha256').update(await fs.readFile(path.join(built.outputDirectory,'assets',assets[0]))).digest('hex');
    let server;
    try{
      server=await startServer(root);
      const response=await fetch(server.url+'/b',{method:'POST',headers:{'Next-Action':Object.keys(built.app.actions)[0],origin:server.url,'content-type':'text/plain'},body:'[]'});
      assert.equal(response.status,200);assert.match(await response.text(),/parallel-action-ok/);
    }finally{await server?.close();}
    return {routes,assetSha};
  };
  const serial=await build(root);assert.equal(serial.buildParallelism,undefined);
  const expected=await snapshot(serial);
  await fs.writeFile(path.join(root,'prnext.config.mjs'),config(true));
  const parallel=await build(root);
  assert.ok(parallel.buildParallelism.jobs>=4);assert.ok(parallel.buildParallelism.concurrency>=1&&parallel.buildParallelism.concurrency<=4);
  const actual=await snapshot(parallel);assert.deepEqual(actual,expected);
  const a=actual.routes.find(route=>route.pattern==='/a'),b=actual.routes.find(route=>route.pattern==='/b');
  assert.ok(a.scopes.length>1);assert.match(a.css.join('\n'),/--page-a|--client-a|--layout-proof/);
  assert.doesNotMatch(a.css.join('\n'),/--page-b|--page-c|--shared-asset/);
  assert.match(b.css.join('\n'),/--shared-asset/);

  const published=await fs.readFile(path.join(root,'.prnext/manifest.json'));
  const write=fs.writeFile;let started=0,active=0,finished=0;
  fs.writeFile=async function(file,...args){
    if(typeof file!=='string'||!file.startsWith(root+path.sep)||!/[\\/]\.entries[\\/]app-style-[^\\/]+\.mjs$/.test(file))return write(file,...args);
    const index=++started;active++;
    try{if(index===2)throw Error('controlled style emission failure');await write(file,...args);finished++;}
    finally{active--;}
  };
  syncBuiltinESMExports();
  try{await assert.rejects(build(root),/controlled style emission failure/);}
  finally{fs.writeFile=write;syncBuiltinESMExports();}
  assert.ok(started>=2);assert.ok(finished>=1);assert.equal(active,0,'all started emissions settle before build rejection');
  assert.deepEqual(await fs.readFile(path.join(root,'.prnext/manifest.json')),published,'failed build preserves the published generation');
  assert.deepEqual((await fs.readdir(root)).filter(name=>/^\.prnext-(?:build|backup)-/.test(name)),[],'failed private stages leave no later writers behind');

  await fs.writeFile(path.join(root,'postcss.config.json'),'{"plugins":[]}');
  const customFallback=await build(root);
  assert.equal(customFallback.buildParallelism,undefined,'unproven custom PostCSS hooks keep serial emission even when requested');
  const customActual=await snapshot(customFallback);
  await fs.writeFile(path.join(root,'prnext.config.mjs'),config(false));
  const customSerial=await build(root);
  assert.deepEqual(await snapshot(customSerial),customActual,'custom CSS scopes, module mappings, assets and Actions retain their serial semantics');
});
