// Compare current resource profiles, optionally including unmodified Next.js.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { sha } from './dynamic-benchmark/harness.mjs';
import presets from '../packages/prnext/runtime/profiles.json' with { type: 'json' };

const output = path.resolve(process.env.RESOURCE_BENCH_OUTPUT || 'reports/profile-comparison-current');
const mode = process.argv[2] || 'run';
// Historical reports can still be regenerated after a profile is retired.
const recordedVariants = mode === 'report'
  ? JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8')).variants
  : null;
const names = mode === 'report'
  ? recordedVariants.map(v => v.name)
  : (process.env.PROFILE_COMPARE_ENGINES || 'speed,memory,balanced').split(',');
assert.ok(names.length >= 2 && new Set(names).size === names.length);
if (mode !== 'report') for (const name of names) assert.ok(name === 'next' || Object.hasOwn(presets, name), 'Unsupported comparison profile: ' + name);
const variants = recordedVariants ?? names.map(name => name === 'next' ? { name, engine: 'next' } : { name, engine: 'candidate', env: { PRNEXT_PROFILE: name } });
const parityNames = [...new Set(['next', ...names])];
const runCount = names.length * 2 * 2 * 3;
const parityCount = parityNames.length * 21;
const loads = [
  { id: 'fixed-250', ratePerSecond: 250, concurrency: 32, durationMs: 6000 },
  { id: 'concurrency-128', concurrency: 128, durationMs: 6000 },
];
async function execute(script, args = [], environment = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: { ...process.env, RESOURCE_BENCH_OUTPUT: output, ...environment } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, script + ' failed');
}
if (mode === 'prepare') {
  // Rebuild both engines from the current common fixture. Archived builds can
  // use an older runtime or artifact layout and must not seed a new campaign.
  const fixtureOutput = path.join(output, 'fixture-build');
  await execute('scripts/dynamic-benchmark/runner.mjs', ['--prepare-only'], { DYNAMIC_BENCH_OUTPUT: fixtureOutput });
  await execute('scripts/bench-runtime-resources.mjs', ['snapshot'], { RESOURCE_BENCH_SOURCE: path.join(fixtureOutput, 'projects') });
  await execute('scripts/bench-runtime-resources.mjs', ['build']);
  for (const name of parityNames) await execute('scripts/validate-runtime-resources.mjs', [name]);
} else if (mode === 'run') {
  const sources = ['scripts/compare-profile-modes.mjs', 'scripts/bench-runtime-resources.mjs', 'scripts/validate-runtime-resources.mjs', 'scripts/bench-next-comparison.mjs', ...['fixture', 'protocol', 'load', 'backend', 'harness', 'parity', 'runner'].map(s => 'scripts/dynamic-benchmark/' + s + '.mjs')];
  const require = createRequire(path.join(output, 'projects/next/package.json'));
  const versions = { next: require('next/package.json').version, react: require('react/package.json').version, nextBundledReact: require('next/dist/compiled/react').version };
  await writeFile(path.join(output, 'method.json'), JSON.stringify({ createdAt: new Date().toISOString(), versions, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGiB: os.totalmem() / 1024 ** 3, os: os.platform(), arch: os.arch(), node: process.version }, presets: Object.fromEntries(names.filter(name => name !== 'next').map(name => [name, presets[name]])), sources: Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(file))]))) }, null, 2) + '\n');
  await execute('scripts/bench-runtime-resources.mjs', [], {
    RESOURCE_VARIANTS: JSON.stringify(variants), RESOURCE_SCENARIOS: 'ssr,stream', RESOURCE_REPETITIONS: '3',
    RESOURCE_REQUIRE_PARITY: '1', RESOURCE_STRICT_PARITY: '1', RESOURCE_RESULT: 'results.json',
    RESOURCE_LOAD_PROFILES: JSON.stringify(loads), RESOURCE_PROFILE: '',
  });
} else if (mode === 'report') {
  const read = async name => JSON.parse(await readFile(path.join(output, name), 'utf8'));
  const data = await read('results.json'), method = await read('method.json');
  assert.equal(data.valid, true); assert.equal(data.runs.length, runCount); assert.equal(data.repetitions, 3);
  assert.deepEqual(data.variants, variants); assert.deepEqual(data.profiles, loads);
  for (const name of parityNames) {
    const parity = await read(`parity-${name}/results.json`);
    assert.equal(parity.result.checks.length, 21); assert.ok(parity.result.checks.every(check => check.pass));
    if (name !== 'next') {
      assert.equal(parity.binarySha256, data.binarySha256);
      assert.equal(sha(JSON.stringify(parity)), data.parity[name].evidenceSha256);
    }
    const events = (await readFile(path.join(output, `parity-${name}/${name === 'next' ? 'next' : 'rustyx'}-ssr-10000.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 10000); assert.ok(events.every(e => e.kind === 'render:ssr' && e.input.token === 'constant'));
  }
  const fields = ['requestsPerSecond', 'cpuPercentOneCore', 'cpuMsPerResponse', 'idleColdRssMiB', 'idleWarmRssMiB', 'loadMedianRssMiB', 'loadPeakRssMiB', 'p50Ms', 'p95Ms', 'p99Ms', 'ttfbP50Ms', 'ttfbP95Ms', 'ttfbP99Ms', 'meanBodyBytes', 'backendCallsPerSecond', 'clientCpuPercent'];
  for (const row of data.runs) {
    assert.equal(row.valid, true); assert.deepEqual(row.errors, {}); assert.equal(row.attempts, row.requests); assert.equal(row.reachedCap, false);
    assert.equal(row.work.counts['render:' + row.scenario], row.requests);
    assert.equal(row.work.backendCalls, row.scenario === 'stream' ? row.requests : 0);
    if (row.scenario === 'stream') for (const event of ['async:stream', 'complete:stream']) assert.equal(row.work.counts[event], row.requests);
    if (row.profile === 'fixed-250') { assert.ok(Math.abs(row.requestsPerSecond / 250 - 1) < .05); assert.ok(row.scheduleLagP95Ms < 10); }
    assert.ok(row.p50Ms <= row.p95Ms && row.p95Ms <= row.p99Ms && row.ttfbP95Ms <= row.p95Ms);
    assert.ok(Math.abs(row.cpuPercentOneCore - row.cpuMsPerResponse * row.requestsPerSecond / 10) < 1e-8);
    Object.assign(row, { idleColdRssMiB: row.idleCold.rssMiB, idleWarmRssMiB: row.idleWarm.rssMiB, backendCallsPerSecond: row.work.backendCalls * 1000 / row.elapsedMs });
    for (const field of fields) assert.ok(Number.isFinite(row[field]) && row[field] >= 0, field);
  }
  const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
  const groups = [];
  for (const scenario of ['ssr', 'stream']) for (const load of loads) {
    const group = { scenario, load: load.id, variants: {} };
    for (const name of names) {
      const rows = data.runs.filter(r => r.variant === name && r.scenario === scenario && r.profile === load.id); assert.equal(rows.length, 3);
      group.variants[name] = Object.fromEntries(fields.map(field => [field, { median: median(rows.map(r => r[field])), min: Math.min(...rows.map(r => r[field])), max: Math.max(...rows.map(r => r[field])) }]));
    }
    groups.push(group);
  }
  const summary = { finishedAt: data.finishedAt, machine: method.machine, versions: method.versions, runs: runCount, responses: data.runs.reduce((sum, r) => sum + r.requests, 0), parityChecks: parityCount, errors: 0, clientLimitedRuns: data.runs.filter(r => r.clientLimited).length, groups };
  const n = (value, digits = 1) => value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const columns = [['requestsPerSecond', 'Débit (req/s)', 0], ['cpuPercentOneCore', 'Charge CPU (% cœur)', 1], ['cpuMsPerResponse', 'CPU / réponse (ms)', 3], ['loadMedianRssMiB', 'RAM sous charge (Mio)', 1], ['p95Ms', 'Latence p95 (ms)', 2], ['ttfbP95Ms', 'TTFB p95 (ms)', 2]];
  let markdown = `# ${names.join(' / ')} : comparaison\n\n${n(summary.responses, 0)} réponses contrôlées, ${runCount} mesures, zéro erreur. ${parityCount} contrôles de parité réussis.\n\nMachine : ${method.machine.cpu}, ${method.machine.cores} cœurs, ${method.machine.ramGiB} Gio, ${method.machine.os}/${method.machine.arch}, Node ${method.machine.node}.\n\n`;
  for (const group of groups) {
    markdown += `## ${group.scenario === 'ssr' ? 'SSR sans cache' : 'Streaming avec backend retardé de 40 ms'} — ${group.load === 'fixed-250' ? '250 requêtes/s demandées' : '128 requêtes simultanées'}\n\n| Profil | ${columns.map(c => c[1]).join(' | ')} |\n|---|${columns.map(() => '---:|').join('')}\n`;
    for (const name of names) markdown += `| ${name} | ${columns.map(([field, , digits]) => n(group.variants[name][field].median, digits)).join(' | ')} |\n`;
    markdown += '\n';
  }
  markdown += `## Méthode et limites\n\n- Versions : ${method.versions ? JSON.stringify(method.versions) : 'voir la campagne originale'}.\n- Médianes de trois passages de 6 secondes ; minima et maxima dans summary.json. Serveur neuf, 64 requêtes de chauffe puis remise à zéro des compteurs avant chaque mesure. Ordre des profils inversé une répétition sur deux.\n- Même application source. Même build et même binaire pour les profils PRNext ; build Next.js de production pour Next.js. Gzip et contenu contrôlés ; un rendu serveur par réponse, un appel backend par réponse streaming, aucun pour le SSR simple.\n- À charge fixe, jusqu’à 32 requêtes simultanées. La forte concurrence utilise 128 clients ; les plafonds propres à chaque mode restent actifs.\n- RSS de tout l’arbre serveur Rust + Node, threads RSC compris. L’API locale et le générateur de charge sont exclus. CPU 100 % = un cœur, 200 % = deux cœurs. CPU par réponse et charge CPU globale sont distincts.\n- Next.js ${names.includes('next') ? 'est mesuré en production, sans réglage spécial de heap ou de concurrence' : 'sert de référence de parité uniquement'} : 21 contrôles par moteur/profil, dont 10 000 rendus pour 10 000 requêtes SSR identiques. Flight et Actions restent des adaptations PRNext, vérifiées fonctionnellement mais pas chronométrées ici.\n- Aucun build ou test parallèle pendant les mesures. Les serveurs de développement préexistants sont restés inactifs. Mesures locales courtes, sans garantie de classement pour toute application ni test d’endurance.\n- ${summary.clientLimitedRuns} mesure(s) avec un générateur de charge atteignant le seuil CPU de 85 %.\n\n## Reproduction\n\nDepuis la racine du dépôt, avec les fixtures de parité dynamique disponibles :\n\n\`\`\`sh\nnpm run build:native\nexport RESOURCE_BENCH_OUTPUT=reports/profile-comparison-new\nexport PROFILE_COMPARE_ENGINES=${names.join(',')}\nnode scripts/compare-profile-modes.mjs prepare\nnode scripts/compare-profile-modes.mjs run\nnode scripts/compare-profile-modes.mjs report\n\`\`\`\n\n[Profils disponibles](../../README.md#choose-your-runtime-profile) · [CSV](metrics.csv) · [Mesures brutes](results.json) · [Médianes et variations](summary.json).\n`;
  await writeFile(path.join(output, 'README.md'), markdown);
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(path.join(output, 'metrics.csv'), '\ufeff' + ['scenario;charge;mode;repetition;requests;' + fields.join(';'), ...data.runs.map(row => [row.scenario, row.profile, row.variant, row.repetition, row.requests, ...fields.map(field => row[field])].join(';'))].join('\n') + '\n');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), runs: summary.runs, responses: summary.responses, errors: 0, parityChecks: parityCount, ssrProofPerConfiguration: 10000, binarySha256: data.binarySha256, applicationArtifactSha256: data.candidateSha256, sourceHashes: method.sources }, null, 2) + '\n');
  console.log('Verified:', summary.responses, `responses; ${runCount} runs; ${parityCount} parity checks.`);
} else throw new Error('Use prepare, run or report');
