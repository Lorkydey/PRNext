import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { standaloneFixture, startServer, repositoryRoot, binary } from '../support.mjs';
import profiles from '../../packages/prnext/runtime/profiles.json' with { type: 'json' };

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const overrides = ['PRNEXT_WORKER_IDLE_SECONDS', 'PRNEXT_LANE_IDLE_SECONDS', 'PRNEXT_KEEP_WARM', 'PRNEXT_PROFILE', 'PRNEXT_MEMORY_PROFILE', 'PRNEXT_EFFECTIVE_PROFILE'];
const endpoint = `export default function(req,res){res.setHeader('Cache-Control','private, no-store');res.json({pid:process.pid,nonce:crypto.randomUUID(),user:req.cookies.user||'anonymous',at:Date.now(),uptime:process.uptime(),profile:process.env.PRNEXT_PROFILE,memory:process.memoryUsage()})}`;
const ssr = `export async function getServerSideProps({req}){return{props:{pid:process.pid,nonce:crypto.randomUUID(),user:req.cookies.user||'anonymous'}}}export default function Page(props){return <pre data-testid="endurance-ssr">{JSON.stringify(props)}</pre>}`;
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function observe(pids) {
  const owned = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && alive(pid));
  if (process.platform === 'win32') {
    try {
      const script = `$rows=@();foreach($processId in @(${owned.join(',')})){try{$p=[System.Diagnostics.Process]::GetProcessById($processId);$rows+=[pscustomobject]@{pid=$p.Id;rssBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;handleCount=$p.HandleCount}}catch{}};ConvertTo-Json -Compress -InputObject @($rows)`;
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      return { state: 'observed', method: 'Windows process counters; handles are not file descriptors', processes: JSON.parse(stdout) };
    } catch { return { state: 'unavailable', method: 'Windows process counters', processes: [] }; }
  }
  if (process.platform === 'linux') {
    const processes = [];
    for (const pid of owned) {
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        processes.push({ pid, rssBytes: rss ? Number(rss[1]) * 1024 : null, fileDescriptors: (await readdir(`/proc/${pid}/fd`)).length });
      } catch { /* A concurrently retired owned process can disappear. */ }
    }
    return { state: 'observed', method: 'Linux /proc status and per-process fd directory', processes };
  }
  return { state: 'unavailable', method: 'No reliable process/descriptor sampler on this platform', processes: [] };
}

async function probe(server, user) {
  const response = await fetch(`${server.url}/api/endurance`, { headers: { cookie: `user=${user}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
  const value = await response.json();
  assert.equal(value.user, user, 'request cookies must remain isolated');
  assert.ok(Number.isInteger(value.pid) && value.pid > 0);
  assert.match(value.nonce, /^[a-f0-9-]{36}$/);
  return value;
}

async function ssrProbe(server, user) {
  const response = await fetch(`${server.url}/endurance-ssr`, { headers: { cookie: `user=${user}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /<pre[^>]*data-testid="endurance-ssr"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(match, 'the dynamic SSR result must be present in the HTML');
  const value = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  assert.equal(value.user, user);
  return value;
}

/** Explicit manual qualification; ordinary unit/PR test discovery never runs it. */
export async function qualifyProductionRetirement({ output }) {
  assert.equal(profiles.memory.renderIdleSeconds, 30, 'this qualification exercises the actual 30-second memory default');
  assert.equal(profiles.balanced.renderIdleSeconds, 300, 'this qualification exercises the actual 300-second balanced default');
  await mkdir(output, { recursive: true });
  const started = performance.now();
  const receipt = { version: 1, complete: false, ok: false, startedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), release: release() }, artifacts: { nodeSha256: hash(await readFile(process.execPath)), binarySha256: hash(await readFile(binary)), fixtureSha256: hash(endpoint + '\0' + ssr) }, settings: { workers: 1, profiles: ['memory', 'balanced'], idleDefaultsSeconds: [30, 300], retirementOverrides: false, deadlineObservationToleranceMs: 1000, concurrentRequestsPerBurst: 32, network: 'owned loopback only', overrideKeysRemoved: overrides }, cases: [], limitations: ['This is an actual default-deadline retirement/recovery qualification, not an hours-long load soak or a throughput benchmark.', 'Process observations cover the owned native listener and the worker PID reported by this fixture. RSS/handles/FD values are observations, not a leak proof or a hard memory limit.', 'The client body-completion clock differs slightly from the native worker settlement clock. Exit observations allow 1 second for transport/sampling uncertainty; the no-HTTP idle wait itself is always at least the full 30 or 300 seconds.', 'No production idle deadline is shortened. No HTTP request is sent during an idle observation window. Other machine activity is uncontrolled.'] };
  const save = () => writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  let fixture, server;
  const workerPids = new Set();
  try {
    fixture = await standaloneFixture('prnext-production-endurance-');
    await mkdir(path.join(fixture.root, 'pages/api'), { recursive: true });
    await writeFile(path.join(fixture.root, 'pages/api/endurance.js'), endpoint);
    await writeFile(path.join(fixture.root, 'pages/endurance-ssr.jsx'), ssr);
    const build = await execute(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { timeout: 120000 });
    await writeFile(path.join(output, 'build.log'), build.stdout + build.stderr);
    receipt.artifacts.manifestSha256 = hash(await readFile(path.join(fixture.root, '.prnext/manifest.json')));
    const effectivePresets = JSON.parse(await readFile(path.join(fixture.root, '.prnext/runtime/profiles.json'), 'utf8'));
    assert.equal(effectivePresets.memory.renderIdleSeconds, 30);
    assert.equal(effectivePresets.balanced.renderIdleSeconds, 300);
    await save();
    for (const profile of ['memory', 'balanced']) {
      const idleSeconds = profiles[profile].renderIdleSeconds;
      const environment = Object.fromEntries(overrides.map(key => [key, undefined]));
      server = await startServer(fixture.root, ['--workers', '1', '--profile', profile], environment);
      const entry = { profile, idleSeconds, nativePid: server.child.pid, observations: [], startedAt: new Date().toISOString(), idleHttpRequests: 0 };
      receipt.cases.push(entry);
      const first = await probe(server, `${profile}-before`);
      workerPids.add(first.pid);
      assert.equal(first.profile, profile);
      const firstSsr = await ssrProbe(server, `${profile}-ssr-before`);
      assert.equal(firstSsr.pid, first.pid);
      const before = await Promise.all(Array.from({ length: 32 }, (_, index) => probe(server, `${profile}-before-${index}`)));
      // Observe the whole idle interval, including any slow OS sampler. Starting
      // this clock after PowerShell would make a genuine 30-second retirement
      // appear early by the sampler's own startup time.
      const idleStart = performance.now();
      entry.idleStartedAt = new Date().toISOString();
      assert.equal(new Set(before.map(value => value.pid)).size, 1);
      assert.equal(new Set(before.map(value => value.nonce)).size, 32);
      assert.ok(before.every(value => value.pid === first.pid));
      entry.before = { first, ssr: firstSsr, responses: before };
      entry.observations.push({ phase: 'before-idle', ...await observe([server.child.pid, first.pid]) });
      const deadline = idleStart + idleSeconds * 1000;
      let preDeadlineVerified = false, lastProgress = 0;
      process.stdout.write(`Waiting for the real ${profile} worker idle deadline: ${idleSeconds} seconds.\n`);
      for (;;) {
        assert.equal(server.child.exitCode, null, 'the native listener must stay running');
        const elapsedMs = performance.now() - idleStart;
        if (!preDeadlineVerified && elapsedMs >= Math.max(0, idleSeconds * 1000 - 2500)) {
          assert.ok(alive(first.pid), 'the worker must remain alive before its configured deadline');
          entry.preDeadlineAliveMs = Math.round(elapsedMs); preDeadlineVerified = true;
        }
        if (!alive(first.pid)) {
          assert.ok(preDeadlineVerified && elapsedMs >= idleSeconds * 1000 - 1000, 'retirement must follow the actual profile deadline within transport/sampling precision');
          entry.retiredAfterMs = Math.round(elapsedMs);
          if (performance.now() < deadline) await delay(deadline - performance.now());
          entry.idleWaitMs = Math.round(performance.now() - idleStart);
          assert.ok(entry.idleWaitMs >= idleSeconds * 1000, 'qualification must wait the full real profile deadline');
          break;
        }
        assert.ok(elapsedMs < (idleSeconds + 20) * 1000, 'the worker must retire shortly after its real idle deadline');
        if (elapsedMs - lastProgress >= 30000) {
          lastProgress = elapsedMs;
          process.stdout.write(`${profile}: ${Math.floor(elapsedMs / 1000)} seconds idle; worker still alive.\n`);
          await save();
        }
        await delay(250);
      }
      entry.observations.push({ phase: 'worker-retired', ...await observe([server.child.pid]) });
      const resumedAt = performance.now();
      const resumed = await probe(server, `${profile}-resumed`);
      workerPids.add(resumed.pid);
      entry.resumeResponseMs = Math.round((performance.now() - resumedAt) * 100) / 100;
      assert.notEqual(resumed.pid, first.pid, 'a new host must serve after retirement');
      assert.notEqual(resumed.nonce, first.nonce, 'the resumed response must be fresh');
      assert.equal(resumed.profile, profile);
      const after = await Promise.all(Array.from({ length: 32 }, (_, index) => probe(server, `${profile}-after-${index}`)));
      assert.equal(new Set(after.map(value => value.pid)).size, 1);
      assert.equal(new Set(after.map(value => value.nonce)).size, 32);
      assert.ok(after.every(value => value.pid === resumed.pid));
      const nonces = new Set([...before, ...after, first, resumed].map(value => value.nonce));
      assert.equal(nonces.size, 66);
      const secondSsr = await ssrProbe(server, `${profile}-ssr-after`);
      assert.equal(secondSsr.pid, resumed.pid);
      assert.notEqual(secondSsr.nonce, firstSsr.nonce);
      entry.after = { first: resumed, ssr: secondSsr, responses: after };
      entry.observations.push({ phase: 'after-resume', ...await observe([server.child.pid, resumed.pid]) });
      await writeFile(path.join(output, `${profile}-server.log`), server.output());
      const nativePid = server.child.pid;
      await server.close(); server = undefined;
      assert.equal(alive(nativePid), false, 'the owned native listener must exit during cleanup');
      assert.equal(alive(resumed.pid), false, 'the resumed worker must exit during cleanup');
      entry.cleanup = { nativeExited: true, workerExited: true };
      entry.ok = true;
      await save();
      process.stdout.write(`${profile}: retired after ${entry.retiredAfterMs} ms; one fresh isolated worker resumed.\n`);
    }
    receipt.ok = true;
  } catch (error) {
    receipt.error = { name: error.name, message: error.message };
    if (server) await writeFile(path.join(output, 'failure-server.log'), server.output());
    throw error;
  } finally {
    try { await server?.close(); }
    finally {
      receipt.ownedWorkersStillAlive = [...workerPids].filter(alive);
      if (fixture) {
        const relative = path.relative(tmpdir(), fixture.root);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(fixture.root).startsWith('prnext-production-endurance-'));
        await fixture.remove();
      }
      receipt.finishedAt = new Date().toISOString();
      receipt.elapsedSeconds = Math.round((performance.now() - started) / 10) / 100;
      receipt.complete = true;
      await save();
    }
  }
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) {
    process.stdout.write('Opt-in only: node tests/performance/production-endurance.mjs --run --output artifacts/production-endurance-YYYYMMDD\nActual waiting time is at least 330 seconds plus build and cleanup.\n');
  } else {
    const outputAt = args.indexOf('--output');
    if (args.some((arg, index) => arg !== '--run' && arg !== '--output' && index !== outputAt + 1) || outputAt < 0 || !args[outputAt + 1]) throw new Error('Use --run --output <dedicated-results-directory>.');
    const output = path.resolve(args[outputAt + 1]);
    qualifyProductionRetirement({ output }).then(receipt => {
      process.stdout.write(JSON.stringify({ ok: receipt.ok, elapsedSeconds: receipt.elapsedSeconds, receipt: path.join(output, 'receipt.json') }) + '\n');
    }, error => { console.error(error.message); process.exitCode = 1; });
  }
}
