import test from 'node:test';
import assert from 'node:assert/strict';
import {SieveCache} from '../compat/sieve-cache.cjs';

test('SIEVE retains observed entries, wraps its hand, deletes arbitrary nodes and clears ownership', () => {
  const evicted=[],cache=new SieveCache({maxEntries:3,onEvict:(key,value)=>evicted.push([key,value])});
  for(const key of ['a','b','c'])cache.set(key,key);
  cache.get('a');cache.get('b');cache.set('d','d');
  assert.deepEqual(evicted,[['c','c']]);
  cache.delete('b');cache.set('e','e');cache.get('a');cache.get('d');cache.get('e');cache.set('f','f');
  assert.equal(cache.size,3);
  cache.delete('a');cache.delete('f');cache.clear();
  assert.equal(cache.size,0);assert.equal(cache.bytes,0);
  assert.equal(new Set(evicted.map(([key])=>key)).size,evicted.length);
  cache.set('new',1);assert.equal(cache.get('new'),1);
});

test('weighted SIEVE enforces count and byte ceilings across replacement and repeated scans', () => {
  const resident=new Map(),cache=new SieveCache({maxEntries:7,maxBytes:31,onEvict:key=>resident.delete(key)});
  for(let index=0;index<5000;index++){
    const key='key'+index%19,weight=index%17,value={index,weight};
    cache.set(key,value,weight);resident.set(key,value);
    // Replacements may evict their own entry while making room.
    if(!cache.has(key))resident.delete(key);
    for(const [name,expected]of resident){const actual=cache.get(name);assert.equal(actual,expected);}
    assert.equal(cache.size,resident.size);
    assert.equal(cache.bytes,[...resident.values()].reduce((sum,value)=>sum+value.weight,0));
    assert.ok(cache.size<=7&&cache.bytes<=31);
  }
  assert.equal(cache.set('too-large',{},32),false);assert.equal(cache.has('too-large'),false);
  cache.clear();assert.equal(resident.size,0);
  assert.equal(new SieveCache({maxEntries:0}).set('x',1),false);
  assert.throws(()=>cache.set('x',1,-1),TypeError);
});
