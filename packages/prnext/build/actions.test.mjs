import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from './index.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServerActions } from './actions.mjs';
import {transformCacheStats} from './transform-cache.mjs';
import { encryptBoundArgs, decryptBoundArgs } from '../runtime/action-crypto.mjs';
import { runRequestContext } from '../compat/headers.cjs';

const execute=promisify(execFile);
const repo=fileURLToPath(new URL('../../../',import.meta.url));
test('incremental action analysis reuses templates but refreshes IDs and keys for each build',()=>{
  const source=`'use server';export async function save(value){return value+1}`;
  const first=createServerActions({projectRoot:'/project'}),second=createServerActions({projectRoot:'/project'});
  const old=first.transform(source,'/project/shared-actions.js','rsc');const hits=transformCacheStats().hits;
  const next=second.transform(source,'/project/shared-actions.js','rsc');
  assert.ok(transformCacheStats().hits>hits);assert.notEqual(first.actionKey,second.actionKey);
  const oldId=[...first.actions.keys()][0],nextId=[...second.actions.keys()][0];
  assert.notEqual(oldId,nextId);assert.ok(old.includes(oldId));assert.ok(next.includes(nextId));assert.ok(!next.includes(oldId));
  assert.ok(second.transform(source,'/project/shared-actions.js','browser').includes(nextId));
});
async function fixture(files,run) {
  const root=await mkdtemp(path.join(repo,'.prnext-actions-'));
  try { for(const [file,source] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);} await run(root); }
  finally {await rm(root,{recursive:true,force:true});}
}

test('wildcard Server Action barrels compile into callable server entries and private client proxies', async () => {
  await fixture({
    'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/page.jsx': `import Client from './client';export * from './actions';export default()=> <Client/>`,
    'app/client.jsx': `'use client';import {useState} from 'react';import {save,second} from './actions';export default()=> <form action={save}><button formAction={second}>Save</button></form>`,
    'app/actions.ts': `'use server';export * from './first';export * from './second.mts';export {save as alias} from './first';export type * from './types';`,
    'app/first.ts': `const secret='WILDCARD_SERVER_SECRET';export async function save(value){return secret+':'+value};export default async()=> 'default excluded';`,
    'app/second.mts': `export async function second(value: number){return 'second:'+value}`,
    'app/types.ts': `export interface Value {id:string}`,
  }, async root => {
    const built = await build(root);
    assert.equal(Object.keys(built.app.actions).length, 3);
    const route = built.routes.find(route => route.pattern === '/');
    const moduleUrl = pathToFileURL(path.join(built.outputDirectory, route.module)).href;
    const script = `import {page} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify({a:await page.save(2),b:await page.second(3),alias:await page.alias(4),id:page.save.$$id}));`;
    const { stdout } = await execute(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', script], { cwd: root, env: { ...process.env, NODE_ENV: 'production' } });
    assert.deepEqual(JSON.parse(stdout), { a: 'WILDCARD_SERVER_SECRET:2', b: 'second:3', alias: 'WILDCARD_SERVER_SECRET:4', id: JSON.parse(stdout).id });
    assert.ok(built.app.actions[JSON.parse(stdout).id]);
    for (const file of await readdir(path.join(built.outputDirectory, 'assets'))) if (file.endsWith('.js')) assert.doesNotMatch(await readFile(path.join(built.outputDirectory, 'assets', file), 'utf8'), /WILDCARD_SERVER_SECRET/);
  });
});

test('closure encryption preserves rich values and rejects tampering, another action and another key',async()=>{
  const actionKey=randomBytes(32).toString('base64');
  await runRequestContext({actionKey},async()=>{
    const value={secret:'CLOSURE_SECRET_NEVER_PLAINTEXT',date:new Date('2026-01-02T00:00:00Z'),map:new Map([['answer',42n]]),set:new Set(['a']),future:Promise.resolve({value:'resolved'}),bytes:new Uint8Array([1,2,3]),symbol:Symbol.for('shared')};
    value.self=value;
    const data=new FormData();data.append('name','Ada');data.append('upload',new File(['contents'],'note.txt',{type:'text/plain'}));value.form=data;
    const cipher=await encryptBoundArgs('first',[value]);
    assert.ok(!cipher.includes(value.secret));
    const [restored]=await decryptBoundArgs('first',cipher);
    assert.equal(restored.self,restored);
    assert.equal(restored.date.toISOString(),value.date.toISOString());
    assert.equal(restored.map.get('answer'),42n);
    assert.deepEqual([...restored.set],['a']);
    assert.ok(restored.future instanceof Promise);
    assert.deepEqual(await restored.future,{value:'resolved'});
    assert.deepEqual([...restored.bytes],[1,2,3]);
    assert.equal(restored.symbol,Symbol.for('shared'));
    assert.equal(restored.form.get('name'),'Ada');
    assert.equal(restored.form.get('upload').name,'note.txt');
    assert.equal(await restored.form.get('upload').text(),'contents');
    const changed=Buffer.from(cipher.slice(3),'base64url');changed[changed.length-1]^=1;
    await assert.rejects(decryptBoundArgs('first','v1.'+changed.toString('base64url')),/Invalid encrypted/);
    await assert.rejects(decryptBoundArgs('second',cipher),/Invalid encrypted/);
    await runRequestContext({actionKey:randomBytes(32).toString('base64')},()=>assert.rejects(decryptBoundArgs('first',cipher),/Invalid encrypted/));
    await assert.rejects(encryptBoundArgs('first',[()=>null]),/cannot capture functions/);
    await assert.rejects(encryptBoundArgs('first',[Promise.resolve(()=>null)]),/cannot capture functions/);
    await assert.rejects(encryptBoundArgs('first',[new URL('https://example.com')]),/plain objects/);
  });
});

test('server module proxies share opaque IDs with actual registrations and reject nonasync exports',()=>{
  const compiler=createServerActions({projectRoot:repo});
  const source=`'use server';const secret='MODULE_PRIVATE_SENTINEL';export async function save(value){return secret+value} export {save as alias};export default async function remove(){return true}`;
  const file=path.join(repo,'app/actions.ts');
  const real=compiler.transform(source,file,'rsc');
  const browser=compiler.transform(source,file,'browser');
  const ssr=compiler.transform(source,file,'ssr');
  assert.equal(compiler.actions.size,3);
  for(const id of compiler.actions.keys()) {
    assert.match(id,/^[a-f0-9]{64}$/);
    assert.ok(real.includes(id)&&browser.includes(id)&&ssr.includes(id));
  }
  assert.ok(!browser.includes('MODULE_PRIVATE_SENTINEL')&&!ssr.includes('MODULE_PRIVATE_SENTINEL'));
  const other=createServerActions({projectRoot:repo});other.transform(source,file,'rsc');
  assert.notDeepEqual([...compiler.actions.keys()],[...other.actions.keys()],'action IDs change with the build');
  assert.throws(()=>compiler.transform(`'use server';export const secret='not an action';`,file+'.invalid','rsc'),/must be an async function/);
  assert.throws(()=>compiler.transform(`'use server';export function sync(){return 1}`,file+'.sync','rsc'),/must be an async function/);
});

test('compiled inline actions preserve hoisting and closures, share server state, and emit encrypted Flight references',async()=>{
  await fixture({
    'app/layout.tsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/actions.ts': `'use server';import 'server-only';let count=0;const secret='MODULE_SECRET_MUST_STAY_SERVER';export async function increment(){if(!secret)throw new Error('secret');return ++count;}`,
    'app/client.tsx': `'use client';export {increment} from './actions';export default function Client(){return <p>Client</p>}`,
    'app/page.tsx': `import Client from './client';import {increment} from './actions';export {increment} from './actions';export default async function Page(){const record={token:'INLINE_SECRET_MUST_STAY_SERVER',amount:7};const initial=await increment();const form=<form action={save}><input name="value"/></form>;async function save(data:FormData){'use server';return {token:record.token,value:record.amount+Number(data.get('value')),initial};}async function nested(data:FormData){'use server';return save(data)}return <main>{form}<form action={nested}/><Client/></main>}`,
  },async root=>{
    const built=await build(root);
    assert.equal(Object.keys(built.app.actions).length,3);
    const files=await readdir(path.join(built.outputDirectory,'assets'));
    const browser=(await Promise.all(files.filter(file=>file.endsWith('.js')).map(file=>readFile(path.join(built.outputDirectory,'assets',file),'utf8')))).join('\n');
    for(const value of ['MODULE_SECRET_MUST_STAY_SERVER','INLINE_SECRET_MUST_STAY_SERVER',built.app.actionKey]) assert.ok(!browser.includes(value));
    const route=built.routes.find(route=>route.pattern==='/');
    const stageUrl=file=>pathToFileURL(path.join(built.outputDirectory,file)).href;
    const script=`import React from 'react';import {renderToReadableStream} from 'react-server-dom-webpack/server.node';import {runRequestContext} from ${JSON.stringify(stageUrl('compat/headers.cjs'))};import * as page from ${JSON.stringify(stageUrl(route.module))};const manifest=${JSON.stringify(built.app)};await runRequestContext({actionKey:manifest.actionKey,actions:manifest.actions,distDir:${JSON.stringify(built.outputDirectory)}},async()=>{const tree=await page.page.default();const reference=tree.props.children[0].props.action;const cipher=await reference.$$bound[0];const target=manifest.actions[reference.$$id];const action=await import(new URL('../'+target.module,${JSON.stringify(stageUrl('runtime/worker.mjs'))}));const form=new FormData();form.set('value','5');const value=await action.invoke(cipher,form);const direct=await reference(form);const flight=await new Response(renderToReadableStream(tree,manifest.clientModules)).text();const nested=tree.props.children[1].props.action;const nestedTarget=await import(new URL('../'+manifest.actions[nested.$$id].module,${JSON.stringify(stageUrl('runtime/worker.mjs'))}));const nestedValue=await nestedTarget.invoke(await nested.$$bound[0],form);const other=manifest.actions[page.page.increment.$$id];const counter=await import(new URL('../'+other.module,${JSON.stringify(stageUrl('runtime/worker.mjs'))}));process.stdout.write(JSON.stringify({value,direct,nestedValue,next:await counter.invoke(),flight,cipher,id:reference.$$id,moduleId:page.page.increment.$$id}));});`;
    const {stdout}=await execute(process.execPath,['--conditions=react-server','--input-type=module','-e',script],{cwd:root,env:{...process.env,NODE_ENV:'production'}});
    const output=JSON.parse(stdout);
    assert.deepEqual(output.value,{token:'INLINE_SECRET_MUST_STAY_SERVER',value:12,initial:1});
    assert.deepEqual(output.nestedValue,output.value,'encrypted closures can capture another registered Server Action');
    assert.deepEqual(output.direct,output.value,'direct server invocation uses the original lexical closure');
    assert.equal(output.next,2,'action and page graphs share one module singleton');
    assert.ok(output.flight.includes(output.id));
    assert.ok(output.flight.includes(output.cipher));
    assert.ok(!output.flight.includes('INLINE_SECRET_MUST_STAY_SERVER'));
    const namespaces=await Promise.all(Object.values(built.app.clientModules).map(client=>import(stageUrl(client.ssrModule))));
    const namespace=namespaces.find(client=>typeof client.increment==='function');
    assert.ok(namespace,'the application client boundary exposes its action proxy');
    assert.equal(typeof namespace.increment,'function');
    // React serializes the SSR proxy as the same server reference ID seen in the
    // executable action table, instead of exposing its module implementation.
    assert.ok(Object.keys(built.app.actions).some(id=>browser.includes(id)));
    const html=renderToStaticMarkup(React.createElement('form',{action:namespace.increment}));
    assert.ok(html.includes('$ACTION_ID_'+output.moduleId),'SSR form proxy and actual module use the same action ID');
  });
});

test('module-local actions returned directly or bound survive Flight and invoke their allowlisted exports',async()=>{
  await fixture({
    'app/layout.tsx':`export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/page.tsx':`export * from './actions';export {default as chooseDefault} from './actions';export {upstream} from './other';export default function Page(){return null;}`,
    'app/other.ts':`'use server';export async function upstream(value){return 'upstream:'+value;}`,
    'app/actions.ts':`'use server';import {upstream} from './other';let count=0;export async function save(step,label){count+=step;return {count,label};}export {save as alias};export const saveConst=async(step,label)=>{count+=step;return {count,label};};export async function chooseConst(){return saveConst.bind(null,1);}export async function choose(){return save;}export async function chooseBound(){return save.bind(null,2);}export default async function chooseDefault(){return save;}export {upstream as reexported};export async function chooseReexport(){return upstream;}`,
  },async root=>{
    const built=await build(root);
    const route=built.routes.find(route=>route.pattern==='/');
    const moduleUrl=pathToFileURL(path.join(built.outputDirectory,route.module)).href;
    const script=`import {renderToReadableStream} from 'react-server-dom-webpack/server.node';import {page} from ${JSON.stringify(moduleUrl)};const model={returned:await page.choose(),bound:await page.chooseBound(),defaultRef:await page.chooseDefault(),aliased:page.alias,constRef:await page.chooseConst(),fromReexport:await page.chooseReexport()};const flight=await new Response(renderToReadableStream(model,{})).text();process.stdout.write(JSON.stringify({flight,ids:{save:page.save.$$id,alias:page.alias.$$id,saveConst:page.saveConst.$$id,upstream:page.upstream.$$id}}));`;
    const {stdout}=await execute(process.execPath,['--conditions=react-server','--input-type=module','-e',script],{cwd:root,env:{...process.env,NODE_ENV:'production'}});
    const output=JSON.parse(stdout);
    const {installFlightModuleLoader}=await import('../runtime/app-client.mjs');
    installFlightModuleLoader({});
    const {createFromReadableStream}=await import('react-server-dom-webpack/client.browser');
    const calls=[];
    const decoded=await createFromReadableStream(new Response(output.flight).body,{callServer(id,args){calls.push({id,args});return Promise.resolve();}});
    await decoded.returned(3,'first');
    await decoded.bound('second');
    await decoded.aliased(4,'alias');
    await decoded.defaultRef(1,'default');
    await decoded.constRef('const');
    await decoded.fromReexport('kept');
    assert.deepEqual(calls.map(call=>call.id),[output.ids.save,output.ids.save,output.ids.alias,output.ids.save,output.ids.saveConst,output.ids.upstream]);
    assert.deepEqual(calls[1].args,[2,'second'],'the internal callable keeps React’s patched bind metadata');
    const invoke=`const manifest=${JSON.stringify(built.app.actions)};const calls=${JSON.stringify(calls)};const results=[];for(const {id,args} of calls){const action=manifest[id];if(!action)throw new Error('Unknown action');const namespace=await import(new URL(action.module,${JSON.stringify(pathToFileURL(built.outputDirectory+path.sep).href)}));results.push(await namespace[action.export](...args));}process.stdout.write(JSON.stringify(results));`;
    const result=await execute(process.execPath,['--conditions=react-server','--input-type=module','-e',invoke],{cwd:root,env:{...process.env,NODE_ENV:'production'}});
    assert.deepEqual(JSON.parse(result.stdout),[{count:3,label:'first'},{count:5,label:'second'},{count:9,label:'alias'},{count:10,label:'default'},{count:11,label:'const'},'upstream:kept']);
  });
});
