import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { PartialTemplates, snapshotPartialTemplate, canResumePartialDirectly } from './partial-template.mjs';
import { partialModel } from './app-partial-model.mjs';
const lazy = value => ({ $$typeof: Symbol.for('react.lazy'), _payload: {}, _init() { return value; } });
const rejection = () => { const p=Promise.reject(Object.assign(new Error('request'),{digest:'RUSTYX_PPR_DYNAMIC'}));p.catch(()=>{});return p; };

test('direct root continuation matches the official Flight round trip for async server components', () => {
  const source = `
    import assert from 'node:assert/strict';
    import React from 'react';
    import {renderToReadableStream} from 'react-server-dom-webpack/server.node';
    import {createFromReadableStream} from 'react-server-dom-webpack/client.edge';
    import {snapshotPartialTemplate,canResumePartialDirectly} from ${JSON.stringify(new URL('./partial-template.mjs',import.meta.url).href)};
    import {partialModel} from ${JSON.stringify(new URL('./app-partial-model.mjs',import.meta.url).href)};
    const consumer={serverConsumerManifest:{moduleMap:{},serverModuleMap:{},moduleLoading:null}};
    const decode=stream=>createFromReadableStream(stream,consumer);
    const encode=model=>renderToReadableStream(model,{}, {onError:e=>e.digest||'error'});
    const hole=Promise.reject(Object.assign(new Error('hole'),{digest:'RUSTYX_PPR_DYNAMIC'}));hole.catch(()=>{});
    const {model:stored}=await snapshotPartialTemplate({router:{},tree:hole,css:['built.css']});
    assert.ok(canResumePartialDirectly(stored));
    const unwrap=async value=>{for(;;){if(value?.$$typeof===Symbol.for('react.lazy')){try{value=value._init(value._payload)}catch(e){if(typeof e?.then!=='function')throw e;await e}}else if(value?.then)value=await value;else return value}};
    for(const visitor of ['Ada','Lin']) {
      let calls=0;
      async function Page(){calls++;await Promise.resolve();return React.createElement('p',null,visitor)}
      const live={router:{pathname:visitor},tree:React.createElement(Page),css:['new.css']};
      const direct=await decode(encode(partialModel(stored,{live})));
      const expected=await decode(encode(partialModel(stored,{live:await decode(encode(live))})));
      const a=await unwrap(direct.tree),b=await unwrap(expected.tree);
      assert.equal(a.type,b.type);assert.equal(a.props.children,b.props.children);
      assert.equal(a.props.children,visitor);assert.equal(calls,2);
      assert.deepEqual(direct.css,['built.css']);assert.equal(direct.router.pathname,visitor);
    }
  `;
  execFileSync(process.execPath,['--conditions=react-server','--input-type=module','-e',source],{stdio:'pipe',timeout:10000});
});

test('direct continuation accepts only whole root holes, preserving the raw React node per visitor', async () => {
  const {model}=await snapshotPartialTemplate({router:{},tree:rejection(),css:['static.css']});
  assert.equal(canResumePartialDirectly(model),true);
  for(const name of ['Ada','Lin']) {
    const tree={$$typeof:Symbol.for('react.transitional.element'),type:()=>name,key:null,props:{}};
    const merged=partialModel(model,{live:{router:{pathname:name},tree}});
    assert.equal(await merged.tree,tree);
    assert.equal(merged.router.pathname,name);
    assert.deepEqual(merged.css,['static.css']);
  }
});

test('nested and aliased holes, live property bindings and cycles retain ordinary Flight decoding', async () => {
  const alias=rejection();const cycle={};cycle.self=cycle;
  for(const model of [
    {router:{},tree:{child:rejection()}},
    {router:{},tree:alias,other:{child:alias}},
    {router:{},tree:rejection(),keyScopes:[{key:'x',liveProps:['params']}]},
    {router:{},tree:cycle},
    {router:{},tree:rejection(),routing:{}},
    {router:{},tree:new Map([['hole',rejection()]])},
  ]) assert.equal(canResumePartialDirectly((await snapshotPartialTemplate(model)).model),false);
  assert.equal(canResumePartialDirectly({tree:'not a prepared snapshot'}),false);
});

test('distinct static holes keep distinct replacement paths across visitors', async () => {
  const hole=()=>({$$typeof:Symbol.for('react.lazy'),_payload:{},_init(){throw Object.assign(new Error('request'),{digest:'RUSTYX_PPR_DYNAMIC'})}});
  const cache=new PartialTemplates(),consumer={moduleMap:{},serverModuleMap:{}};
  for(const name of ['Ada','Lin']){
    const snapshot=await cache.get('static',consumer,()=>({router:{},a:hole(),b:hole()}));
    const copy=partialModel(snapshot,{live:{router:{},a:name+'-a',b:name+'-b'}});
    assert.equal(copy.a._init(),name+'-a');assert.equal(copy.b._init(),name+'-b');
  }
});

test('static snapshots preserve promises, lazy nodes, sharing, collections and request-hole isolation', async () => {
  const shared={label:'built'};const model={router:{},promise:Promise.resolve(shared),lazy:lazy(shared),shared,map:new Map([['date',new Date(42)],['private',rejection()]]),set:new Set([shared])};
  model.self=model;
  const {model:snapshot}=await snapshotPartialTemplate(model);
  assert.equal(snapshot.self,snapshot);assert.equal(await snapshot.promise,snapshot.shared);
  assert.equal(snapshot.lazy._init(),snapshot.shared);assert.equal([...snapshot.set][0],snapshot.shared);
  assert.notEqual(snapshot.shared,shared);
  for(const name of ['Ada','Lin']){
    const copy=partialModel(snapshot,{live:{router:{},map:new Map([['private',Promise.resolve(name)]])}});
    assert.equal(await copy.map.get('private'),name);
    assert.equal(copy.map.get('date').getTime(),42);
    assert.equal((await copy.promise).label,'built');
    assert.equal(typeof copy.promise.then,'function');
  }
});

test('template cache uses exact static content AND manifests, with bounded retention', async () => {
  const cache=new PartialTemplates({maxEntries:2,maxBytes:1024});
  const a={moduleMap:{},serverModuleMap:{}},b={moduleMap:{},serverModuleMap:{}};let loads=0;
  const decode=()=>{loads++;return {router:{},tree:lazy('static')}};
  const first=await cache.get('first',a,decode);
  assert.equal(await cache.get('first',a,decode),first);assert.equal(loads,1);
  assert.notEqual(await cache.get('first',b,decode),first);assert.equal(loads,2);
  await cache.get('second',a,decode);await cache.get('third',a,decode);
  assert.equal(cache.entries.size,2);assert.ok(cache.bytes<=1024);
  assert.notEqual(await cache.get('first',a,decode),first);assert.equal(loads,5);
});

test('non-replayable values bypass snapshots without consuming streams or retaining decoder objects', async () => {
  for(const value of [new ReadableStream(),()=>{},new Uint8Array([1,2])]){
    const cache=new PartialTemplates(),consumer={moduleMap:{},serverModuleMap:{}};
    let loads=0;const decoded={value};const decode=()=>{loads++;return decoded};
    assert.equal(await cache.get('static',consumer,decode),decoded);
    assert.equal(await cache.get('static',consumer,decode),decoded);
    assert.equal(loads,2);assert.equal(cache.entries.get('static').model,undefined);
    if(value instanceof ReadableStream)assert.equal(value.locked,false);
  }
});

test('failed snapshots do not change ordinary error semantics and cancellation never poisons an entry', async () => {
  const cache=new PartialTemplates(),consumer={moduleMap:{},serverModuleMap:{}};
  const failed=Promise.reject(new Error('real render error'));failed.catch(()=>{});const model={failed};
  assert.equal(await cache.get('error',consumer,()=>model),model);
  const abort=new AbortController();
  const pending=cache.get('pending',consumer,()=>({pending:new Promise(()=>{})}),abort.signal);
  abort.abort(new Error('cancelled'));await assert.rejects(pending,/cancelled/);
  assert.ok(!cache.entries.has('pending'));
  const recovered=await cache.get('pending',consumer,()=>({value:'healthy'}));assert.equal(recovered.value,'healthy');
});
