import test from 'node:test';
import assert from 'node:assert/strict';
import {equalParams} from '../compat/navigation-values.cjs';

test('navigation params stabilize equivalent scalar and catchall values without reading object getters',()=>{
  assert.equal(equalParams({slug:'one',path:['a','b']},{path:['a','b'],slug:'one'}),true);
  assert.equal(equalParams({path:['a','b']},{path:['a','c']}),false);
  assert.equal(equalParams({path:['a','b']},{path:['b','a']}),false);
  assert.equal(equalParams({slug:'one'},{slug:'two'}),false);
  assert.equal(equalParams({slug:'one'},{}),false);
  assert.equal(equalParams(undefined,{}),false);
  let reads=0;const getter={get slug(){reads++;return'one'}};
  assert.equal(equalParams(getter,{slug:'one'}),false);assert.equal(reads,0);
  assert.equal(equalParams({path:Array(129).fill('a')},{path:Array(129).fill('a')}),false);
});
