import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateMetric } from './ci-metrics.mjs';

const categories = ['setup', 'test', 'build', 'check', 'post', 'other'];
const seconds = (start, end) => {
  const a = typeof start === 'string' ? Date.parse(start) : NaN,
    b = typeof end === 'string' ? Date.parse(end) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a
    ? (b - a) / 1000
    : null;
};
export function stepCategory(name = '') {
  if (/^(?:post\b|complete job\b)/i.test(name)) return 'post';
  if (
    /checkout|set.?up|install|cache|restore|(?:download|upload).*artifact/i.test(
      name,
    )
  )
    return 'setup';
  if (
    /\b(?:clippy|lint|typecheck)\b|test:types|\b(?:fmt|format)\b.*--check/i.test(
      name,
    )
  )
    return 'check';
  if (
    /\b(?:tests?|playwright|conformance|reference|endurance|browser|integration|unit)\b/i.test(
      name,
    )
  )
    return 'test';
  if (/\b(?:build|compile)\b|package native/i.test(name)) return 'build';
  if (/\b(?:checks?|types?|validate|scope|verify|audit)\b/i.test(name))
    return 'check';
  return 'other';
}
export function analyzeJob(job, run) {
  const stepsAvailable = Array.isArray(job.steps);
  const breakdown = Object.fromEntries(
    categories.map((name) => [
      name,
      {
        knownSeconds: stepsAvailable ? 0 : null,
        unknownSteps: stepsAvailable ? 0 : null,
      },
    ]),
  );
  const steps = (stepsAvailable ? job.steps : []).map((step) => {
    const category = stepCategory(step.name),
      durationSeconds = seconds(step.started_at, step.completed_at);
    if (durationSeconds === null) breakdown[category].unknownSteps++;
    else breakdown[category].knownSeconds += durationSeconds;
    return {
      number: step.number ?? null,
      name: step.name ?? null,
      status: step.status ?? null,
      conclusion: step.conclusion ?? null,
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
      category,
      durationSeconds,
    };
  });
  return {
    id: job.id ?? null,
    name: job.name ?? null,
    status: job.status ?? null,
    conclusion: job.conclusion ?? null,
    runnerName: job.runner_name ?? null,
    labels: job.labels ?? [],
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    durationSeconds: seconds(job.started_at, job.completed_at),
    waitBeforeStartSeconds: seconds(run.created_at, job.started_at),
    waitBaseline:
      'workflow run created_at; includes dependency waits and rerun delays, not pure runner queue',
    breakdown,
    stepsAvailable,
    steps,
  };
}
export function cacheSummary(metrics, names = []) {
  const keys = [
    ...new Set([
      ...names,
      ...metrics.flatMap((record) => Object.keys(record.caches)),
    ]),
  ].sort();
  return {
    observedRecords: metrics.length,
    caches: Object.fromEntries(
      keys.map((name) => {
        const applicable = metrics.filter((record) =>
          Object.hasOwn(record.caches, name),
        );
        if (!applicable.length)
          return [
            name,
            {
              availability: 'unknown',
              applicableRecords: 0,
              exactHits: null,
              notExactHits: null,
              unknown: null,
            },
          ];
        const values = applicable.map((record) => record.caches[name]);
        return [
          name,
          {
            availability: 'observed',
            applicableRecords: applicable.length,
            exactHits: values.filter((value) => value === true).length,
            notExactHits: values.filter((value) => value === false).length,
            unknown: values.filter((value) => value === 'unknown').length,
          },
        ];
      }),
    ),
  };
}
const validationJobs = (jobs) =>
  (jobs || []).filter(
    (job) =>
      /unit|types|integration|browser|native|conformance|reference|\btest\b/i.test(
        job.name || '',
      ) && !/timing.*report|change scope|ci result/i.test(job.name || ''),
  );
export function runCohort(run, jobs) {
  if (!jobs) return 'unknown';
  if (run.status !== 'completed') return 'in-progress-snapshot';
  if (run.conclusion !== 'success') return 'unsuccessful';
  const platform = validationJobs(jobs);
  if (!platform.length) return 'unknown-success';
  if (platform.every((job) => job.conclusion === 'skipped'))
    return 'scope-limited-success';
  return platform
    .filter((job) => job.conclusion !== 'skipped')
    .every((job) => job.conclusion === 'success')
    ? 'platform-success'
    : 'unknown-success';
}
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function historicalMedians(runs) {
  const groups = new Map();
  for (const run of runs.filter((run) => run.role === 'previous')) {
    const signature = JSON.stringify(
        validationJobs(run.jobs)
          .map((job) => job.name)
          .sort(),
      ),
      key = run.cohort + '\0' + signature;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()].map((group) => ({
    cohort: group[0].cohort,
    validationJobNames: validationJobs(group[0].jobs)
      .map((job) => job.name)
      .sort(),
    runs: group.length,
    validationFeedbackMedianSeconds: median(
      group
        .map((run) => run.validationFeedbackSeconds)
        .filter((value) => value !== null),
    ),
    runnerWorkMedianSeconds: median(
      group
        .map((run) => run.runnerWorkSeconds)
        .filter((value) => value !== null),
    ),
    categoryMedians: Object.fromEntries(
      categories.map((name) => {
        const complete = group.filter(
          (run) =>
            run.breakdown[name].knownSeconds !== null &&
            run.breakdown[name].unknownSteps === 0,
        );
        return [
          name,
          {
            medianKnownSeconds: median(
              complete.map((run) => run.breakdown[name].knownSeconds),
            ),
            runsWithCompleteCategoryTimes: complete.length,
            runsWithUnknownCategoryTimes: group.length - complete.length,
          },
        ];
      }),
    ),
  }));
}
export function feedbackTimings(jobs, run) {
  const completed = (jobs || []).filter((job) => job.status === 'completed');
  const known = completed.filter((job) => job.durationSeconds !== null);
  const result = (jobs || []).find((job) => job.name === 'CI result');
  return {
    validationFeedbackSeconds:
      result?.status === 'completed'
        ? seconds(run.created_at, result.completedAt)
        : null,
    runnerWorkSeconds: known.length
      ? known.reduce((sum, job) => sum + job.durationSeconds, 0)
      : null,
    completedJobsWithKnownDuration: known.length,
    completedJobsWithUnknownDuration: completed.length - known.length,
  };
}
const ZIP_LIMIT = 2 * 1024 * 1024;
const SNAPSHOT_LIMIT = 256 * 1024;
function trustedArtifactLocation(location) {
  let url;
  try {
    url = new URL(location);
  } catch {
    throw Error('Invalid artifact download location.');
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(
      host.endsWith('.blob.core.windows.net') ||
      host === 'actions.githubusercontent.com' ||
      host.endsWith('.actions.githubusercontent.com') ||
      host === 'objects.githubusercontent.com' ||
      host === 'github.com'
    )
  ) {
    throw Error('Untrusted artifact download location.');
  }
  return url;
}
async function boundedZip(response) {
  if (!response.ok)
    throw Error(`Artifact download failed (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > ZIP_LIMIT) {
    await response.body?.cancel();
    throw Error('Artifact ZIP exceeds 2 MiB.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Artifact download has no body.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ZIP_LIMIT) throw Error('Artifact ZIP exceeds 2 MiB.');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw Error('Artifact download failed or exceeded its size limit.');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function parseCacheSnapshotZip(bytes, expected, unzip) {
  if (bytes.byteLength > ZIP_LIMIT) throw Error('Artifact ZIP exceeds 2 MiB.');
  unzip ??= (await import('fflate')).unzipSync;
  let entries = 0;
  const files = unzip(bytes, {
    filter: (entry) => {
      if (++entries > 64) throw Error('Artifact ZIP exceeds 64 entries.');
      if (entry.name !== 'cache-snapshot.json') return false;
      if (
        !Number.isInteger(entry.originalSize) ||
        entry.originalSize > SNAPSHOT_LIMIT
      )
        throw Error('Cache snapshot exceeds 256 KiB.');
      return true;
    },
  });
  const content = files['cache-snapshot.json'];
  if (!content || content.byteLength > SNAPSHOT_LIMIT)
    throw Error('Missing or oversized cache snapshot.');
  let snapshot;
  try {
    snapshot = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(content),
    );
  } catch {
    throw Error('Invalid cache snapshot JSON.');
  }
  if (
    snapshot.version !== 1 ||
    snapshot.repository !== expected.repository ||
    snapshot.runId !== String(expected.id) ||
    snapshot.runAttempt !== (expected.run_attempt ?? 1) ||
    !Array.isArray(snapshot.metrics) ||
    snapshot.metrics.length > 500
  ) {
    throw Error(
      'Cache snapshot identity does not match the selected run attempt.',
    );
  }
  return snapshot.metrics.map((record) => {
    const metric = validateMetric(record);
    if (
      metric.repository !== snapshot.repository ||
      metric.runId !== snapshot.runId ||
      metric.runAttempt !== snapshot.runAttempt
    )
      throw Error('Cache metric identity does not match its snapshot.');
    return metric;
  });
}
export async function readMetrics(directory) {
  const records = [],
    warnings = [];
  let files = 0;
  async function visit(file, depth = 0) {
    const info = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (depth > 5)
        throw Error('CI metrics nesting exceeds five directories.');
      for (const name of await readdir(file))
        await visit(path.join(file, name), depth + 1);
    } else if (info.isFile() && file.endsWith('.json')) {
      if (++files > 500) throw Error('CI metrics exceed 500 files.');
      try {
        if (info.size > 65536) throw Error();
        records.push(validateMetric(JSON.parse(await readFile(file, 'utf8'))));
      } catch {
        warnings.push(`Ignored invalid cache metric: ${path.basename(file)}`);
      }
    }
  }
  await visit(directory);
  return { records, warnings };
}
export function githubClient({ token, fetchImpl = fetch, delay = sleep } = {}) {
  if (!token)
    throw Error('GITHUB_TOKEN is required for CI analysis (actions: read).');
  async function get(endpoint) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl('https://api.github.com' + endpoint, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (attempt < 2) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        throw Error('GitHub API request could not complete.');
      }
      const retry =
        [429, 500, 502, 503, 504].includes(response.status) ||
        (response.status === 403 &&
          (response.headers.get('retry-after') !== null ||
            response.headers.get('x-ratelimit-remaining') === '0'));
      if (!response.ok) {
        if (retry && attempt < 2) {
          await response.body?.cancel();
          await delay(
            Math.min(
              2000,
              Math.max(
                500,
                Number(response.headers.get('retry-after') || 0) * 1000,
              ),
            ),
          );
          continue;
        }
        throw Error(`GitHub API request failed (HTTP ${response.status}).`);
      }
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024)
        throw Error('GitHub API response exceeds the analysis limit.');
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw Error('GitHub API returned invalid JSON.');
      }
      return {
        data,
        hasNext: /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(
          response.headers.get('link') || '',
        ),
      };
    }
  }
  async function list(endpoint, key, limit = 1000) {
    const items = [];
    let page = 1;
    for (;;) {
      const result = await get(
        `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      if (!Array.isArray(result.data[key]))
        throw Error('GitHub API list has an unexpected shape.');
      items.push(...result.data[key]);
      if (items.length >= limit || !result.hasNext)
        return items.slice(0, limit);
      if (++page > 10) throw Error('GitHub API pagination exceeds ten pages.');
    }
  }
  async function downloadArtifact(repository, id) {
    if (
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(id) ||
      id < 1
    )
      throw Error('Invalid artifact identity.');
    let response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        },
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = trustedArtifactLocation(
          response.headers.get('location'),
        );
        await response.body?.cancel();
        response = await fetchImpl(location.href, {
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
      }
    } catch {
      throw Error(
        'Artifact download request failed or used an untrusted redirect.',
      );
    }
    return boundedZip(response);
  }
  return {
    get: async (endpoint) => (await get(endpoint)).data,
    list,
    downloadArtifact,
  };
}
export async function collectAnalysis(
  {
    repository,
    runId,
    latest = false,
    workflow = 'ci.yml',
    previousRuns = 10,
    metrics = [],
    historicalCaches = false,
  },
  api,
) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || ''))
    throw Error('GITHUB_REPOSITORY must be owner/repository.');
  if (!Number.isInteger(previousRuns) || previousRuns < 0 || previousRuns > 20)
    throw Error('--previous-runs must be between 0 and 20.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(workflow))
    throw Error('--workflow must be a workflow filename or ID.');
  if (latest && runId) throw Error('Use either --latest or --run-id.');
  if (!latest && !/^\d+$/.test(String(runId || '')))
    throw Error('A run ID or --latest is required.');
  const base = `/repos/${repository}/actions`,
    workflowInfo = await api.get(
      `${base}/workflows/${encodeURIComponent(workflow)}`,
    ),
    warnings = [];
  const runEndpoint = `${base}/workflows/${workflowInfo.id}/runs?status=completed`;
  let completed = latest
    ? await api.list(runEndpoint, 'workflow_runs', previousRuns + 1)
    : [];
  const current = latest
    ? completed
        .filter((run) => run.status === 'completed')
        .sort((a, b) => b.run_number - a.run_number)[0]
    : await api.get(`${base}/runs/${runId}`);
  if (!current) throw Error('No completed CI workflow run was found.');
  if (current.workflow_id !== workflowInfo.id)
    throw Error(
      'The selected run belongs to another workflow; use --latest to analyze CI from a manual workflow.',
    );
  if (!latest && previousRuns) {
    const created =
      typeof current.created_at === 'string' &&
      Number.isFinite(Date.parse(current.created_at))
        ? `&created=${encodeURIComponent('<=' + current.created_at)}`
        : '';
    completed = await api.list(
      runEndpoint + created,
      'workflow_runs',
      previousRuns + 1,
    );
  }
  const sorted = completed
    .filter((run) => run.status === 'completed')
    .sort((a, b) => b.run_number - a.run_number);
  const history = sorted
    .filter(
      (run) => run.id !== current.id && run.run_number < current.run_number,
    )
    .slice(0, previousRuns);
  const usable = metrics.filter((record) => record.repository === repository);
  const selectedCacheSnapshotRequested =
    historicalCaches &&
    current.status === 'completed' &&
    !usable.some(
      (record) =>
        record.runId === String(current.id) &&
        record.runAttempt === (current.run_attempt ?? 1),
    );
  if (historicalCaches)
    for (const run of [
      ...(selectedCacheSnapshotRequested ? [current] : []),
      ...history.slice(0, 5),
    ]) {
      if (
        usable.some(
          (record) =>
            record.runId === String(run.id) &&
            record.runAttempt === (run.run_attempt ?? 1),
        )
      )
        continue;
      try {
        const artifacts = await api.list(
          `${base}/runs/${run.id}/artifacts`,
          'artifacts',
          100,
        );
        const artifact = artifacts
          .filter(
            (item) =>
              item.name === 'ci-timing-report' && item.expired === false,
          )
          .sort((a, b) => b.id - a.id)[0];
        if (
          !artifact ||
          !Number.isFinite(artifact.size_in_bytes) ||
          artifact.size_in_bytes > ZIP_LIMIT
        )
          throw Error(
            'Cache snapshot artifact is missing, expired or oversized.',
          );
        const bytes = await api.downloadArtifact(repository, artifact.id);
        usable.push(
          ...(await parseCacheSnapshotZip(bytes, { ...run, repository })),
        );
      } catch {
        warnings.push(
          `Run ${run.id}: historical cache snapshot unavailable; cache state remains unknown.`,
        );
      }
    }
  const cacheNames = [
    ...new Set(usable.flatMap((record) => Object.keys(record.caches))),
  ];
  const runs = [];
  for (const run of [current, ...history]) {
    let jobs = null;
    try {
      const attempt = run.run_attempt ? `/attempts/${run.run_attempt}` : '';
      jobs = (
        await api.list(`${base}/runs/${run.id}${attempt}/jobs`, 'jobs')
      ).map((job) => analyzeJob(job, run));
    } catch (error) {
      warnings.push(`Run ${run.id}: ${error.message}`);
    }
    const local = usable.filter(
      (record) =>
        record.runId === String(run.id) &&
        record.runAttempt === (run.run_attempt ?? 1),
    );
    const breakdown = Object.fromEntries(
      categories.map((name) => [
        name,
        {
          knownSeconds: jobs?.every((job) => job.stepsAvailable)
            ? jobs.reduce(
                (sum, job) => sum + job.breakdown[name].knownSeconds,
                0,
              )
            : null,
          unknownSteps: jobs?.every((job) => job.stepsAvailable)
            ? jobs.reduce(
                (sum, job) => sum + job.breakdown[name].unknownSteps,
                0,
              )
            : null,
        },
      ]),
    );
    runs.push({
      id: run.id,
      number: run.run_number ?? null,
      attempt: run.run_attempt ?? null,
      role: run.id === current.id ? 'selected' : 'previous',
      headSha: run.head_sha ?? null,
      event: run.event ?? null,
      branch: run.head_branch ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      cohort: runCohort(run, jobs),
      snapshot: run.status !== 'completed',
      createdAt: run.created_at ?? null,
      updatedAt: run.updated_at ?? null,
      jobs,
      breakdown,
      ...feedbackTimings(jobs, run),
      cacheMetrics: cacheSummary(local, cacheNames),
      metricRecords: local,
    });
  }
  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    collectionStatus: warnings.length
      ? 'partial'
      : current.status === 'completed'
        ? 'complete'
        : 'snapshot',
    repository,
    workflow: workflowInfo.path ?? workflow,
    selectedRunId: current.id,
    currentSnapshot: current.status !== 'completed',
    requestedPreviousRuns: previousRuns,
    availablePreviousRuns: history.length,
    historicalCacheRunLimit: historicalCaches ? Math.min(5, history.length) : 0,
    selectedCacheSnapshotRequested,
    runs,
    historicalMedians: historicalMedians(runs),
    warnings,
    limitations: [
      'Wait before job start is measured from workflow creation; it includes dependency waits and rerun delays and is not pure runner queue time.',
      'Step categories and run cohorts are inferred from names/statuses. scope-limited-success means all observed platform jobs were skipped; documentation-only scope is not proven by the jobs API. Missing, invalid or unfinished timestamps remain null; known category totals exclude unknown durations. Parallel job/step totals are not workflow wall time.',
      'Cache values report exact-key matches. false may include a restored fallback key; it does not mean no cache was restored. Only metric records explicitly declaring a cache enter its observed denominator. Missing historical metrics are unknown, never false.',
      'Optional historical cache snapshots cover at most five previous completed runs, plus the selected completed run when its local metrics are missing, with bounded in-memory ZIP parsing and no extraction. Older or unavailable snapshots remain unknown. Validation feedback ends at the exact CI result job; runner work sums only completed jobs with known durations.',
      'Historical medians are grouped by cohort and observed validation job names, across branches/events. Workloads may still change; these are descriptive observations, not controlled cold/warm or shard benchmarks. No raw logs or credentials are collected.',
    ],
  };
}
const escape = (value) =>
  String(value ?? 'unknown')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ');
const time = (value) => (value === null ? 'unknown' : `${value.toFixed(1)} s`);
export function markdownSummary(report) {
  const lines = [
    '## CI timing and cache analysis',
    '',
    `Collection: **${report.collectionStatus}**${report.currentSnapshot ? ' (current run is an unfinished snapshot)' : ''}. Workflow: ${escape(report.workflow)}.`,
    '',
    '| Run | Result / cohort | Jobs | Setup | Test | Build | Check | Post | Other |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of report.runs)
    lines.push(
      `| [${run.number ?? run.id}](https://github.com/${report.repository}/actions/runs/${run.id})${run.role === 'selected' ? ' (selected)' : ''} | ${escape(run.conclusion ?? run.status)} / ${run.cohort} | ${run.jobs?.length ?? 'unknown'} | ${categories.map((name) => time(run.breakdown[name].knownSeconds)).join(' | ')} |`,
    );
  const selected = report.runs[0];
  if (selected)
    lines.push(
      '',
      `Validation feedback: **${time(selected.validationFeedbackSeconds)}** to the completed CI result gate. Completed runner work: **${time(selected.runnerWorkSeconds)}** (sum of job durations, not wall time).`,
    );
  if (selected?.jobs) {
    lines.push(
      '',
      'Selected run job timings (unfinished or missing times stay unknown):',
      '',
      '| Job | Result | Duration | Before job start* | Unknown step durations |',
      '| --- | --- | ---: | ---: | ---: |',
    );
    for (const job of selected.jobs)
      lines.push(
        `| ${escape(job.name)} | ${escape(job.conclusion ?? job.status)} | ${time(job.durationSeconds)} | ${time(job.waitBeforeStartSeconds)} | ${job.stepsAvailable ? categories.reduce((sum, name) => sum + job.breakdown[name].unknownSteps, 0) : 'unknown'} |`,
      );
  }
  lines.push(
    '',
    'Historical category medians (separate cohorts and validation job-name signatures):',
    '',
    '| Cohort | Runs | Validation jobs | Test median | Build median |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const group of report.historicalMedians || [])
    lines.push(
      `| ${group.cohort} | ${group.runs} | ${group.validationJobNames.length} | ${time(group.categoryMedians.test.medianKnownSeconds)} | ${time(group.categoryMedians.build.medianKnownSeconds)} |`,
    );
  lines.push(
    '',
    'Exact-key cache observations (not-exact may still restore a fallback):',
    '',
    '| Run | Cache | Exact hits | Not-exact hits | Unknown | Applicable records |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  for (const run of report.runs) {
    const entries = Object.entries(run.cacheMetrics.caches);
    if (!entries.length)
      lines.push(
        `| ${run.number ?? run.id} | unknown | unknown | unknown | unknown | 0 |`,
      );
    for (const [name, cache] of entries)
      lines.push(
        `| ${run.number ?? run.id} | ${escape(name)} | ${cache.exactHits ?? 'unknown'} | ${cache.notExactHits ?? 'unknown'} | ${cache.unknown ?? 'unknown'} | ${cache.applicableRecords} |`,
      );
  }
  lines.push(
    '',
    ...report.limitations.map((note) => `- ${note}`),
    ...report.warnings.map((warning) => `- Warning: ${escape(warning)}`),
    '',
  );
  return lines.join('\n');
}
export function analysisOptions(args, env = process.env) {
  const options = {
    workflow: 'ci.yml',
    previousRuns: 10,
    metricsDir: 'artifacts/ci-metrics',
    output: 'artifacts/ci-analysis/report.json',
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--latest' || flag === '--historical-caches') {
      options[flag === '--latest' ? 'latest' : 'historicalCaches'] = true;
      continue;
    }
    const key = {
      '--workflow': 'workflow',
      '--run-id': 'runId',
      '--previous-runs': 'previousRuns',
      '--metrics-dir': 'metricsDir',
      '--output': 'output',
    }[flag];
    if (!key || args[index + 1] === undefined)
      throw Error(
        'Use --workflow ci.yml [--latest | --run-id ID] --previous-runs 0..20 --metrics-dir DIR --output FILE.',
      );
    options[key] = args[++index];
  }
  options.previousRuns = Number(options.previousRuns);
  options.latest ??= !options.runId && env.CI_ANALYSIS_LATEST === 'true';
  if (!options.latest && !options.runId) options.runId = env.GITHUB_RUN_ID;
  options.repository = env.GITHUB_REPOSITORY;
  return options;
}
export async function analyzeCli(
  args,
  env = process.env,
  { fetchImpl = fetch } = {},
) {
  const options = analysisOptions(args, env),
    loaded = await readMetrics(options.metricsDir);
  let report,
    failed = false;
  try {
    report = await collectAnalysis(
      { ...options, metrics: loaded.records },
      githubClient({ token: env.GITHUB_TOKEN, fetchImpl }),
    );
    report.warnings.push(...loaded.warnings);
    if (loaded.warnings.length) report.collectionStatus = 'partial';
  } catch (error) {
    failed = true;
    report = {
      version: 1,
      collectedAt: new Date().toISOString(),
      collectionStatus: 'unavailable',
      repository: options.repository ?? null,
      workflow: options.workflow,
      runs: [],
      warnings: [error.message, ...loaded.warnings],
      limitations: [
        'No timing or cache conclusion can be drawn from an unavailable API response. No raw logs or credentials are collected.',
      ],
    };
  }
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  const markdown = markdownSummary(report),
    markdownFile = options.output.endsWith('.json')
      ? options.output.slice(0, -5) + '.md'
      : options.output + '.md';
  await writeFile(markdownFile, markdown, { flag: 'wx' });
  if (report.runs[0]) {
    const selected = report.runs[0];
    const snapshot = {
      version: 1,
      repository: report.repository,
      runId: String(selected.id),
      runAttempt: selected.attempt ?? 1,
      metrics: selected.metricRecords.map(validateMetric),
    };
    const bytes = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > SNAPSHOT_LIMIT)
      throw Error('Selected cache snapshot exceeds 256 KiB.');
    await writeFile(
      path.join(path.dirname(options.output), 'cache-snapshot.json'),
      bytes,
      { flag: 'wx' },
    );
  }
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  return { report, failed };
}
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync.native(fileURLToPath(import.meta.url)) ===
      realpathSync.native(process.argv[1])
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
if (invokedAsCli()) {
  analyzeCli(process.argv.slice(2))
    .then(({ failed }) => {
      console.log('CI analysis artifact written.');
      if (failed) process.exitCode = 1;
    })
    .catch(() => {
      console.error('CI analysis could not write its report.');
      process.exitCode = 1;
    });
}
