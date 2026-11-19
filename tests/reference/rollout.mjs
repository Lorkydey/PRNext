import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import cacheProvider from '../../packages/prnext/compat/redis-cache.cjs';
import { redisServer } from '../redis-test-support.mjs';
import { observeProcessTree } from '../performance/process-tree.mjs';
import { repositoryRoot } from '../support.mjs';
import { referenceFixture } from './fixture.mjs';
import { referenceBrowserOptions } from './security-scenarios.mjs';

const { values } = parseArgs({ options: {
  run: { type: 'boolean' }, 'hold-seconds': { type: 'string' }, 'output-directory': { type: 'string' },
} });
assert.ok(values.run, 'Use --run to start the isolated PostgreSQL, Redis and supervisor rehearsal.');
const seconds = Number(values['hold-seconds'] ?? 10);
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 120, 'Use a hold between 5 and 120 seconds.');
const directory = path.resolve(values['output-directory'] || path.join(repositoryRoot, 'artifacts/saas-rollout'));
const config = createRequire(new URL('../toolchain/package.json', import.meta.url));
const routePath = 'app/api/reference-rollout/route.js';
const cachePath = 'app/api/reference-rollout/catalogue.js';
const healthPath = '/api/reference-rollout-health';
const namespace = 'reference-rollout';
const entryKey = 'catalogue';
const sharedValue = 'shared-public-catalogue';
const catalogueCache = `
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const { createRedisCache } = require('@thomas.f/prnext/cache/redis');
const { createClient } = require(process.env.ROLLOUT_REDIS_MODULE);
let cache;
function connectedCache() {
  return cache ??= (async () => {
    const client = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
    client.on('error', () => {});
    await client.connect();
    return createRedisCache({ namespace: ${JSON.stringify(namespace)}, client });
  })().catch(error => { cache = undefined; throw error; });
}
export async function readCatalogue() {
  const cached = await (await connectedCache()).get(${JSON.stringify(entryKey)});
  return cached && new Response(cached.value).text();
}
`;

const route = generation => `
import { getAuth } from '../../../lib/auth.js';
import { getPool } from '../../../lib/database.js';
import { saveNoteIdempotently } from '../../../lib/note-commands.js';
import { readCatalogue } from './catalogue.js';

const generation = ${JSON.stringify(generation)};
const headers = { 'cache-control': 'private, no-store' };
export async function GET(request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: 'authentication' }, { status: 401, headers });
  const catalogue = await readCatalogue();
  return Response.json({ generation, userId: session.user.id, catalogue }, { headers });
}
export async function POST(request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: 'authentication' }, { status: 401, headers });
  const { key, body } = await request.json();
  const result = await saveNoteIdempotently(getPool(), { userId: session.user.id, key, body });
  return Response.json({ generation, userId: session.user.id, ...result }, { headers });
}
`;
const healthRoute = generation => `
import { existsSync } from 'node:fs';
import { getAuth } from '../../../lib/auth.js';
import { getPool } from '../../../lib/database.js';
import { readCatalogue } from '../reference-rollout/catalogue.js';
export async function GET() {
  if (${JSON.stringify(generation)} === 'B' && existsSync(process.env.ROLLOUT_FAULT_FILE)) {
    return Response.json({ ok: false }, { status: 503 });
  }
  // Warm shared clients and check the cache before this worker sees traffic.
  getAuth();
  const [, catalogue] = await Promise.all([getPool().query('SELECT 1'), readCatalogue()]);
  if (catalogue !== ${JSON.stringify(sharedValue)}) return Response.json({ ok: false }, { status: 503 });
  return Response.json({ ok: true });
}
`;

const measurements = new Map();
const report = {
  complete: false, platform: process.platform, node: process.version, holdSeconds: seconds,
  concurrentClients: 4, phases: [], memory: [], errors: [], replacementFirstResponseMs: {},
};
let phase = 'baseline', stopping = false;
let redis, client, cache, fixture, pool, browser, launchAttempted = false;
let load = [], memory;
const save = () => writeFile(path.join(directory, 'rollout.json'), JSON.stringify(report, null, 2) + '\n');
const log = message => console.log('[rollout] ' + message);
const command = async (...args) => (await fixture.run([fixture.cli, ...args], fixture.root, 90000)).stdout;
const status = async () => {
  const { apps, daemonPid } = JSON.parse(await command('pstatus', 'saas-rollout', '--json'));
  assert.ok(apps[0].pid && daemonPid);
  return { app: apps[0], daemonPid };
};

function record(stage, method, generation, elapsed) {
  const identity = stage + '/' + method + '/' + generation;
  if (!measurements.has(identity)) measurements.set(identity, { stage, method, generation, times: [] });
  measurements.get(identity).times.push(elapsed);
}

async function exercise(user, method) {
  const started = performance.now(), stage = phase;
  const response = await user.context.request.fetch(fixture.origin + '/api/reference-rollout', {
    method, timeout: 8000, maxRedirects: 0,
    ...(method === 'POST' ? { data: { key: user.key, body: user.body } } : {}),
  });
  try {
    assert.equal(response.status(), 200, 'Authenticated rollout request failed');
    const data = await response.json();
    assert.equal(data.userId, user.id, 'The request must keep its own account');
    assert.ok(['A', 'B'].includes(data.generation));
    if (method === 'GET') assert.equal(data.catalogue, sharedValue, 'Both generations must read the same Redis entry');
    else {
      assert.match(data.id, /^[a-f0-9-]{36}$/);
      user.ids.add(data.id);
      if (!data.replayed) user.claims++;
    }
    const elapsed = performance.now() - started;
    if (data.generation === 'B') report.replacementFirstResponseMs[method] ??= Math.round(elapsed * 100) / 100;
    record(stage, method, data.generation, elapsed);
    return data.generation;
  } finally {
    await response.dispose();
  }
}

async function register(index) {
  const context = await browser.newContext({ ...referenceBrowserOptions, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push({ stage: phase, method: 'browser', kind: error.name }));
  const email = 'rollout-' + index + '@example.test';
  await page.goto(fixture.origin + '/en/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Rollout ' + index);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Reference-' + randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(fixture.origin + '/en/dashboard');
  await expect(page.getByTestId('account')).toContainText(email);
  const { rows: [user] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
  return { context, page, email, id: user.id, key: randomUUID(), body: 'ROLLOUT_NOTE_' + index, ids: new Set(), claims: 0 };
}

async function verifyDashboard(user, other, version) {
  const response = await user.page.goto(fixture.origin + '/en/dashboard');
  assert.equal(response.status(), 200);
  await expect(user.page.getByTestId('account')).toContainText(user.email);
  await expect(user.page.getByText(user.body, { exact: true })).toHaveCount(1);
  await expect(user.page.getByText(other.body, { exact: true })).toHaveCount(0);
  await user.page.getByLabel('Note', { exact: true }).fill('BROWSER_NOTE_' + version + '_' + user.email);
  await user.page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(user.page.getByText('BROWSER_NOTE_' + version + '_' + user.email, { exact: true })).toBeVisible();
}

async function drive(user, method) {
  while (!stopping) {
    const stage = phase;
    try { await exercise(user, method); }
    catch (error) {
      // Record only error class/status, never session cookies or response data.
      report.errors.push({ stage, method, kind: error.name, ...(Number.isInteger(error.actual) ? { status: error.actual } : {}) });
    }
    await delay(65);
  }
}

async function sampleMemory(pid) {
  while (!stopping) {
    const { state, rssSumBytes, processes } = await observeProcessTree(pid);
    report.memory.push({ stage: phase, elapsedMs: Math.round(performance.now() - loadStarted), state, rssSumBytes, processCount: processes.length });
    await delay(1000);
  }
}

const portOf = url => new URL(url).port;
let loadStarted;
await mkdir(directory, { recursive: true });
try {
  await save();
  log('Starting the owned Redis and PostgreSQL services.');
  redis = await redisServer();
  client = config('redis').createClient({ url: redis.url, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  client.on('error', () => {});
  await client.connect();
  cache = cacheProvider.createRedisCache({ namespace, client });
  const lease = await cache.acquire(entryKey);
  try {
    assert.equal(await cache.set(entryKey, Promise.resolve({
      value: new Response(sharedValue).body, tags: [], timestamp: Date.now(), stale: 60, revalidate: 600, expire: 1200,
    }), { lease }), true);
  } finally {
    await lease.release();
  }
  fixture = await referenceFixture({
    artifactsDirectory: directory, onProgress: log,
    extraFiles: { [routePath]: route('A'), [cachePath]: catalogueCache, ['app' + healthPath + '/route.js']: healthRoute('A') },
  });
  report.installation = fixture.evidence;
  const fault = path.join(fixture.root, 'rollout-fault');
  const environment = {
    ...Object.fromEntries(['DATABASE_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET'].map(key => [key, fixture.env[key]])),
    REDIS_URL: redis.url,
    ROLLOUT_REDIS_MODULE: config.resolve('@redis/client').split(path.sep).join('/'),
    ROLLOUT_FAULT_FILE: fault.split(path.sep).join('/'),
  };
  // The manager intentionally strips caller environment; runtime values are
  // provided through the same production dotenv mechanism used by deployments.
  await writeFile(path.join(fixture.root, '.env.production.local'),
    Object.entries(environment).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  fixture.env.PRNEXT_PM_HOME = path.join(fixture.root, '.rollout-manager');
  await fixture.build();
  launchAttempted = true;
  await command('pstart', '.', '--name', 'saas-rollout', '--port', portOf(fixture.backendOrigin),
    '--workers', '1', '--health-path', healthPath, '--health-timeout', '30000',
    '--drain-timeout', '5000', '--rollback-window', '35000');
  const initial = await status();
  pool = await fixture.pool({ max: 2 });
  browser = await chromium.launch();
  const users = [await register(0), await register(1)];
  const anonymous = await browser.newContext(referenceBrowserOptions);
  const unauthorized = await anonymous.request.get(fixture.origin + '/api/reference-rollout');
  assert.equal(unauthorized.status(), 401);
  await anonymous.close();
  for (const user of users) assert.equal(await exercise(user, 'POST'), 'A');
  await Promise.all(users.map((user, i) => verifyDashboard(user, users[1 - i], 'A')));

  log('Applying continuous authenticated reads and explicit write retries.');
  loadStarted = performance.now();
  load = users.flatMap(user => [drive(user, 'GET'), drive(user, 'POST')]);
  memory = sampleMemory(initial.daemonPid).catch(error => report.errors.push({ stage: phase, method: 'memory', kind: error.name }));
  await delay(seconds * 1000);
  phase = 'build-and-switch';
  await writeFile(path.join(fixture.root, routePath), route('B'));
  await writeFile(path.join(fixture.root, 'app' + healthPath + '/route.js'), healthRoute('B'));
  await fixture.build();
  await command('prestart', 'saas-rollout');
  const replacement = await status();
  assert.notEqual(replacement.app.pid, initial.app.pid);
  assert.notEqual(replacement.app.buildId, initial.app.buildId);
  assert.equal(replacement.app.rollback?.previousBuildId, initial.app.buildId);
  phase = 'replacement';
  log('Generation B is active. Both users must keep their sessions, notes and shared Redis catalogue.');
  await Promise.all(users.map((user, i) => verifyDashboard(user, users[1 - i], 'B')));
  await delay(2000);
  phase = 'rollback';
  const faultStarted = performance.now();
  await writeFile(fault, 'unhealthy generation B\n');
  let recovered;
  for (let attempts = 0; attempts < 50 && performance.now() - faultStarted < 15000; attempts++) {
    const current = await status();
    if (current.app.pid === initial.app.pid && current.app.buildId === initial.app.buildId) {
      recovered = current;
      break;
    }
    await delay(150);
  }
  assert.ok(recovered, 'The supervisor must restore the original running generation within 15 seconds');
  report.rollbackMs = Math.round(performance.now() - faultStarted);
  assert.equal(recovered.app.rollback, null);
  phase = 'restored';
  log('Generation A was restored automatically. Continuing traffic and checking PostgreSQL.');
  await Promise.all(users.map((user, i) => verifyDashboard(user, users[1 - i], 'restored')));
  await delay(seconds * 1000);
  stopping = true;
  await Promise.all(load);
  await memory;
  assert.deepEqual(report.errors, []);
  for (const user of users) {
    assert.equal(user.claims, 1, 'Repeated writes must commit exactly once');
    assert.equal(user.ids.size, 1, 'Each retry must find the original result');
    const { rows } = await pool.query(
      'SELECT id,body FROM prnext_reference_notes WHERE user_id=$1 ORDER BY body', [user.id],
    );
    assert.deepEqual(rows.map(row => row.body), [
      'BROWSER_NOTE_A_' + user.email, 'BROWSER_NOTE_B_' + user.email,
      'BROWSER_NOTE_restored_' + user.email, user.body,
    ]);
    assert.equal(rows.at(-1).id, [...user.ids][0]);
  }
  for (const [stage, generation] of [['baseline', 'A'], ['replacement', 'B'], ['restored', 'A']]) {
    for (const method of ['GET', 'POST']) assert.ok(
      measurements.get(stage + '/' + method + '/' + generation)?.times.length >= 5,
      'Each generation must handle both methods under load in ' + stage,
    );
  }
  const verifiedMemory = report.memory.filter(sample => sample.state === 'verified' && Number.isFinite(sample.rssSumBytes));
  for (const stage of ['baseline', 'restored']) {
    assert.ok(verifiedMemory.some(sample => sample.stage === stage), 'Expected a verified memory sample in ' + stage);
  }
  report.peakObservedRssBytes = Math.max(...verifiedMemory.map(sample => sample.rssSumBytes));
  report.durationMs = Math.round(performance.now() - loadStarted);
  report.verifiedOwners = users.length;
  report.noteRows = users.length * 4;
  report.complete = true;
} finally {
  stopping = true;
  await Promise.allSettled([...load, memory]);
  report.phases = [...measurements.values()].map(({ stage, method, generation, times }) => {
    times.sort((a, b) => a - b);
    const quantile = p => Math.round(times[Math.ceil(times.length * p) - 1] * 100) / 100;
    return { stage, method, generation, requests: times.length, p95Ms: quantile(0.95), p99Ms: quantile(0.99) };
  });
  const cleanupErrors = [];
  for (const close of [
    () => browser?.close(), () => pool?.end(), () => launchAttempted && command('pdown'),
    () => fixture?.close(), () => cache?.close(), () => client?.isOpen && client.destroy(), () => redis?.close(),
  ]) {
    try { await close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) report.complete = false;
  await save();
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Could not clean up the isolated rollout.');
}
log(JSON.stringify({
  complete: report.complete, requests: report.phases.reduce((total, value) => total + value.requests, 0),
  rollbackMs: report.rollbackMs, verifiedOwners: report.verifiedOwners, noteRows: report.noteRows,
}));
