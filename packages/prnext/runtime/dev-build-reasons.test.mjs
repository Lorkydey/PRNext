import test from 'node:test';
import assert from 'node:assert/strict';
import {devBuildReason} from './dev-build-reasons.mjs';
test('build reasons identify safe mode, environment/config invalidation and CSS fallback without file contents',()=>{
  assert.equal(devBuildReason({initial:true}).code,'initial-build');
  assert.equal(devBuildReason({initial:true,safe:true}).code,'safe-mode');
  assert.equal(devBuildReason({changed:['.env.local'],cause:'unknown-dependency'}).code,'environment-changed');
  assert.equal(devBuildReason({changed:['package-lock.json']}).code,'configuration-changed');
  assert.equal(devBuildReason({changed:['app/page.jsx']}).code,'source-changed');
  assert.equal(devBuildReason({changed:['app/main.module.css'],cause:'css-module-exports'}).code,'css-module-exports');
  assert.equal(devBuildReason({cause:'user supplied text'}).code,'route-opened');
  assert.ok(!JSON.stringify(devBuildReason({changed:['.env.private-key-value']})).includes('private-key-value'));
});
