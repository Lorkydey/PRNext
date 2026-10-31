import { execFile, fork } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const runner = fileURLToPath(new URL('./migration-scenarios-runner.mjs', import.meta.url));
const scope = 'Application-provided browser scenarios run independently against each server in isolated contexts. Passing both servers does not establish full application equivalence. Application code is explicitly executed and may submit forms or change test data. Browser messages, request data and raw errors are excluded from this report.';
function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Scenario servers must be HTTP(S) origins without credentials, paths, or queries.');
  return url.origin;
}

/** The explicit scenario option is the only path that loads application test code. */
export async function runMigrationScenarios({ directory, against, candidate, scenarios, timeout = 10000 }) {
  const root = await realpath(path.resolve(directory));
  const reference = origin(against), current = origin(candidate);
  if (typeof scenarios !== 'string' || !scenarios || !/\.[cm]?js$/.test(scenarios)) throw new Error('Provide an application browser scenario module ending in .mjs, .cjs or .js.');
  const filename = await realpath(path.resolve(root, scenarios));
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('The browser scenario module must be inside the application directory.');
  if (!(await stat(filename)).isFile()) throw new Error('The browser scenario module must be a regular file.');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('Scenario timeout must be 100–60000 milliseconds.');
  // Require an application manifest, without loading it as executable code.
  JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return new Promise(resolve => {
    const child = fork(runner, [], { cwd: root, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let settled = false, report, timer, killTimer, browserPid, termination = Promise.resolve();
    const incomplete = reason => ({ ok: false, state: 'unknown', reason, results: [], scope });
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      child.removeAllListeners('message');
      resolve({ ...value, scope });
    };
    // The worker has 20 scenarios maximum, two targets each, plus a bounded
    // startup/teardown budget. A hung module import cannot hold the CLI open.
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      // Kill only this worker's descendants on Windows. A synchronous user test
      // cannot process SIGTERM or close its browser itself.
      if (process.platform === 'win32') termination = new Promise(done => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (child.exitCode === null) child.kill(); done(); }));
      else {
        // BrowserServer owns this process, and Chromium closes its subprocesses
        // when that browser process exits. No shared browser is ever connected.
        if (browserPid) { try { process.kill(browserPid, 'SIGKILL'); } catch {} }
        child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      }
    };
    const budget = Math.min(300000, 20000 + timeout * 40);
    timer = setTimeout(() => { report = incomplete('worker-timeout'); terminate(); }, budget);
    child.on('message', message => {
      if (message?.type === 'browser-started' && Number.isInteger(message.pid) && message.pid > 0 && message.pid !== process.pid && message.pid !== child.pid) { browserPid = message.pid; return; }
      if (message?.type === 'browser-closed') { browserPid = undefined; return; }
      if (message?.type !== 'result' || !message.report || report) return;
      // Never forward arbitrary fields from application code or a compromised
      // IPC message: the public report has a fixed, deliberately small schema.
      const input = message.report;
      if (!Array.isArray(input.results) || input.results.length > 40 || input.results.some(item => !item || !Number.isInteger(item.scenario) || item.scenario < 1 || item.scenario > 20 || !['reference', 'candidate'].includes(item.target) || !['passed', 'failed'].includes(item.status))) { report = incomplete('invalid-result'); terminate(); return; }
      const results = input.results.map(item => ({ scenario: Number.isInteger(item.scenario) ? item.scenario : 0, target: item.target === 'reference' ? 'reference' : 'candidate', status: item.status === 'passed' ? 'passed' : 'failed', ...(item.reason === 'timeout' ? { reason: 'timeout' } : item.status !== 'passed' ? { reason: 'assertion-or-runtime-failure' } : {}) }));
      const allowed = new Set(['playwright-unavailable', 'invalid-scenarios', 'scenario-module-failed', 'scenario-module-timeout', 'browser-unavailable', 'worker-failed']);
      report = { ok: input.ok === true && results.length > 0 && results.every(item => item.status === 'passed'), state: input.state === 'checked' ? 'checked' : 'unknown', ...(allowed.has(input.reason) ? { reason: input.reason } : {}), results };
      child.send({ type: 'close' }, () => {});
      // A module can leave its own timers running. Once the owned browser has
      // closed, exit the worker rather than waiting for application handles.
      clearTimeout(timer); timer = setTimeout(terminate, 5000);
    });
    child.once('error', () => finish(incomplete('worker-failed')));
    child.once('close', () => { void termination.then(() => finish(report || incomplete('worker-failed'))); });
    child.send({ type: 'run', root, filename, reference, candidate: current, timeout }, error => { if (error) { report = incomplete('worker-failed'); terminate(); } });
  });
}
