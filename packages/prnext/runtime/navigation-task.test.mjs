import test from 'node:test';
import assert from 'node:assert/strict';
import {beginNavigationTask,currentNavigationTask,cancelNavigationTask} from './navigation-task.mjs';
test('supersession releases the old link while another router remains independent',async()=>{
  const a={},b={},first=beginNavigationTask(a,1),other=beginNavigationTask(b,1),next=beginNavigationTask(a,2);
  assert.equal(await first.promise,false);first.finish(true);assert.equal(currentNavigationTask(a),next);assert.equal(currentNavigationTask(b),other);
  next.finish(true);assert.equal(await next.promise,true);assert.equal(currentNavigationTask(a),undefined);
  cancelNavigationTask(b);assert.equal(await other.promise,false);cancelNavigationTask(b);
});
