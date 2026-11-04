import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyCacheFaults} from './reference/cache-faults.mjs';
test('real Redis crash and restart cannot publish a stale producer or hide invalidation failures',{timeout:30000},async()=>{
  const report=await qualifyCacheFaults();assert.equal(report.complete,true);assert.equal(report.resourcesClosed,true);assert.equal(report.checks.length,5);assert.ok(report.interruptedWriteMs<2000);
});
