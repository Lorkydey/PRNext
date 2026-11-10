import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { arrivalWindow, checkResourceComparison } from './resource-admission.mjs';

test('admission comparison counts planned arrivals, delayed completions and unsuccessful responses', async () => {
  let fail = false;
  const server = createServer(async (request, response) => {
    await delay(120);
    response.writeHead(fail ? 503 : 200);
    response.end(JSON.stringify({ owner: request.headers['x-resource-owner'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const options = { seconds: .2 }, phase = { name: 'controlled', rps: 10, routes: ['light'] };
    const passed = await arrivalWindow(url, phase, options);
    assert.equal(passed.planned, 2); assert.equal(passed.success, 2); assert.equal(passed.failed, 0);
    assert.ok(passed.p95Ms >= 100, 'latency includes the delay for every arrival');
    assert.ok(passed.usefulRps < passed.success / options.seconds, 'post-window drain cannot inflate throughput');
    fail = true;
    const failed = await arrivalWindow(url, phase, options);
    assert.equal(failed.success, 0); assert.equal(failed.failed, 2); assert.equal(failed.usefulRps, 0);
    assert.ok(failed.rows.every(row => row.status === 503));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('resource qualification rejects lower throughput or excessive queue latency even with successful responses', () => {
  const make=(mode,p95=1000,rps=100)=>({mode,cycle:0,phases:['light','nominal','burst'].map(phase=>({phase,p95Ms:p95,usefulRps:rps,failed:0}))});
  assert.equal(checkResourceComparison([make('off'),make('on',1100)]).passed,true);
  assert.equal(checkResourceComparison([make('off'),make('on',1400)]).passed,false);
  assert.equal(checkResourceComparison([make('off'),make('on',1000,85)]).passed,false);
  assert.equal(checkResourceComparison([make('off')]).passed,false);
});
