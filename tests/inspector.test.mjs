import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheFixture } from './cache-fixture.mjs';
import { startServer } from './support.mjs';
import { inspectProject } from '../packages/prnext/build/inspect.mjs';

test('inspector observes real cache hits, fetch timings and invalidations without credentials or query values', async () => {
  const fixture = await cacheFixture(); let server;
  const directory = path.join(fixture.root, '.prnext-cache/inspect');
  try {
    server = await startServer(fixture.root, [], { PRNEXT_INSPECT_DIR: directory });
    for (let i=0;i<2;i++) assert.equal((await fetch(server.url+'/api/fetch?key=inspector-private-query',{headers:{authorization:'Bearer inspector-private-auth'}})).status,200);
    assert.equal((await fetch(server.url+'/api/invalidate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag:'fetch:inspector-private-query'})})).status,200);
    let report;
    for(let i=0;i<100;i++) { report=await inspectProject(fixture.root);if(report.invalidations.length && report.measurements.some(value=>value.type==='http')) break;await delay(50); }
    assert.ok(report.measurements.some(value=>value.type==='cache'&&value.state==='fresh'),JSON.stringify(report));
    assert.ok(report.measurements.some(value=>value.type==='cache'&&value.state==='miss'));
    assert.ok(report.measurements.some(value=>value.type==='fetch'&&value.p95Ms>=0));
    assert.ok(report.invalidations.length);
    assert.ok(report.cacheEntries.some(entry=>entry.tags.some(tag=>report.invalidations.some(event=>event.tags.includes(tag)))));
    assert.ok(report.routes.length);
    assert.match(report.routes.find(route=>route.pattern==='/forced').reasons.join(' '),/force-dynamic/);
    assert.match(report.routes.find(route=>route.pattern==='/memo').reasons.join(' '),/uncached fetch/);
    assert.equal(report.routes.find(route=>route.pattern==='/').mode,'static / ISR');
    const bytes=(await Promise.all((await readdir(directory)).map(name=>readFile(path.join(directory,name),'utf8')))).join('');
    assert.doesNotMatch(bytes,/inspector-private-query|inspector-private-auth/);
  } finally {await server?.close();await fixture.remove();}
});
