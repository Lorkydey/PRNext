import test from 'node:test';
import assert from 'node:assert/strict';
import {renderKeyFor} from './app-render-key.mjs';
test('independent workers cannot collide across cached paths or generated parameters',()=>{
  const request=path=>({url:'http://localhost'+path,routePattern:'/catalog/[id]'});
  assert.notEqual(renderKeyFor(request('/redirect'),1),renderKeyFor(request('/plain'),1));
  assert.notEqual(renderKeyFor(request('/catalog/a'),1),renderKeyFor(request('/catalog/b'),1));
  assert.notEqual(renderKeyFor(request('/catalog/a'),1),renderKeyFor(request('/catalog/a'),2));
  assert.notEqual(renderKeyFor({...request('/catalog/a'),originalUrl:'http://localhost/alias'},1),renderKeyFor(request('/catalog/a'),1));
});
