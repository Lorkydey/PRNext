import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { callLocalDevTool } from './dev-tools-mcp.mjs';
import { replayId } from './dev-replay-model.mjs';

export const replayHelp = `Usage: prnext replay [directory] [--list] [--json]
       prnext replay [directory] --run <scenario-id> [--parameters fixtures.json] [--json]
       prnext replay [directory] --result <scenario-id> [--run-id <run-id>] [--json]
       prnext replay [directory] --export <scenario-id> [--json]

Start prnext dev first, then record and save a scenario in its Replay panel.
--run executes the recorded local application interactions and waits for the result.
--parameters reads explicit test values from a JSON object; these are not saved in the scenario.
--export prints a reviewable Playwright test to stdout without running or writing it.
Browser replay requires an optional project dependency:
  npm i -D @playwright/test
  npx playwright install chromium

Exit codes: 0 verified/read, 1 failed, 2 inconclusive or invalid input, 130 canceled.
`;

export function parseReplayArgs(args, cwd = process.cwd()) {
  let directory, action = 'list', id, runId, parameters, json = false, chosen = false, literal = false;
  const flags = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!literal && argument === '--') { literal = true; continue; }
    if (!literal && argument.startsWith('-')) {
      if (!['--list', '--run', '--result', '--export', '--run-id', '--parameters', '--json'].includes(argument)) throw Error('Unknown replay option: ' + argument);
      if (flags.has(argument)) throw Error('Duplicate replay option: ' + argument);
      flags.add(argument);
      if (argument === '--json') { json = true; continue; }
      if (argument === '--list') {
        if (chosen) throw Error('Choose one replay operation.');
        chosen = true; action = 'list'; continue;
      }
      const value = args[++index];
      if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) throw Error(argument + ' requires a value.');
      if (argument === '--parameters') { parameters = path.resolve(cwd, value); continue; }
      if (argument === '--run-id') { runId = replayId(value); continue; }
      if (chosen) throw Error('Choose one replay operation.');
      chosen = true; action = argument.slice(2); id = replayId(value);
    } else {
      if (directory !== undefined || !argument.trim() || /[\0\r\n]/.test(argument)) throw Error('Provide only one replay project directory.');
      directory = path.resolve(cwd, argument);
    }
  }
  if (parameters && action !== 'run') throw Error('--parameters requires --run.');
  if (runId && action !== 'result') throw Error('--run-id requires --result.');
  return { directory: directory || path.resolve(cwd), action, id, runId, parameters, json };
}

async function fixtureValues(filename) {
  if (!filename) return {};
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw Error('Replay parameters must be a regular JSON file no larger than 64 KiB.');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let values;
  try {
    const current = await file.stat();
    if (current.ino !== before.ino || current.dev !== before.dev || current.size > 65536) throw Error('Replay parameter file changed while reading.');
    const bytes = await file.readFile();
    if (bytes.length > 65536) throw Error('Replay parameter file is too large.');
    try { values = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw Error('Replay parameter file must contain valid JSON. Its contents were not displayed.'); }
  } finally { await file.close(); }
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 50 || Object.entries(values).some(([key,value]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 4096)) throw Error('Replay parameters must be an object of named test strings.');
  return values;
}

function exitFor(result) {
  const state = result.run?.state;
  return state === 'verified' && result.run.verified === true ? 0 : state === 'failed' ? 1 : state === 'cancelled' ? 130 : state === 'running' || !result.run ? 0 : 2;
}
function describe(result, action) {
  if (action === 'export') return result.code;
  if (action === 'list') return result.scenarios.length ? result.scenarios.map(item => `${item.id}  ${item.name}  [${item.latest?.state || 'not run'}]`).join('\n') + '\n' : 'No saved scenarios. Open Replay in the development tools to record one.\n';
  const run = result.run;
  if (!run) return 'This scenario has no recorded result.\n';
  const lines = [`Replay ${run.state}: ${result.scenario?.name || run.id}`, run.reason || ''];
  if (run.runId) lines.push('Run: ' + run.runId);
  if (run.after?.buildId) lines.push(`Build: ${run.after.buildId} · generation ${run.after.sequence}`);
  for (const step of run.steps || []) lines.push(`  ${step.index + 1}. ${step.type}: ${step.state}`);
  if (result.comparisonChanged || result.scenarioChanged) lines.push('The scenario changed; previous results refer to different expectations.');
  return lines.filter(Boolean).join('\n') + '\n';
}

export async function executeReplay(args, { cwd = process.cwd(), call = callLocalDevTool, now = Date.now, sleep = delay, waitMs = 45000 } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { output: replayHelp, exitCode: 0 };
  let options;
  try {
    options = parseReplayArgs(args, cwd);
    const invoke = (name, values = {}) => call(options.directory, name, values, { client: 'PRNext replay CLI' });
    let result;
    if (options.action === 'list') result = await invoke('dev_replay_list');
    else if (options.action === 'export') result = await invoke('dev_replay_export', { id: options.id });
    else if (options.action === 'result') result = await invoke('dev_replay_result', { id: options.id, ...(options.runId ? { runId: options.runId } : {}) });
    else {
      const parameters = await fixtureValues(options.parameters);
      const started = await invoke('dev_replay_run', { id: options.id, parameters });
      const runId = replayId(started.runId), until = now() + waitMs;
      do {
        result = await invoke('dev_replay_result', { id: options.id, runId });
        if (result.run?.state !== 'running') break;
        if (now() >= until) {
          result = { ...result, run: { ...result.run, state: 'inconclusive', verified: false, reason: 'The CLI stopped waiting. Read this run again with --result and --run-id; no success was inferred.' } };
          break;
        }
        await sleep(250);
      } while (true);
      if (!result.run) throw Error('The replay started without a readable run result.');
    }
    return { output: options.json ? JSON.stringify(result, null, 2) + '\n' : describe(result, options.action), exitCode: options.action === 'run' || options.action === 'result' ? exitFor(result) : 0 };
  } catch (error) {
    return { output: args.includes('--json') ? JSON.stringify({ ok: false, error: error.message }, null, 2) + '\n' : 'PRNext replay: ' + error.message + '\n', exitCode: 2 };
  }
}
