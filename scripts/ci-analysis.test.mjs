import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  analysisOptions,
  analyzeJob,
  cacheSummary,
  collectAnalysis,
  githubClient,
  analyzeCli,
  readMetrics,
  runCohort,
  stepCategory,
  feedbackTimings,
  parseCacheSnapshotZip,
} from './ci-analysis.mjs';
import { metricRecord } from './ci-metrics.mjs';

const start = '2026-10-31T01:00:00Z',
  later = (seconds) =>
    new Date(Date.parse(start) + seconds * 1000).toISOString();
const job = (name = 'Integration (ubuntu-24.04)', conclusion = 'success') => ({
  id: 1,
  name,
  status: 'completed',
  conclusion,
  started_at: later(10),
  completed_at: later(40),
  steps: [
    {
      name: 'Install npm dependencies',
      started_at: later(10),
      completed_at: later(15),
      conclusion: 'success',
    },
    {
      name: 'Integration tests',
      started_at: later(15),
      completed_at: later(35),
      conclusion,
    },
  ],
});
const run = (id, conclusion = 'success') => ({
  id,
  workflow_id: 7,
  run_number: id,
  run_attempt: 1,
  status: 'completed',
  conclusion,
  created_at: start,
  head_sha: 'a'.repeat(40),
});
const response = (data, headers = {}) =>
  new Response(JSON.stringify(data), { headers });
async function temporary(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'prnext-ci-analysis-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function optionalZipLibrary(t) {
  try {
    return await import('fflate');
  } catch (error) {
    if (
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      /^Cannot find package 'fflate'(?:\s|$)/.test(error.message)
    ) {
      t.skip('Run after npm ci for the optional ZIP integration');
      return null;
    }
    throw error;
  }
}

test('step categories match actual checks without confusing tested binaries with tests', () => {
  for (const name of [
    'Run cargo fmt --all -- --check',
    'Run cargo clippy --workspace --all-targets -- -D warnings',
    'Run npm run test:types',
  ])
    assert.equal(stepCategory(name), 'check');
  assert.equal(stepCategory('Share the tested native binary'), 'other');
  assert.equal(stepCategory('Install dependencies for browser tests'), 'setup');
  assert.equal(stepCategory('Post actions/cache@v5'), 'post');
  assert.equal(stepCategory('Build native module'), 'build');
  assert.equal(stepCategory('Run integration tests'), 'test');
});

test('failed, skipped and unfinished steps retain unknown durations and raw times', () => {
  const input = job();
  input.steps.push(
    { name: 'Post cache', status: 'skipped', conclusion: 'skipped' },
    { name: 'Verify tests', status: 'in_progress', started_at: later(35) },
    { name: 'Bad clock', started_at: later(50), completed_at: later(20) },
  );
  const output = analyzeJob(input, { created_at: start });
  assert.equal(output.durationSeconds, 30);
  assert.equal(output.waitBeforeStartSeconds, 10);
  assert.match(output.waitBaseline, /dependency.*not pure runner queue/);
  assert.equal(output.breakdown.setup.knownSeconds, 5);
  assert.equal(output.breakdown.test.knownSeconds, 20);
  assert.equal(output.steps[2].durationSeconds, null);
  assert.equal(output.steps[3].completedAt, null);
  assert.equal(output.steps[4].durationSeconds, null);
  assert.equal(output.breakdown.post.unknownSteps, 1);
});

test('cache denominators include only declared applicable keys, historical absence stays unknown', () => {
  const summary = cacheSummary([
    { caches: { npm: true, rust: false } },
    { caches: { npm: 'unknown' } },
    { caches: { npm: false } },
  ]);
  assert.deepEqual(summary.caches.rust, {
    availability: 'observed',
    applicableRecords: 1,
    exactHits: 0,
    notExactHits: 1,
    unknown: 0,
  });
  assert.equal(summary.caches.npm.exactHits, 1);
  assert.equal(summary.caches.npm.unknown, 1);
  assert.equal(cacheSummary([], ['npm']).caches.npm.exactHits, null);
});

test('API client retries transient failures and paginates without following untrusted link origins', async () => {
  const urls = [],
    pauses = [];
  let calls = 0;
  const api = githubClient({
    token: 'NEVER_PERSIST',
    delay: async (value) => pauses.push(value),
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer NEVER_PERSIST');
      if (++calls === 1) return new Response('transient', { status: 503 });
      if (calls === 2)
        return response(
          { jobs: [{ id: 1 }] },
          { link: '<https://evil.invalid/steal>; rel="next"' },
        );
      return response({ jobs: [{ id: 2 }] });
    },
  });
  assert.deepEqual(await api.list('/repos/o/r/actions/runs/1/jobs', 'jobs'), [
    { id: 1 },
    { id: 2 },
  ]);
  assert.deepEqual(pauses, [500]);
  assert.ok(urls.every((url) => url.startsWith('https://api.github.com/')));
  assert.match(urls[2], /page=2$/);
  const failed = githubClient({
    token: 'NEVER_PERSIST',
    delay: async () => {},
    fetchImpl: async () => {
      throw Error('NEVER_PERSIST secret transport error');
    },
  });
  await assert.rejects(
    failed.get('/ignored'),
    (error) => error.message === 'GitHub API request could not complete.',
  );
});

test('current snapshot, docs-like skips, failures and changed matrices stay separate in history', async () => {
  const current = { ...run(5), status: 'in_progress', conclusion: null };
  const completed = [run(4), run(3), run(2, 'failure'), run(1)];
  const api = {
    get: async (endpoint) =>
      endpoint.endsWith('/workflows/ci.yml')
        ? { id: 7, path: '.github/workflows/ci.yml' }
        : current,
    list: async (endpoint, key) => {
      if (key === 'workflow_runs') return completed;
      if (endpoint.includes('/runs/3/'))
        return [{ ...job(), conclusion: 'skipped', steps: [] }];
      if (endpoint.includes('/runs/2/'))
        return [job('Integration (ubuntu-24.04)', 'failure')];
      if (endpoint.includes('/runs/1/'))
        return [job('Integration shard 1/2 (ubuntu-24.04)')];
      return [
        job(),
        { name: 'CI timing report', status: 'in_progress', steps: [] },
      ];
    },
  };
  const metric = metricRecord(
    { suite: 'integration', caches: { npm: 'true' } },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '5',
      GITHUB_RUN_ATTEMPT: '1',
    },
  );
  const report = await collectAnalysis(
    {
      repository: 'owner/repo',
      runId: '5',
      previousRuns: 4,
      metrics: [metric],
    },
    api,
  );
  assert.equal(report.currentSnapshot, true);
  assert.equal(report.runs[0].cohort, 'in-progress-snapshot');
  assert.equal(report.runs[2].cohort, 'scope-limited-success');
  assert.equal(report.runs[3].cohort, 'unsuccessful');
  assert.equal(report.runs[1].cacheMetrics.caches.npm.exactHits, null);
  assert.equal(
    report.historicalMedians.length,
    4,
    'cohorts and changed job names are not pooled',
  );
  assert.doesNotMatch(JSON.stringify(report), /NEVER_PERSIST/);
  assert.equal(runCohort(run(1), null), 'unknown');
});

test('latest target and explicit run flags work independently of manual workflow run ID', async () => {
  assert.equal(
    analysisOptions(['--latest'], { GITHUB_RUN_ID: '999' }).runId,
    undefined,
  );
  assert.equal(
    analysisOptions(['--run-id', '42'], {
      GITHUB_RUN_ID: '999',
      CI_ANALYSIS_LATEST: 'true',
    }).latest,
    false,
  );
  const api = {
    get: async () => ({ id: 7 }),
    list: async (endpoint, key) =>
      key === 'workflow_runs' ? [run(8), run(7)] : [job()],
  };
  const report = await collectAnalysis(
    { repository: 'owner/repo', latest: true, previousRuns: 1 },
    api,
  );
  assert.equal(report.selectedRunId, 8);
  assert.equal(report.availablePreviousRuns, 1);
  await assert.rejects(
    collectAnalysis(
      { repository: 'owner/repo', latest: true, previousRuns: 21 },
      api,
    ),
    /between 0 and 20/,
  );
});

test('inaccessible historical jobs are partial, not manufactured zero timing', async () => {
  const api = {
    get: async (endpoint) =>
      endpoint.includes('/workflows/') ? { id: 7 } : run(2),
    list: async (endpoint, key) => {
      if (key === 'workflow_runs') return [run(1)];
      if (endpoint.includes('/runs/1/'))
        throw Error('GitHub API request failed (HTTP 403).');
      return [job()];
    },
  };
  const report = await collectAnalysis(
    { repository: 'owner/repo', runId: '2', previousRuns: 1 },
    api,
  );
  assert.equal(report.collectionStatus, 'partial');
  assert.equal(report.runs[1].jobs, null);
  assert.equal(report.runs[1].breakdown.test.knownSeconds, null);
});

test('CLI writes JSON and Markdown even when API unavailable, with no credential persistence', async (t) => {
  const directory = await temporary(t),
    output = path.join(directory, 'report.json'),
    summary = path.join(directory, 'step-summary.md');
  const { failed } = await analyzeCli(
    [
      '--latest',
      '--output',
      output,
      '--metrics-dir',
      path.join(directory, 'absent'),
    ],
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_TOKEN: 'NEVER_PERSIST',
      GITHUB_STEP_SUMMARY: summary,
    },
    { fetchImpl: async () => new Response('NEVER_PERSIST', { status: 403 }) },
  );
  assert.equal(failed, true);
  for (const file of [output, path.join(directory, 'report.md'), summary])
    assert.doesNotMatch(await readFile(file, 'utf8'), /NEVER_PERSIST/);
  assert.match(await readFile(output, 'utf8'), /unavailable/);
  assert.equal(
    await readFile(summary, 'utf8'),
    await readFile(path.join(directory, 'report.md'), 'utf8'),
  );
});

test('malformed local cache records are reported and ignored, never converted into misses', async (t) => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, 'downloaded'));
  await writeFile(path.join(directory, 'downloaded', 'broken.json'), '{');
  await writeFile(
    path.join(directory, 'valid.json'),
    JSON.stringify(
      metricRecord(
        { suite: 'native', caches: { rust: '' } },
        { GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' },
      ),
    ),
  );
  const result = await readMetrics(directory);
  assert.equal(result.records.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.records[0].caches.rust, 'unknown');
});

test('missing step lists stay unknown and feedback time ends at the exact CI result gate', () => {
  const missing = analyzeJob(
    { ...job(), steps: undefined },
    { created_at: start },
  );
  assert.equal(missing.stepsAvailable, false);
  assert.equal(missing.breakdown.test.knownSeconds, null);
  const gate = analyzeJob(
    { ...job('CI result'), completed_at: later(100) },
    { created_at: start },
  );
  const active = analyzeJob(
    { name: 'CI timing report', status: 'in_progress' },
    { created_at: start },
  );
  const timings = feedbackTimings([missing, gate, active], {
    created_at: start,
  });
  assert.equal(timings.validationFeedbackSeconds, 100);
  assert.equal(timings.runnerWorkSeconds, 120);
  assert.equal(
    feedbackTimings([active], { created_at: start }).validationFeedbackSeconds,
    null,
  );
});

test('artifact redirects strip authorization and refuse untrusted destinations and oversized bodies', async () => {
  const calls = [];
  const api = githubClient({
    token: 'TOKEN_NOT_FOR_AZURE',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://production.blob.core.windows.net/artifact?sig=SIGNED_PRIVATE',
          },
        });
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  assert.deepEqual(
    await api.downloadArtifact('owner/repo', 2),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(
    calls[0].options.headers.Authorization,
    'Bearer TOKEN_NOT_FOR_AZURE',
  );
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  for (const location of [
    'http://production.blob.core.windows.net/x',
    'https://evil.invalid/PRIVATE',
    'https://api.github.com/PRIVATE',
  ]) {
    const blocked = githubClient({
      token: 'PRIVATE',
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location } }),
    });
    await assert.rejects(
      blocked.downloadArtifact('owner/repo', 2),
      (error) =>
        !error.message.includes('PRIVATE') && /untrusted/.test(error.message),
    );
  }
  const oversized = githubClient({
    token: 'PRIVATE',
    fetchImpl: async () =>
      new Response('x', {
        headers: { 'content-length': String(3 * 1024 * 1024) },
      }),
  });
  await assert.rejects(oversized.downloadArtifact('owner/repo', 2), /exceeds/);
});

test('snapshot parser inflates only bounded flat snapshot JSON and verifies run attempts', async () => {
  const expected = { ...run(1), repository: 'owner/repo' };
  const metric = metricRecord(
    { suite: 'native', caches: { rust: 'true' } },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
    },
  );
  const content = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      repository: 'owner/repo',
      runId: '1',
      runAttempt: 1,
      metrics: [metric],
    }),
  );
  const unzip = (bytes, { filter }) => {
    assert.equal(
      filter({ name: '../cache-snapshot.json', originalSize: 10 }),
      false,
    );
    assert.equal(
      filter({ name: 'report.json', originalSize: 100000000 }),
      false,
    );
    assert.equal(
      filter({ name: 'cache-snapshot.json', originalSize: content.length }),
      true,
    );
    return { 'cache-snapshot.json': content };
  };
  assert.equal(
    (await parseCacheSnapshotZip(new Uint8Array(), expected, unzip))[0].caches
      .rust,
    true,
  );
  await assert.rejects(
    parseCacheSnapshotZip(
      new Uint8Array(),
      { ...expected, run_attempt: 2 },
      unzip,
    ),
    /identity/,
  );
  await assert.rejects(
    parseCacheSnapshotZip(new Uint8Array(), expected, (bytes, { filter }) => {
      filter({ name: 'cache-snapshot.json', originalSize: 300000 });
    }),
    /256 KiB/,
  );
  await assert.rejects(
    parseCacheSnapshotZip(new Uint8Array(), expected, (bytes, { filter }) => {
      for (let i = 0; i < 65; i++) filter({ name: 'ignored', originalSize: 0 });
    }),
    /64 entries/,
  );
});

test('historical caches cover five previous runs plus the selected run, and absent artifacts remain unknown', async () => {
  const artifactRuns = [];
  const api = {
    get: async (endpoint) =>
      endpoint.includes('/workflows/') ? { id: 7 } : run(10),
    list: async (endpoint, key) => {
      if (key === 'workflow_runs')
        return Array.from({ length: 9 }, (_, index) => run(9 - index));
      if (key === 'artifacts') {
        artifactRuns.push(endpoint);
        return [];
      }
      return [job()];
    },
  };
  const report = await collectAnalysis(
    {
      repository: 'owner/repo',
      runId: '10',
      previousRuns: 9,
      historicalCaches: true,
    },
    api,
  );
  assert.equal(artifactRuns.length, 6);
  assert.match(artifactRuns[0], /runs\/10\/artifacts$/);
  assert.equal(report.warnings.length, 6);
  assert.equal(report.runs[1].cacheMetrics.observedRecords, 0);
});

test('CLI writes a validated consolidated snapshot for the selected run only', async (t) => {
  const directory = await temporary(t),
    metrics = path.join(directory, 'metrics');
  await mkdir(metrics);
  const record = metricRecord(
    { suite: 'native', caches: { rust: 'true' } },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '2',
      GITHUB_RUN_ATTEMPT: '1',
    },
  );
  await writeFile(path.join(metrics, 'native.json'), JSON.stringify(record));
  const output = path.join(directory, 'report.json');
  const { failed, report } = await analyzeCli(
    [
      '--run-id',
      '2',
      '--previous-runs',
      '0',
      '--metrics-dir',
      metrics,
      '--output',
      output,
    ],
    { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'PRIVATE_TOKEN' },
    {
      fetchImpl: async (url) => {
        if (url.includes('/workflows/ci.yml')) return response({ id: 7 });
        if (url.includes('/runs?')) return response({ workflow_runs: [] });
        if (url.includes('/jobs?'))
          return response({ jobs: [job('CI result')] });
        return response(run(2));
      },
    },
  );
  assert.equal(failed, false);
  assert.equal(report.runs[0].validationFeedbackSeconds, 40);
  const snapshot = JSON.parse(
    await readFile(path.join(directory, 'cache-snapshot.json'), 'utf8'),
  );
  assert.equal(snapshot.runId, '2');
  assert.deepEqual(snapshot.metrics, [record]);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_TOKEN/);
});

test('installed fflate reads actual historical ZIP snapshots without inflating the timing report', async (t) => {
  const library = await optionalZipLibrary(t);
  if (!library) return;
  const { zipSync } = library;
  const record = metricRecord(
    { suite: 'native', caches: { rust: 'true' } },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
    },
  );
  const content = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      repository: 'owner/repo',
      runId: '1',
      runAttempt: 1,
      metrics: [record],
    }),
  );
  const zip = zipSync(
    {
      'cache-snapshot.json': content,
      'report.json': new Uint8Array(1024 * 1024),
    },
    { level: 1 },
  );
  let downloads = 0;
  const api = {
    get: async (endpoint) =>
      endpoint.includes('/workflows/') ? { id: 7 } : run(2),
    list: async (endpoint, key) => {
      if (key === 'workflow_runs') return [run(1)];
      if (key === 'artifacts')
        return [
          {
            id: 12,
            name: 'ci-timing-report',
            expired: false,
            size_in_bytes: zip.byteLength,
          },
        ];
      return [job()];
    },
    downloadArtifact: async (repository, id) => {
      assert.equal(repository, 'owner/repo');
      assert.equal(id, 12);
      downloads++;
      return zip;
    },
  };
  const report = await collectAnalysis(
    {
      repository: 'owner/repo',
      runId: '2',
      previousRuns: 1,
      historicalCaches: true,
      metrics: [
        metricRecord(
          { suite: 'unit-and-types', caches: { npm: 'true' } },
          {
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_RUN_ID: '2',
            GITHUB_RUN_ATTEMPT: '1',
          },
        ),
      ],
    },
    api,
  );
  assert.equal(downloads, 1);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.runs[1].cacheMetrics.caches.rust.exactHits, 1);
  assert.equal(report.runs[0].cacheMetrics.caches.rust.exactHits, null);
});

test('manual --latest analysis recovers the selected completed run cache snapshot without local metrics', async (t) => {
  const library = await optionalZipLibrary(t);
  if (!library) return;
  const directory = await temporary(t);
  const record = metricRecord(
    { suite: 'native', caches: { rust: 'true' } },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
    },
  );
  const content = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      repository: 'owner/repo',
      runId: '1',
      runAttempt: 1,
      metrics: [record],
    }),
  );
  const zip = library.zipSync({ 'cache-snapshot.json': content });
  let downloads = 0;
  const { report, failed } = await analyzeCli(
    [
      '--latest',
      '--historical-caches',
      '--previous-runs',
      '0',
      '--metrics-dir',
      path.join(directory, 'absent'),
      '--output',
      path.join(directory, 'report.json'),
    ],
    { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'PRIVATE_TOKEN' },
    {
      fetchImpl: async (url) => {
        if (url.endsWith('/workflows/ci.yml')) return response({ id: 7 });
        if (url.includes('/artifacts/88/zip')) {
          downloads++;
          return new Response(zip);
        }
        if (url.includes('/runs?'))
          return response({ workflow_runs: [run(1)] });
        if (url.includes('/artifacts?'))
          return response({
            artifacts: [
              {
                id: 88,
                name: 'ci-timing-report',
                expired: false,
                size_in_bytes: zip.byteLength,
              },
            ],
          });
        if (url.includes('/jobs?'))
          return response({ jobs: [job('CI result')] });
        throw Error('Unexpected mock endpoint');
      },
    },
  );
  assert.equal(failed, false);
  assert.equal(downloads, 1);
  assert.equal(report.selectedCacheSnapshotRequested, true);
  assert.equal(report.historicalCacheRunLimit, 0);
  assert.equal(report.runs[0].cacheMetrics.caches.rust.exactHits, 1);
  assert.deepEqual(report.warnings, []);
});

test('analysis CLI entry runs through a directory alias and reports invalid arguments', async (t) => {
  const directory = await temporary(t),
    alias = path.join(directory, 'scripts alias');
  await symlink(
    fileURLToPath(new URL('.', import.meta.url)),
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const env = { ...process.env, GITHUB_TOKEN: '' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [path.join(alias, 'ci-analysis.mjs'), '--invalid-option'],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CI analysis could not write its report/);

  const preload = path.join(directory, 'offline-api.mjs');
  await writeFile(
    preload,
    `
    globalThis.fetch = async url => {
      const pathname = new URL(url).pathname;
      const json = value => new Response(JSON.stringify(value));
      if (pathname.endsWith('/workflows/ci.yml')) return json({id: 7});
      if (pathname.endsWith('/workflows/7/runs')) return json({workflow_runs: [{
        id: 1, workflow_id: 7, run_number: 1, run_attempt: 1,
        status: 'completed', conclusion: 'success', created_at: '2026-10-31T01:00:00Z'
      }]});
      if (pathname.endsWith('/runs/1/attempts/1/jobs')) return json({jobs: [{
        name: 'CI result', status: 'completed', conclusion: 'success', steps: [],
        started_at: '2026-10-31T01:00:02Z', completed_at: '2026-10-31T01:00:10Z'
      }]});
      throw Error('Unexpected offline fixture endpoint');
    };
  `,
  );
  const output = path.join(directory, 'report.json');
  const valid = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(preload).href,
      path.join(alias, 'ci-analysis.mjs'),
      '--latest',
      '--previous-runs',
      '0',
      '--metrics-dir',
      path.join(directory, 'absent'),
      '--output',
      output,
    ],
    {
      env: {
        ...env,
        GITHUB_TOKEN: 'OFFLINE_FIXTURE_TOKEN',
        GITHUB_REPOSITORY: 'owner/repo',
      },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /CI analysis artifact written/);
  assert.equal(
    JSON.parse(await readFile(output, 'utf8')).runs[0]
      .validationFeedbackSeconds,
    10,
  );
  assert.match(
    await readFile(path.join(directory, 'report.md'), 'utf8'),
    /Validation feedback/,
  );
});
