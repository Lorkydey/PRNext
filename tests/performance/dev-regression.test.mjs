import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDevRegression} from './dev-regression.mjs';
const report=()=>({complete:true,edits:100,fixture:'same',machine:{platform:'linux',arch:'x64',cpu:'same',node:'24.22.1'},pageErrors:[],metrics:{js:{p95:100},css:{p95:50},heapGrowthBytes:1024}});
test('performance gate refuses errors, unmatched workloads and meaningful refresh regressions',()=>{
  const before=report(),after=report();checkDevRegression(after,before);
  after.metrics.js.p95=300;assert.throws(()=>checkDevRegression(after,before),/regressed/);
  const other=report();other.machine.cpu='different';assert.throws(()=>checkDevRegression(other,before),/same machine/);
  const failed=report();failed.pageErrors=['runtime error'];assert.throws(()=>checkDevRegression(failed),/failing/);
  const missing=report();missing.metrics.js.p95=NaN;assert.throws(()=>checkDevRegression(missing),/Incomplete/);
});
