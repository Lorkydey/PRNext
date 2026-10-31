import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHARD_COUNT = 2;
const suites = new Set(['integration', 'browser']);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Matches Playwright's default **/*.@(spec|test).?(c|m)[jt]s?(x).
const browserTest = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const integrationTest = /^tests\/[^/]+\.test\.mjs$/;
const isFileForSuite = (file, suite) => typeof file === 'string' &&
  !/[\\\0\r\n]/.test(file) && !file.split('/').some(part => part === '..' || part === '.' || !part) &&
  (suite === 'integration' ? integrationTest.test(file) : file.startsWith('tests/browser/') && browserTest.test(file));

export function parseArguments(argv) {
  const options = { list: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--suite', '--shard', '--list', '--plan-output'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--list') { options.list = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2).replace('-output', 'Output')] = value;
  }
  if (!suites.has(options.suite)) throw new Error('Expected --suite integration|browser');
  const shard = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.shard ?? '');
  if (!shard || Number(shard[2]) !== SHARD_COUNT || Number(shard[1]) > SHARD_COUNT) throw new Error('Expected --shard 1/2 or 2/2');
  options.shard = Number(shard[1]);
  return options;
}

export async function discoverTestFiles(root, suite) {
  if (!suites.has(suite)) throw new Error('Unknown test suite');
  const base = suite === 'browser' ? 'tests/browser' : 'tests';
  const files = [];
  async function visit(directory) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (entry.name === 'node_modules') continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink() && (suite === 'browser' || isFileForSuite(relative, suite))) throw new Error(`Test discovery does not follow symbolic links: ${relative}`);
      if (entry.isDirectory() && suite === 'browser') await visit(relative);
      else if (entry.isFile() && isFileForSuite(relative, suite)) {
        // Git's Windows newline conversion must not change shard assignments.
        const source = await readFile(path.join(root, relative), 'utf8');
        files.push({ file: relative, sourceBytes: Math.max(1, Buffer.byteLength(source.replaceAll('\r\n', '\n'))) });
      }
    }
  }
  await visit(base);
  if (files.length < SHARD_COUNT) throw new Error(`Expected at least ${SHARD_COUNT} ${suite} test files; found ${files.length}`);
  return files.sort((a, b) => compare(a.file, b.file));
}

export async function readWeights(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'scripts/ci-shard-weights.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.suites || typeof manifest.suites !== 'object') throw new Error('Invalid shard weight manifest');
  for (const suite of suites) {
    const entry = manifest.suites[suite];
    if (!entry || !['reported-test-milliseconds', 'source-bytes'].includes(entry.unit) || !entry.weights || typeof entry.weights !== 'object' || Array.isArray(entry.weights)) throw new Error(`Invalid ${suite} shard weights`);
    for (const [file, weight] of Object.entries(entry.weights)) {
      if (!isFileForSuite(file, suite) || !Number.isSafeInteger(weight) || weight < 1) throw new Error(`Invalid shard weight: ${file}`);
    }
    if (entry.unit === 'source-bytes' && Object.keys(entry.weights).length) throw new Error('Source-byte weights must be discovered from current files');
  }
  return manifest;
}

export function validatePlan(plan, discoveredFiles) {
  if (!plan || !suites.has(plan.suite) || plan.shardCount !== SHARD_COUNT || !Number.isInteger(plan.shard) || plan.shard < 1 || plan.shard > SHARD_COUNT || !Array.isArray(plan.shards) || plan.shards.length !== SHARD_COUNT) throw new Error('Invalid shard plan');
  const expected = new Set(discoveredFiles);
  if (expected.size !== discoveredFiles.length || expected.size < SHARD_COUNT || [...expected].some(file => !isFileForSuite(file, plan.suite))) throw new Error('Invalid or empty discovered test set');
  const seen = new Set();
  for (let index = 0; index < SHARD_COUNT; index++) {
    const shard = plan.shards[index];
    if (shard.index !== index + 1 || !Array.isArray(shard.files) || !shard.files.length || !Number.isSafeInteger(shard.estimatedWeight) || shard.estimatedWeight < 1) throw new Error('Invalid or empty shard');
    for (const file of shard.files) {
      if (!expected.has(file)) throw new Error(`Shard contains an unknown test: ${file}`);
      if (seen.has(file)) throw new Error(`Duplicate test in shard plan: ${file}`);
      seen.add(file);
    }
  }
  for (const file of expected) if (!seen.has(file)) throw new Error(`Test missing from shard plan: ${file}`);
  const selected = plan.shards[plan.shard - 1].files;
  if (plan.totalFiles !== expected.size || !Array.isArray(plan.files) || plan.files.length !== selected.length || plan.files.some((file, index) => file !== selected[index])) throw new Error('Selected shard does not match the complete plan');
  return plan;
}

export function createPlan({ suite, shard, files, weights }) {
  if (!suites.has(suite) || !weights || !Array.isArray(files)) throw new Error('Invalid plan input');
  const measured = Object.values(weights.weights).sort((a, b) => a - b);
  // Files without a measured duration use the historical median, never zero.
  // A suite without duration history can instead use LF-normalized source bytes.
  const fallbackWeight = measured.length ? measured[Math.floor(measured.length / 2)] : 1;
  const entries = files.map(({ file, sourceBytes }) => ({
    file,
    weight: weights.unit === 'source-bytes' ? sourceBytes : Object.hasOwn(weights.weights, file) ? weights.weights[file] : fallbackWeight,
  }));
  if (entries.some(entry => !Number.isSafeInteger(entry.weight) || entry.weight < 1)) throw new Error('Invalid test weight');
  entries.sort((a, b) => b.weight - a.weight || compare(a.file, b.file));
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) => ({ index: index + 1, estimatedWeight: 0, files: [] }));
  for (const entry of entries) {
    const target = [...shards].sort((a, b) => a.estimatedWeight - b.estimatedWeight || a.files.length - b.files.length || a.index - b.index)[0];
    target.files.push(entry.file);
    target.estimatedWeight += entry.weight;
  }
  for (const entry of shards) entry.files.sort(compare);
  const plan = { schemaVersion: 1, suite, shard, shardCount: SHARD_COUNT, weightSource: weights.unit, fallbackWeight: weights.unit === 'source-bytes' ? 'current-source-bytes-minimum-1' : fallbackWeight, totalFiles: files.length, files: shards[shard - 1]?.files, shards };
  return validatePlan(plan, files.map(entry => entry.file));
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function browserFileFilter(root, file) {
  // Playwright treats positional file arguments as regexes of absolute paths.
  // Anchor and escape them so a selected foo.spec.mjs cannot also select fooXspec.
  return '^' + path.resolve(root, file).split(/[\\/]/).map(escapeRegex).join('[/\\\\]') + '$';
}

const within = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
export async function prepareOutputPath(root, output) {
  const target = path.resolve(root, output);
  const artifacts = path.resolve(root, 'artifacts');
  if (!within(artifacts, target) || path.extname(target) !== '.json') throw new Error('CI result paths must be .json files under artifacts/');
  await mkdir(artifacts, { recursive: true });
  const canonicalRoot = await realpath(root);
  const canonicalArtifacts = await realpath(artifacts);
  if (!within(canonicalRoot, canonicalArtifacts)) throw new Error('CI result paths must remain inside artifacts/ after resolving links');
  let directory = artifacts;
  for (const segment of path.relative(artifacts, path.dirname(target)).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, segment);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!within(canonicalArtifacts, await realpath(directory))) throw new Error('CI result paths must remain inside artifacts/ after resolving links');
  }
  try { await lstat(target); throw new Error('CI result path already exists; choose a fresh file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export function runnerArguments(plan, { root, playwrightCli, jsonReporter = false }) {
  if (plan.suite === 'integration') return ['--test', '--test-concurrency=1', ...plan.files];
  if (!playwrightCli) throw new Error('Local Playwright CLI is required');
  return [playwrightCli, 'test', '--config', path.join(root, 'playwright.config.mjs'), '--workers=1',
    ...(jsonReporter ? ['--reporter=line,json'] : []),
    // Playwright 1.63 reserves everything after a literal -- for user test args,
    // excluding them from testFilters. Our anchored regexes start with ^, not -.
    ...plan.files.map(file => browserFileFilter(root, file))];
}

export async function launchPlan(plan, { root = repositoryRoot, stdio = 'inherit', env = process.env } = {}) {
  validatePlan(plan, (await discoverTestFiles(root, plan.suite)).map(entry => entry.file));
  const childEnv = { ...env };
  // A runner launched by another node:test process must start its own runner,
  // rather than inherit Node's private child-test execution context.
  delete childEnv.NODE_TEST_CONTEXT;
  const playwrightCli = plan.suite === 'browser' ? createRequire(path.join(root, 'package.json')).resolve('@playwright/test/cli') : undefined;
  const jsonReporter = plan.suite === 'browser' && !!env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  if (jsonReporter) childEnv.PLAYWRIGHT_JSON_OUTPUT_FILE = await prepareOutputPath(root, env.PLAYWRIGHT_JSON_OUTPUT_FILE);
  const args = runnerArguments(plan, { root, playwrightCli, jsonReporter });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio, shell: false, windowsHide: true });
    const forward = signal => child.kill(signal);
    const interrupt = () => {
      // Windows console Ctrl+C is also delivered to the inherited child console.
      // child.kill('SIGINT') force-terminates it there, bypassing its own cleanup.
      // Leave that console delivery alone; this does not certify other Windows
      // cancellation modes or promise graceful shutdown of every descendant.
      if (process.platform !== 'win32') forward('SIGINT');
    };
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve(code ?? (128 + (constants.signals[signal] ?? 1))); });
  });
}

export async function main(argv, { root = repositoryRoot, stdout = text => console.log(text), env = process.env, stdio = 'inherit' } = {}) {
  const options = parseArguments(argv);
  const files = await discoverTestFiles(root, options.suite);
  const manifest = await readWeights(root);
  const plan = createPlan({ ...options, files, weights: manifest.suites[options.suite] });
  const json = JSON.stringify(plan, null, 2) + '\n';
  if (options.planOutput) await writeFile(await prepareOutputPath(root, options.planOutput), json, { flag: 'wx' });
  if (options.list) { stdout(json.trimEnd()); return 0; }
  stdout(`CI ${plan.suite} shard ${plan.shard}/${SHARD_COUNT}: ${plan.files.length}/${plan.totalFiles} files; weights=${plan.weightSource}`);
  return launchPlan(plan, { root, stdio, env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`CI sharding: ${error.message}`); process.exitCode = 1; }
}
