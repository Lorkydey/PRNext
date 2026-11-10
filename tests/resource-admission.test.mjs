import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceAdmissionFixture } from './resource-admission-fixture.mjs';
import { startServer } from './support.mjs';

async function events(directory) {
  const names = await readdir(directory).catch(() => []);
  const records = await Promise.all(names.filter(name => /^native-\d+\.jsonl$/.test(name)).map(name => readFile(path.join(directory, name), 'utf8')));
  return records.flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).filter(event => event.type === 'resource-admission');
}

test('experimental resource admission preserves isolation and cancellation; default, opt-out and classic retain fixed admission', async () => {
  const fixture = await resourceAdmissionFixture();
  try {
    await fixture.build();
    for (const mode of ['on', 'off', 'default', 'classic']) {
      const directory = path.join(fixture.root, 'inspection-' + mode);
      const server = await startServer(fixture.root, ['--workers', '1'], { PRNEXT_RESOURCE_ADMISSION: mode === 'on' || mode === 'classic' ? '1' : mode === 'off' ? '0' : undefined, PRNEXT_PROFILE: mode === 'classic' ? 'classic' : 'balanced', PRNEXT_INSPECT_DIR: directory });
      try {
        const routes = ['/', '/catalogue?memory=1&wait=20', '/api/light', '/api/io'];
        const responses = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
          const owner = 'resource-owner-' + index + '-end';
          const response = await fetch(server.url + routes[index % routes.length], { headers: { 'x-resource-owner': owner, ...(index % 4 === 1 ? { RSC: '1' } : {}) } });
          assert.equal(response.status, 200);
          const body = await response.text(); assert.ok(body.includes(owner));
          return body;
        }));
        for (let index = 0; index < responses.length; index++) for (let other = 0; other < responses.length; other++) if (index !== other) assert.ok(!responses[index].includes('resource-owner-' + other + '-end'));
        const abort = new AbortController();
        const streaming = await fetch(server.url + '/api/stream', { signal: abort.signal });
        const reader = streaming.body.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {});
        const recovered = await fetch(server.url + '/api/light'); assert.equal(recovered.status, 200); await recovered.text();
        if (mode === 'on') {
          const until = performance.now() + 5000; let sampled;
          do { sampled = await events(directory); if (sampled.some(event => event.rss > 0 && event.active === 0)) break; await delay(50); } while (performance.now() < until);
          assert.ok(sampled.some(event => event.rss > 0 && event.active === 0), 'negotiated host/RSC telemetry reaches native admission');
          assert.ok(sampled.every(event => event.capacity > 0 && event.capacity <= 256));
        } else {
          await delay(1100);
          assert.deepEqual(await events(directory), []);
        }
      } finally { await server.close(); }
    }
  } finally { await fixture.remove(); }
});
