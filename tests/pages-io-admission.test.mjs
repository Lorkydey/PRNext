import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isrFixture } from './isr-fixture.mjs';
import { startServer } from './support.mjs';

test('saturated Pages cache lookup returns 503 without invoking page error generation', async () => {
  const fixture = await isrFixture();
  let server;
  try {
    // Exercise the generic error response as well as the normal seeded cache.
    // An error template could itself hit admission and conceal an incorrect 500.
    const file = path.join(fixture.root, '.prnext/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.pagesErrors = {};
    await writeFile(file, JSON.stringify(manifest));
    server = await startServer(fixture.root, [], { PRNEXT_FILE_WORK_CONCURRENCY: '1', PRNEXT_FILE_QUEUE: '0' });
    const url = `${server.url}/_prnext/data/${manifest.buildId}/seed.json`;
    let rejected = 0;
    for (let round = 0; round < 3 && !rejected; round++) {
      const replies = await Promise.all(Array.from({ length: 128 }, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const body = await response.text();
        assert.ok([200, 503].includes(response.status), `unexpected ${response.status}: ${body.slice(0, 100)}`);
        if (response.status === 503) {
          assert.equal(response.headers.get('retry-after'), '1');
          assert.equal(response.headers.get('cache-control'), 'no-store');
        } else assert.equal(JSON.parse(body).__N_SSG, true);
        return response.status;
      }));
      rejected += replies.filter(status => status === 503).length;
    }
    assert.ok(rejected > 0, 'the test must actually saturate cache admission');
    assert.doesNotMatch(server.output(), /Pages data generation failed|error page generation failed/);
    const recovery = await fetch(url);
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).pageProps.reason, 'build');
    const html = await fetch(server.url + '/seed');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /data-testid="reason">build</);
    assert.equal(fixture.counts.get('seed'), 1, 'overload must not trigger regeneration');
  } finally { await server?.close(); await fixture.remove(); }
});
