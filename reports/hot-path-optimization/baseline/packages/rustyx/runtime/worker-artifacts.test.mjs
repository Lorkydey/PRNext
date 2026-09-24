import test from 'node:test';
import assert from 'node:assert/strict';
import { workerArtifacts } from './worker-artifacts.mjs';

test('immutable Flight bytes cross the worker boundary once until replaced or evicted', () => {
  const messages=[], port={postMessage:m=>messages.push(m)};
  const register=workerArtifacts(port,{maxEntries:2,maxBytes:16,maxEntryBytes:12});
  const first=register('one');
  assert.equal(register(['o','n','e'].join('')),first);
  assert.equal(messages.length,1);
  const other=register('two');
  assert.notEqual(first,other);
  register('one'); register('new');
  assert.deepEqual(messages[2],{type:'artifact-drop',id:other});
  assert.equal(register('oversized'),undefined);
  assert.equal(register({headers:{cookie:'private'}}),undefined);
  assert.equal(messages.length,4);
  assert.notEqual(register('two'),other);
  const received=new Map();
  for(const m of messages) { if(m.type==='artifact')received.set(m.id,m.value);else received.delete(m.id); }
  assert.ok(received.size<=2);
  assert.ok([...received.values()].reduce((n,s)=>n+s.length*2,0)<=16);
});

test('worker restart gets a fresh registry and zero budgets disable registration', () => {
  for(const options of [{maxEntries:0},{maxBytes:0},{maxEntryBytes:0}]) {
    const register=workerArtifacts({postMessage(){assert.fail('unexpected retention')}},options);
    assert.equal(register('static'),undefined);
  }
  const messages=[];
  for(let i=0;i<2;i++) assert.equal(workerArtifacts({postMessage:m=>messages.push(m)})('same'),1);
  assert.equal(messages.length,2);
});
