import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPartialFlight, preparePartialModel, partialModel } from './app-partial-model.mjs';

test('partial Flight limiting preserves demand, cancellation, original failures and releases the source reader', async () => {
  let reads=0,cancelled;
  const source=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array([reads]))},cancel(reason){cancelled=reason}}, {highWaterMark:0});
  const bounded=boundedPartialFlight(source,8);await Promise.resolve();assert.equal(reads,0);
  const reader=bounded.getReader();assert.deepEqual((await reader.read()).value,new Uint8Array([1]));
  await Promise.resolve();assert.equal(reads,1);
  const reason=new Error('gone');await reader.cancel(reason);assert.equal(cancelled,reason);assert.equal(source.locked,false);
  const failure=new Error('upstream');const broken=new ReadableStream({pull(c){c.error(failure)}},{highWaterMark:0});
  await assert.rejects(boundedPartialFlight(broken).getReader().read(),e=>e===failure);await new Promise(resolve=>setImmediate(resolve));assert.equal(broken.locked,false);
  const done=new ReadableStream({start(c){c.close()}});assert.equal((await boundedPartialFlight(done).getReader().read()).done,true);assert.equal(done.locked,false);
});

test('partial models merge request holes in Maps and Sets without changing static rich values', async () => {
  const hole = () => { const promise = Promise.reject(Object.assign(new Error('request'), {digest:'PRNEXT_PPR_DYNAMIC'})); promise.catch(()=>{}); return promise; };
  const date = new Date(1234), bytes = new Uint8Array([1,2]);
  const map = new Map([['static', date], ['request', hole()]]);
  const model = {router:{}, map, repeated:map, set:new Set([bytes,hole()])};
  await preparePartialModel(model);
  const actual = partialModel(model, {live:{router:{},map:new Map([['request',Promise.resolve('Ada')],['static',new Date(999)]]),set:new Set([new Uint8Array([3]),Promise.resolve('live')])}});
  assert.ok(actual.map instanceof Map);assert.ok(actual.set instanceof Set);
  assert.equal(actual.map,actual.repeated);
  assert.equal(actual.map.get('static'),date);
  assert.equal(await actual.map.get('request'),'Ada');
  const set=[...actual.set];assert.equal(set[0],bytes);assert.equal(await set[1],'live');
});

test('partial collection preparation retains genuine errors and cyclic object sharing', async () => {
  const rejected=Promise.reject(new Error('real render failure'));rejected.catch(()=>{});
  await assert.rejects(preparePartialModel(new Map([['failed',rejected]])),/real render failure/);
  const model=new Map();model.set('self',model);
  await preparePartialModel(model);
  const copy=partialModel(model);assert.equal(copy.get('self'),copy);
});

test('partial models preserve shared promise identity and promise/object cycles',async()=>{
  const value={name:'static'};const promise=Promise.resolve(value);value.self=promise;
  const actual=partialModel({router:{},a:promise,b:promise},{live:{router:{},a:Promise.resolve({name:'live'})}});
  assert.equal(actual.a,actual.b);const resolved=await actual.a;assert.equal(resolved.self,actual.a);assert.equal(resolved.name,'static');
});

test('large live collections are indexed once when resuming their request holes',async()=>{
  const pending=()=>{const p=Promise.reject(Object.assign(new Error('hole'),{digest:'PRNEXT_PPR_DYNAMIC'}));p.catch(()=>{});return p;};
  let iterations=0;const live=new Set(Array.from({length:100},(_,i)=>Promise.resolve(i)));
  const keys=live.keys.bind(live);live.keys=()=>{iterations++;return keys();};
  const copy=partialModel({router:{},items:new Set(Array.from({length:100},pending))},{live:{router:{},items:live}});
  assert.deepEqual(await Promise.all(copy.items),Array.from({length:100},(_,i)=>i));assert.equal(iterations,1);
});

test('partial live Flight preserves byte allocations and cancels the producer before decoding excess data', async () => {
  const first = new Uint8Array(4);
  let pulls = 0, canceled;
  const source = new ReadableStream({
    pull(controller) { controller.enqueue(++pulls === 1 ? first : new Uint8Array(5)); },
    cancel(reason) { canceled = reason; },
  }, { highWaterMark: 0 });
  const reader = boundedPartialFlight(source, 8).getReader();
  assert.equal((await reader.read()).value, first);
  await assert.rejects(reader.read(), /Flight exceeds/);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(canceled.message, /Flight exceeds/);
  assert.equal(pulls, 2);
});

test('ready static lazy nodes resume synchronously and live ancestry is resolved once per request', async () => {
  const lazy = callback => ({ $$typeof: Symbol.for('react.lazy'), _payload: {}, _init: callback });
  const hole = () => lazy(() => { throw Object.assign(new Error('hole'), { digest: 'PRNEXT_PPR_DYNAMIC' }); });
  const model = { router: {}, ready: lazy(() => ({ label: 'built' })), nested: { a: hole(), b: hole() } };
  for (const visitor of ['Ada', 'Lin']) {
    let reads = 0;
    const live = { router: {}, get nested() { reads++; return { a: visitor, b: visitor }; } };
    const copy = partialModel(model, { live });
    assert.deepEqual(copy.ready._init(), { label: 'built' });
    assert.equal(copy.nested.a._init(), visitor);
    assert.equal(copy.nested.b._init(), visitor);
    assert.equal(reads, 1);
  }
});
