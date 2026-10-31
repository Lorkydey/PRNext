import { assertMatchingRuntimeDependencies } from './release-regression-dependencies.mjs';

export const releaseRoutes = Object.freeze(['/ssr', '/api/json', '/stream']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positive = value => Number.isFinite(value) && value > 0;
export function validateReleaseConnections(connections) {
  const bounded = value => Number.isInteger(value) && value >= 1 && value <= 128;
  if (bounded(connections)) return Object.fromEntries(releaseRoutes.map(route => [route, connections]));
  if (!connections || typeof connections !== 'object' || Array.isArray(connections) || Reflect.ownKeys(connections).length !== releaseRoutes.length || releaseRoutes.some(route => !Object.hasOwn(connections, route) || !bounded(connections[route]))) {
    throw new Error('Use 1–128 connections, or an exact connection profile for /ssr, /api/json and /stream with integer values in that range.');
  }
  return Object.fromEntries(releaseRoutes.map(route => [route, connections[route]]));
}
export function validateReleaseBudgets(budgets) {
  if (!budgets || !positive(budgets.throughputDropPercent) || budgets.throughputDropPercent > 30 || !positive(budgets.p95IncreasePercent) || budgets.p95IncreasePercent > 50 || !positive(budgets.maxNoisePercent) || budgets.maxNoisePercent > 25 || !positive(budgets.maxGeneratorCpuPercent) || budgets.maxGeneratorCpuPercent > 100) throw new Error('Provide bounded relative throughput, latency and noise budgets.');
}
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const noise = values => 100 * 1.4826 * median(values.map(value => Math.abs(value - median(values)))) / median(values);

// An exact, conservative sign-based interval for a population median under
// independent paired samples. Measurements retain their order so that the
// independence assumption is visible rather than implied by a confidence label.
export function medianInterval(values) {
  if (values.length < 6 || values.some(value => !positive(value))) throw new Error('At least six valid paired repetitions are required.');
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  let combination = 1, tail = 1, trim = 0, coverage = 1 - 2 / 2 ** n;
  for (let k = 2; k <= Math.floor(n / 2); k++) {
    combination *= (n - (k - 2)) / (k - 1);
    tail += combination;
    const candidate = 1 - 2 * tail / 2 ** n;
    if (candidate < 0.95) break;
    trim = k - 1; coverage = candidate;
  }
  return { median: median(sorted), low: sorted[trim], high: sorted[n - 1 - trim], coverage, assumption: 'Independent paired repetitions; shared-host contention and order effects can violate this assumption.' };
}

function validateLoad(result, workload, route, warmup, connections) {
  const seconds = warmup ? workload.warmupSeconds : workload.seconds;
  if (!result || result.config?.route !== route || result.config.seconds !== seconds || result.config.connections !== connections || (result.config.mode || 'closed') !== 'closed' || (result.config.encoding || 'identity') !== 'identity' || result.config.rsc) throw new Error('Load generator workloads do not match.');
  const url = new URL(result.config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only owned loopback HTTP servers are valid benchmark targets.');
  if (!positive(result.durationSeconds) || result.durationSeconds !== seconds || !positive(result.elapsedSeconds) || result.elapsedSeconds < seconds || result.elapsedSeconds > seconds + 15 || !Number.isInteger(result.started) || result.started < 1 || result.started !== result.completed || result.started !== result.usefulCompleted || !Number.isInteger(result.usefulWithinWindow) || result.usefulWithinWindow < (warmup ? 0 : 1) || result.usefulWithinWindow > result.usefulCompleted || result.completedWithinWindow !== result.usefulWithinWindow) throw new Error('Incomplete benchmark request accounting.');
  for (const name of ['errors', 'transportErrors', 'httpErrors', 'validationErrors', 'overflow', 'dropped']) if (result[name] !== 0) throw new Error('Benchmark contains errors, dropped requests or truncated latency measurements.');
  if (!same(result.statuses, { 200: result.started }) || !same(result.perRoute, { [route]: result.started }) || Object.keys(result.failures || {}).length) throw new Error('Benchmark response accounting does not match the measured scenario.');
  if (!(warmup ? Number.isFinite(result.rps) && result.rps >= 0 : positive(result.rps)) || Math.abs(result.rps - result.usefulWithinWindow / seconds) > 1e-8 || !positive(result.p95) || !Number.isFinite(result.generatorCpuPercent) || result.generatorCpuPercent < 0 || !Number.isFinite(result.generatorCpuSeconds) || result.generatorCpuSeconds < 0) throw new Error('Missing useful throughput, p95 or measured generator CPU.');
}

/** Refuse incomplete evidence before calculating any release gate. */
export function checkReleaseRegression(report) {
  if (!report || report.version !== 1 || report.complete !== true || !report.environment || !report.workload || !Array.isArray(report.samples)) throw new Error('Incomplete release performance report.');
  const workload = report.workload, budgets = report.budgets;
  const connectionsByRoute = validateReleaseConnections(workload.connections);
  if (!same(workload.routes, releaseRoutes) || !positive(workload.seconds) || workload.seconds < 1 || workload.seconds > 120 || !positive(workload.warmupSeconds) || workload.warmupSeconds < 0.25 || workload.warmupSeconds > 30 || !Number.isInteger(workload.workers) || workload.workers < 1 || workload.workers > 16 || !Number.isInteger(workload.repetitions) || workload.repetitions < 6 || workload.repetitions > 20 || workload.repetitions % 2 || !/^[a-f0-9]{64}$/.test(workload.fixtureSha256 || '') || !/^[a-f0-9]{64}$/.test(workload.generatorSha256 || '')) throw new Error('Invalid or unmatched release benchmark workload.');
  validateReleaseBudgets(budgets);
  const environment = report.environment;
  for (const key of ['platform', 'arch', 'release', 'cpuModel', 'node', 'nodeSha256', 'controls']) if (!environment[key]) throw new Error('Incomplete machine and resource-control provenance.');
  if (!/^[a-f0-9]{64}$/.test(environment.nodeSha256)) throw new Error('The exact Node executable digest is required.');
  if (!Number.isInteger(environment.logicalCpus) || environment.logicalCpus < 1 || !positive(environment.totalMemoryBytes)) throw new Error('Incomplete machine capacity.');
  for (const variant of ['baseline', 'candidate']) {
    const artifact = report.artifacts?.[variant];
    if (!artifact || artifact.installationVerified !== true || !/^[a-f0-9]{40}$/.test(artifact.source?.declaredCommit || '') || !/^[a-f0-9]{64}$/.test(artifact.binarySha256 || '') || !Array.isArray(artifact.archives) || artifact.archives.length !== 2 || artifact.archives.some(value => !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !value.name || !value.version || !Number.isInteger(value.bytes) || value.bytes < 1)) throw new Error('Exact framework/native archives and installed bytes are required for both variants.');
    if (!artifact.archives.some(value => value.name === '@thomas.f/prnext') || new Set(artifact.archives.map(value => value.name)).size !== 2 || new Set(artifact.archives.map(value => value.version)).size !== 1) throw new Error('One framework and one matching native version are required.');
  }
  assertMatchingRuntimeDependencies(report.artifacts.baseline.runtimeDependencies, report.artifacts.candidate.runtimeDependencies);
  const expected = workload.repetitions * 2 * releaseRoutes.length;
  if (report.samples.length !== expected) throw new Error('Incomplete paired scenario repetitions.');
  let position = 0, generatorSaturated = false;
  const groups = Object.fromEntries(releaseRoutes.map(route => [route, { baseline: [], candidate: [] }]));
  for (let repetition = 0; repetition < workload.repetitions; repetition++) {
    const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    const routes = releaseRoutes.map((_, index) => releaseRoutes[(index + repetition) % releaseRoutes.length]);
    for (const variant of order) for (const route of routes) {
      const sample = report.samples[position++];
      if (sample.repetition !== repetition || sample.variant !== variant || sample.route !== route || !same(sample.environment, environment) || !same(sample.controlsBefore, sample.controlsAfter) || !same(sample.controlsBefore, environment.controls)) throw new Error('Benchmark order, workload or effective environment/resource controls do not match.');
      validateLoad(sample.warmup, workload, route, true, connectionsByRoute[route]);
      validateLoad(sample.measurement, workload, route, false, connectionsByRoute[route]);
      generatorSaturated ||= sample.measurement.generatorCpuPercent > budgets.maxGeneratorCpuPercent;
      // Target memory/CPU are intentionally absent unless a separate, complete
      // descendant-aware sampler actually measured them.
      if (sample.serverCpuSeconds !== null || sample.serverMemoryBytes !== null) throw new Error('This harness does not certify server CPU or memory measurements.');
      groups[route][variant].push(sample.measurement);
    }
  }
  const scenarios = [];
  for (const route of releaseRoutes) {
    const { baseline, candidate } = groups[route];
    const throughput = medianInterval(candidate.map((value, index) => value.rps / baseline[index].rps));
    const latency = medianInterval(candidate.map((value, index) => value.p95 / baseline[index].p95));
    const noisePercent = Math.max(...[baseline.map(value => value.rps), candidate.map(value => value.rps), baseline.map(value => value.p95), candidate.map(value => value.p95)].map(noise));
    const floor = 1 - budgets.throughputDropPercent / 100, ceiling = 1 + budgets.p95IncreasePercent / 100;
    const status = noisePercent > budgets.maxNoisePercent || generatorSaturated ? 'inconclusive'
      : throughput.high < floor || latency.low > ceiling ? 'regressed'
      : throughput.low >= floor && latency.high <= ceiling ? 'passed' : 'inconclusive';
    scenarios.push({ route, connections: connectionsByRoute[route], status, baseline: { usefulRpsMedian: median(baseline.map(value => value.rps)), p95MedianMs: median(baseline.map(value => value.p95)) }, candidate: { usefulRpsMedian: median(candidate.map(value => value.rps)), p95MedianMs: median(candidate.map(value => value.p95)) }, throughputRatio: throughput, p95Ratio: latency, noisePercent });
  }
  return { status: scenarios.some(value => value.status === 'regressed') ? 'regressed' : scenarios.some(value => value.status === 'inconclusive') ? 'inconclusive' : 'passed', scenarios, generatorSaturated, limitation: 'Local shared-host experiment. Declared source commits are labels; framework/native archive bytes and matching installed React/scheduler bytes are verified. Other build/transitive dependencies are not certified. Linux affinity and accessible cgroup ancestors are recorded; namespace-hidden limits remain unknown. No quota or affinity is imposed by this harness. Server CPU and memory are not measured. Results apply to each route’s declared concurrency; calibrated API load does not establish maximum capacity. A passing result applies only to this fixture and environment.' };
}
