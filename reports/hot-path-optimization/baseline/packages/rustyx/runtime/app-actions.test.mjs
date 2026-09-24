import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeReply, createServerReference } from 'react-server-dom-webpack/client.node';
import { renderAppPage, decodeFlight, closeAppRuntime, renderFlight } from './app-render.mjs';

const directories = [];
after(async () => {
  await closeAppRuntime();
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const distDir = await mkdtemp(fileURLToPath(new URL('./.app-actions-', import.meta.url)));
  directories.push(distDir);
  await writeFile(path.join(distDir, 'state.mjs'), `export const state={count:0,calls:0};`);
  await writeFile(path.join(distDir, 'actions.mjs'), `
    import {registerServerReference} from 'react-server-dom-webpack/server.node';
    import {cookies} from '../../compat/headers.cjs';
    import {redirect,notFound} from '../../compat/navigation.cjs';
    import {loadActionReference} from '../action-reference.mjs';
    import {state} from './state.mjs';
    import {writeFileSync} from 'node:fs';
    export async function add(value){state.calls++;state.count+=Number(value);(await cookies()).set('count',String(state.count));return {count:state.count,date:new Date('2026-02-03T00:00:00Z'),map:new Map([['calls',state.calls]])};}
    export async function form(data){return add(data.get('delta'));}
    export async function stateAction(previous,data){await add(data.get('delta'));return previous+Number(data.get('delta'));}
    export async function invoke(reference){return reference();}
    export async function fail(){state.calls++;throw new Error('PRIVATE_ACTION_DETAILS');}
    export async function go(){await add(1);redirect('/destination');}
    export async function hang(){writeFileSync(new URL('./hang-started',import.meta.url),'yes');await new Promise(()=>{});}
    export async function missing(){state.calls++;notFound();}
    export async function nested(){return(await loadActionReference('add',[3]))();}
    export async function unsafe(){state.count=999;return 'private export';}
    for(const [id,fn] of Object.entries({add,form,stateAction,invoke,fail,go,hang,missing,nested}))registerServerReference(fn,id,null);
  `);
  await writeFile(path.join(distDir, 'page.mjs'), `
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    import {cookies,headers} from '../../compat/headers.cjs';
    import {state} from './state.mjs';
    import {form} from './actions.mjs';
    const StateForm=registerClientReference(()=>{},'state-ui','default');
    const Broken=registerClientReference(()=>{},'broken-ui','default');
    export const page={default:async({searchParams})=>{
      const read=(await cookies()).get('count')?.value||'none';
      let readonly=false;try{(await cookies()).set('leaked','bad')}catch{readonly=true}
      return React.createElement('main',null,(await headers()).get('x-break-after-action')?React.createElement(Broken):null,React.createElement('p',{'data-count':state.count,'data-calls':state.calls,'data-cookie':read,'data-readonly':readonly},'Current'),
        (await searchParams).state?React.createElement(StateForm):React.createElement('form',{action:form},React.createElement('input',{name:'delta',defaultValue:'1'}),React.createElement('button',null,'Add')));
    }};
    export const segments=[{segment:'',path:'',notFound:{default:()=>React.createElement('h1',null,'Action not found')},layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `);
  await writeFile(path.join(distDir, 'state-ui.mjs'), `
    import React from 'react';
    import {createServerReference} from '../action-ssr.mjs';
    const action=createServerReference('stateAction');
    export default function StateForm(){const[state,formAction]=React.useActionState(action,0);return React.createElement('form',{action:formAction},React.createElement('output',null,state),React.createElement('input',{name:'delta',defaultValue:'1'}),React.createElement('button',null,'State'));}
  `);
  await writeFile(path.join(distDir, 'broken-ui.mjs'), `export default function Broken(){throw new Error('Client HTML failed after action')}`);
  const actions = Object.fromEntries(['add', 'form', 'stateAction', 'invoke', 'fail', 'go', 'hang', 'missing', 'nested'].map(id => [id, { module: 'actions.mjs', export: id }]));
  return { modulePath: path.join(distDir, 'page.mjs'), distDir, url: 'http://localhost/actions', production: true,
    manifest: { app: { actions, actionKey: Buffer.alloc(32, 7).toString('base64'), clientModules: {
      'state-ui': { ssrModule: 'state-ui.mjs', browserModule: '/state-ui.js' },
      'broken-ui': { ssrModule: 'broken-ui.mjs', browserModule: '/broken-ui.js' },
    } } } };
}

async function encoded(body) {
  const response = new Response(body);
  return { body: Buffer.from(await response.arrayBuffer()).toString('base64'), contentType: response.headers.get('content-type') || 'text/plain' };
}

async function rpc(options, id, args) {
  const data = await encoded(await encodeReply(args));
  return renderAppPage({ ...options, method: 'POST', body: data.body,
    headers: { 'next-action': id, 'content-type': data.contentType, rsc: '1' } });
}

async function model(options, response) {
  return decodeFlight(response.body, options.manifest.app.clientModules, options.distDir);
}

const unescape = text => text.replace(/&(?:amp|quot|lt|gt|#x27);/g, value => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#x27;': "'" })[value]);
function htmlForm(html) {
  const data = new FormData();
  for (const [element] of html.matchAll(/<input\b[^>]*>/g)) {
    const attributes = Object.fromEntries([...element.matchAll(/([^\s=]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));
    if (attributes.name) data.append(attributes.name, attributes.value || '');
  }
  return data;
}

test('RPC actions return official rich Flight values, update the tree and isolate mutable cookies', async () => {
  const options = await fixture();
  options.route = { css: ['/resources/_rustyx/actions.css'] };
  const response = await rpc(options, 'add', [3]);
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /^count=3;/);
  const value = await model(options, response);
  assert.deepEqual(value.css, options.route.css, 'the action keeps the styles of its updated route model');
  assert.equal(value.actionResult.count, 3);
  assert.equal(value.actionResult.map.get('calls'), 1);
  assert.equal(value.actionResult.date.toISOString(), '2026-02-03T00:00:00.000Z');
  assert.match(response.body.toString(), /"data-count":3/);
  assert.match(response.body.toString(), /"data-cookie":"3"/);
  assert.match(response.body.toString(), /"data-readonly":true/);
  assert.ok(!response.body.toString().includes(options.manifest.app.actionKey));
});

test('actions on force-static routes retain caller headers and cookies while their rerender stays empty', async () => {
  const options = { ...await fixture(), route: { cacheConfig: { dynamic: 'force-static' } } };
  await writeFile(path.join(options.distDir, 'scope.mjs'), `
    import {headers,cookies} from '../../compat/headers.cjs';
    export async function scope(){const jar=await cookies();const count=jar.get('count')?.value;jar.set('observed',count);return {count,marker:(await headers()).get('x-marker')}};
  `);
  options.manifest.app.actions.scope = { module: 'scope.mjs', export: 'scope' };
  const data = await encoded(await encodeReply([]));
  const response = await renderAppPage({ ...options, method: 'POST', body: data.body,
    headers: { 'next-action': 'scope', 'content-type': data.contentType, rsc: '1', cookie: 'count=9', 'x-marker': 'caller-private' } });
  const value = await model(options, response);
  assert.deepEqual(value.actionResult, { count: '9', marker: 'caller-private' });
  assert.match(response.headers['set-cookie'][0], /^observed=9;/);
  assert.match(response.body.toString(), /"data-cookie":"none"/);
});

test('native form POST executes a registered action once and returns hydrated HTML', async () => {
  const options = await fixture();
  const initial = await renderAppPage(options);
  const fields = htmlForm(initial.body.toString());
  assert.ok([...fields.keys()].some(key => key === '$ACTION_ID_form'));
  fields.set('delta', '4');
  const payload = await encoded(fields);
  const response = await renderAppPage({ ...options, method: 'POST', body: payload.body, headers: { 'content-type': payload.contentType } });
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /data-count="4" data-calls="1"/);
  assert.match(response.body.toString(), /data-cookie="4"/);
  assert.match(response.body.toString(), /id="__RUSTYX_FLIGHT__"/);
});

test('useActionState preserves native form state and progressively enhances repeated submissions', async () => {
  const options = { ...await fixture(), url: 'http://localhost/actions?state=1' };
  let response = await renderAppPage(options);
  for (const [delta, expected, calls] of [[5, 5, 1], [2, 7, 2]]) {
    const fields = htmlForm(response.body.toString());
    assert.ok(fields.has('$ACTION_KEY'));
    fields.set('delta', String(delta));
    const payload = await encoded(fields);
    response = await renderAppPage({ ...options, method: 'POST', body: payload.body, headers: { 'content-type': payload.contentType } });
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), new RegExp('<output>' + expected + '</output>'));
    assert.match(response.body.toString(), new RegExp('data-calls="' + calls + '"'));
  }
});

test('registered bound references decode but inherited IDs and fabricated module exports cannot run', async () => {
  const options = await fixture();
  const valid = await rpc(options, 'invoke', [createServerReference('add').bind(null, 2)]);
  assert.equal(valid.status, 200);
  assert.equal((await model(options, valid)).actionResult.count, 2);
  for (const id of ['__proto__', 'constructor', 'toString', 'add#unsafe']) {
    assert.equal((await rpc(options, id, [])).status, 404);
    assert.equal((await rpc(options, 'invoke', [createServerReference(id)])).status, 400);
  }
  assert.match((await renderAppPage(options)).body.toString(), /data-count="2" data-calls="1"/);
});

test('action errors are sanitized and redirects do not replay mutations', async () => {
  const options = await fixture();
  const failure = await rpc(options, 'fail', []);
  assert.equal(failure.status, 500);
  const failed = await model(options, failure);
  assert.match(failed.actionError.message, /error occurred while executing this action/);
  assert.match(failed.actionError.digest, /^[a-f0-9]{16}$/);
  assert.ok(!failure.body.toString().includes('PRIVATE_ACTION_DETAILS'));
  const redirected = await rpc(options, 'go', []);
  assert.equal(redirected.status, 200);
  assert.deepEqual((await model(options, redirected)).actionRedirect, { url: '/destination', type: 'replace' });
  const form = new FormData();
  form.set('$ACTION_ID_go', '');
  const payload = await encoded(form);
  const native = await renderAppPage({ ...options, method: 'POST', body: payload.body, headers: { 'content-type': payload.contentType } });
  assert.equal(native.status, 303);
  assert.equal(native.headers.location, '/destination');
  assert.match(native.headers['set-cookie'][0], /^count=2;/);
  assert.match((await renderAppPage(options)).body.toString(), /data-count="2" data-calls="3"/);
});

test('action notFound uses the nearest route boundary and a captured registered reference resolves safely', async () => {
  const options = await fixture();
  const nested = await rpc(options, 'nested', []);
  assert.equal(nested.status, 200);
  assert.equal((await model(options, nested)).actionResult.count, 3);
  const missing = await rpc(options, 'missing', []);
  assert.equal(missing.status, 404);
  assert.match(missing.body.toString(), /Action not found/);
  assert.equal((await model(options, missing)).actionError, undefined);
  const payload = await encoded(new URLSearchParams({ '$ACTION_ID_missing': '' }));
  const native = await renderAppPage({ ...options, method: 'POST', body: payload.body, headers: { 'content-type': payload.contentType } });
  assert.equal(native.status, 404);
  assert.match(native.body.toString(), /<h1>Action not found<\/h1>/);
  assert.match((await renderAppPage(options)).body.toString(), /data-count="3" data-calls="3"/);
});

test('an HTML failure after a native mutation returns the cookies and never replays the action', async () => {
  const options = await fixture();
  const fields = new FormData();
  fields.set('$ACTION_ID_form', '');
  fields.set('delta', '4');
  const payload = await encoded(fields);
  const response = await renderAppPage({ ...options, method: 'POST', body: payload.body,
    headers: { 'content-type': payload.contentType, 'x-break-after-action': '1' } });
  assert.equal(response.status, 500);
  assert.match(response.body.toString(), /<html id="__rustyx_error__">/);
  assert.match(response.headers['set-cookie'][0], /^count=4;/);
  assert.match((await renderAppPage(options)).body.toString(), /data-count="4" data-calls="1"/);
});

test('action deadlines retire the isolate without replay and the next request recovers', async () => {
  const options = await fixture();
  await assert.rejects(renderFlight({ ...options, actions: options.manifest.app.actions,
    action: { id: 'hang', body: Buffer.from('[]').toString('base64'), contentType: 'text/plain' } },
  { softTimeoutMs: 20, hardTimeoutMs: 2000 }), error => error.statusCode === 504);
  assert.equal((await rpc(options, 'add', [1])).status, 200);
});


test('a cancelled action still retires its isolate when the mutation ignores cancellation', async () => {
  const options=await fixture();
  await rpc(options,'add',[5]);
  const abort=new AbortController();
  const rejected=assert.rejects(renderFlight({...options,actions:options.manifest.app.actions,
    action:{id:'hang',body:Buffer.from('[]').toString('base64'),contentType:'text/plain'}},
    {signal:abort.signal,softTimeoutMs:1000,hardTimeoutMs:5000}),/action caller left/);
  for(let i=0;;i++) {try{await readFile(path.join(options.distDir,'hang-started'));break}catch{assert.ok(i<100);await new Promise(r=>setTimeout(r,5))}}
  abort.abort(new Error('action caller left'));
  await rejected;
  await new Promise(r=>setTimeout(r,1200));
  assert.match((await renderAppPage(options)).body.toString(),/data-count="0" data-calls="0"/);
});
