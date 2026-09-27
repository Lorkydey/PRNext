import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sha } from './dynamic-benchmark/harness.mjs';

const root = path.resolve(process.env.RESOURCE_BENCH_OUTPUT || 'reports/runtime-profiles');
const read = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const data = await read('final-results.json'), method = await read('method.json'), validation = await read('validation.json');
const names = data.variants.map(v => v.name);
assert.deepEqual(names, Object.keys(method.presets));
// Preserve historical labels while using the renamed policy in new campaigns.
const reference = names.includes('classic') ? 'classic' : 'standard';
assert.ok(names.includes(reference), 'Missing historical policy for profile comparisons');
const runCount = names.length * 12, parityCount = (names.length + 1) * 21;
const labels = { ssr: 'SSR dynamique sans cache', stream: 'Streaming / Suspense + API locale (40 ms)' };
const loadLabels = { 'fixed-250': '250 requêtes/s demandées', 'concurrency-128': '128 requêtes simultanées' };
const fields = ['requestsPerSecond', 'cpuMsPerResponse', 'cpuPercentOneCore', 'idleColdRssMiB', 'idleWarmRssMiB', 'loadMedianRssMiB', 'loadPeakRssMiB', 'p50Ms', 'p95Ms', 'p99Ms', 'ttfbP50Ms', 'ttfbP95Ms', 'ttfbP99Ms', 'meanBodyBytes', 'backendCallsPerSecond', 'clientCpuPercent'];
const metrics = [
  ['requestsPerSecond', 'Débit', 'req/s', 0], ['cpuMsPerResponse', 'CPU / réponse', 'ms', 3],
  ['cpuPercentOneCore', 'Charge CPU', '% cœur', 1], ['loadMedianRssMiB', 'RAM sous charge', 'Mio', 1],
  ['ttfbP95Ms', 'TTFB p95', 'ms', 2], ['p95Ms', 'Réponse complète p95', 'ms', 2],
];
const n = (value, digits = 1) => value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
assert.equal(data.valid, true); assert.equal(data.repetitions, 3); assert.equal(data.runs.length, runCount);
assert.deepEqual(data.variants.map(v => v.name), names);
for (const row of data.runs) {
  assert.equal(row.valid, true); assert.deepEqual(row.errors, {}); assert.equal(row.attempts, row.requests); assert.equal(row.reachedCap, false);
  assert.ok(row.requests > 0 && row.elapsedMs > 0);
  assert.equal(row.work.counts['render:' + row.scenario], row.requests);
  assert.equal(row.work.backendCalls, row.scenario === 'stream' ? row.requests : 0);
  if (row.scenario === 'stream') for (const event of ['async:stream', 'complete:stream']) assert.equal(row.work.counts[event], row.requests);
  if (row.profile === 'fixed-250') { assert.ok(Math.abs(row.requestsPerSecond / 250 - 1) < .05); assert.ok(row.scheduleLagP95Ms < 10); }
  assert.ok(row.ttfbP95Ms <= row.p95Ms && row.p50Ms <= row.p95Ms && row.p95Ms <= row.p99Ms);
  assert.ok(row.loadMedianRssMiB <= row.loadPeakRssMiB);
  assert.ok(Math.abs(row.cpuPercentOneCore - row.cpuMsPerResponse * row.requestsPerSecond / 10) < 1e-8);
  Object.assign(row, { idleColdRssMiB: row.idleCold.rssMiB, idleWarmRssMiB: row.idleWarm.rssMiB, backendCallsPerSecond: row.work.backendCalls * 1000 / row.elapsedMs });
  for (const field of fields) assert.ok(Number.isFinite(row[field]) && row[field] >= 0, field);
}
for (const name of [...names, 'next']) {
  const parity = await read('parity-' + name + '/results.json');
  assert.equal(parity.result.checks.length, 21); assert.ok(parity.result.checks.every(c => c.pass));
  if (name !== 'next') {
    assert.equal(parity.binarySha256, data.binarySha256);
    assert.equal(sha(JSON.stringify(parity)), data.parity[name].evidenceSha256);
  }
  const proof = (await readFile(path.join(root, 'parity-' + name, (name === 'next' ? 'next' : 'rustyx') + '-ssr-10000.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(proof.length, 10000); assert.ok(proof.every(e => e.kind === 'render:ssr' && e.input.token === 'constant'));
}
const groups = [];
for (const scenario of Object.keys(labels)) for (const load of Object.keys(loadLabels)) {
  const group = { scenario, load, variants: {} };
  for (const name of names) {
    const rows = data.runs.filter(r => r.variant === name && r.scenario === scenario && r.profile === load); assert.equal(rows.length, 3);
    group.variants[name] = Object.fromEntries(fields.map(field => [field, { median: median(rows.map(r => r[field])), min: Math.min(...rows.map(r => r[field])), max: Math.max(...rows.map(r => r[field])) }]));
  }
  groups.push(group);
}
const responses = data.runs.reduce((total, row) => total + row.requests, 0);
const summary = { finishedAt: data.finishedAt, responses, runs: runCount, parityChecks: parityCount, errors: 0, machine: method.machine, presets: method.presets, validation, groups };
const value = (group, name, field) => group.variants[name][field].median;
const gains = (group, name) => ['requestsPerSecond', 'cpuMsPerResponse', 'loadMedianRssMiB'].map(field => n(100 * (value(group, name, field) / value(group, reference, field) - 1)) + ' %').join(' / ');
const notes = [
  'Même application, même build et même binaire Rustyx. Deux workloads : SSR recalculé à chaque requête et streaming Suspense avec un appel backend déterministe retardé de 40 ms. Le serveur et le générateur de charge utilisent la même machine.',
  'Trois répétitions par cellule, ordre des profils inversé une répétition sur deux, serveur neuf entre les mesures, 64 requêtes de chauffe. Charge fixe : 6 s à 250 req/s avec au plus 32 requêtes simultanées. Forte concurrence : 4 s avec 128 clients. Médianes, minima et maxima disponibles ; ce sont des mesures locales courtes, pas un test d’endurance ni une garantie pour tout site.',
  `${parityCount} contrôles de parité : les profils mesurés et Next.js. Chaque configuration effectue réellement 10 000 rendus SSR pour 10 000 requêtes identiques. Les compteurs vérifient aussi chaque réponse chronométrée et les appels backend. Le coût de cette instrumentation est inclus dans les mesures.`,
  'Le chronométrage compare uniquement les profils Rustyx. Next.js sert ici de référence fonctionnelle. Flight et Server Actions restent des adaptations du protocole Rustyx, sans affirmation de compatibilité binaire Next.js ; ces parcours sont validés fonctionnellement mais ne sont pas chronométrés ici.',
  'La RSS inclut le serveur Rust, les processus Node et leurs threads RSC. Elle exclut l’API locale, le générateur de charge et les serveurs de développement inactifs préexistants. Aucune compilation ni suite de tests n’est lancée pendant les mesures.',
  'CPU / réponse = temps CPU cumulé de l’arbre serveur divisé par les réponses réussies. 100 % de charge CPU représente un cœur. Une configuration qui sert davantage de requêtes peut utiliser davantage de CPU par seconde tout en réduisant le coût CPU par réponse.',
  'Compression gzip et validation complète du contenu pour les deux workloads. La taille de corps est celle transférée après compression. Un appel backend par réponse streaming, aucun pour le SSR simple. Aucun cache de réponse. Les buffers et files restent bornés dans tous les modes.',
  'Les priorités ne garantissent pas que chaque profil gagne sur sa métrique dans tous les cas. En particulier, un gros espace V8 peut réserver davantage de mémoire sans réduire le CPU sur une petite charge. Le mode balanced est un compromis fixe, sans auto-tuning ni minimum global garanti.',
  'Le premier pilote, conservé séparément, utilisait un balanced sans optimize-for-size et avec un semi-space de 4 Mio. Son économie de RAM était insuffisante ; le réglage final passe à optimize-for-size et 8 Mio. Ce pilote n’entre pas dans les résultats finaux.',
];
let md = `# Rustyx : profils de production\n\n${n(responses, 0)} réponses contrôlées, ${runCount} mesures, zéro erreur. ${parityCount} contrôles de parité.\n\n`;
md += `Machine : ${method.machine.cpu}, ${method.machine.cores} cœurs, ${method.machine.ramGiB} Gio, ${method.machine.os}/${method.machine.arch}, Node ${method.machine.node}.\n\n`;
for (const group of groups) {
  md += `## ${labels[group.scenario]} — ${loadLabels[group.load]}\n\n| Profil | ${metrics.map(m => m[1]).join(' | ')} |\n|---|${metrics.map(() => '---:|').join('')}\n`;
  for (const name of names) md += `| ${name} | ${metrics.map(([field, , unit, digits]) => n(value(group, name, field), digits) + ' ' + unit).join(' | ')} |\n`;
  md += '\nÉcarts au ' + reference + ' (débit / CPU par réponse / RAM) :\n\n' + names.filter(name => name !== reference).map(name => '- `' + name + '` : ' + gains(group, name)).join('\n') + '\n\n';
}
md += '## Méthode et limites\n\n' + notes.map(note => '- ' + note).join('\n') + '\n\n## Utilisation\n\n```sh\ncorepack yarn prn build\ncorepack yarn prn start --profile balanced\n```\n\nChoisir `--profile balanced`, `--profile speed` ou `--profile memory`. Le profil `cpu` est retiré ; les anciennes mesures le concernant sont historiques. `balanced` est désormais le défaut. `--profile classic` reprend les réglages de `standard`, qui reste un alias. `compact` reste disponible. [Profils disponibles](../../README.md#choose-your-runtime-profile) · [Reproduire](../../scripts/runtime-profiles.md).\n';
await writeFile(path.join(root, 'README.md'), md);
await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(root, 'metrics.csv'), '\ufeff' + ['scenario;charge;mode;repetition;requests;' + fields.join(';'), ...data.runs.map(row => [row.scenario, row.profile, row.variant, row.repetition, row.requests, ...fields.map(field => row[field])].join(';'))].join('\n') + '\n');
const table = group => `<div class="scroll"><table><thead><tr><th>Profil</th>${metrics.map(m => '<th>' + m[1] + '</th>').join('')}</tr></thead><tbody>${names.map(name => '<tr><th>' + name + '</th>' + metrics.map(([field, , unit, digits]) => '<td>' + n(value(group, name, field), digits) + ' ' + unit + '</td>').join('') + '</tr>').join('')}</tbody></table></div>`;
const stream = groups.find(g => g.scenario === 'stream' && g.load === 'concurrency-128');
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rustyx — Choisir son profil</title><style>
*{box-sizing:border-box}body{margin:0;background:#0c1423;color:#e8edf6;font:16px/1.65 system-ui}main{max-width:1200px;padding:48px 24px;margin:auto}h1{font-size:clamp(36px,5vw,64px);line-height:1.08;max-width:850px}h2{margin-top:38px}.muted{color:#aebed4}.eyebrow{color:#82e4c4;font-size:12px;letter-spacing:.12em;font-weight:800}.cards,.charts{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:24px 0}.card,.chart,details{padding:22px;background:#152239;border:1px solid #30425c;border-radius:14px}.card strong{display:block;font-size:22px;color:#82e4c4}.card p{margin:8px 0}.notice{border-left:3px solid #ffc87a;background:#242431;padding:14px 18px}.scroll{overflow:auto;border:1px solid #30425c;border-radius:12px}table{width:100%;white-space:nowrap;border-collapse:collapse;font-size:14px}th,td{padding:12px;text-align:right;border-bottom:1px solid #30425c}th:first-child{text-align:left}thead{background:#192b46}select{background:#192b46;color:inherit;border:1px solid #536d92;border-radius:8px;padding:12px;max-width:100%;margin-right:12px}label{display:inline-block;margin-bottom:12px}label span{display:block;color:#aebed4;font-size:13px}.bar{margin:12px 0}.bar>div:first-child{display:flex;justify-content:space-between;font-size:13px}.track{height:10px;background:#2a3c56;border-radius:10px;margin-top:4px}.fill{height:100%;border-radius:10px}a{color:#9bbdff}pre{padding:18px;background:#192b46;overflow:auto;border-radius:10px}details{margin:24px 0}li{margin:10px 0}footer{margin-top:30px}@media(max-width:700px){.cards,.charts{grid-template-columns:1fr}main{padding:28px 16px}}
</style><main><div class="eyebrow">RUSTYX · PROFILS DE PRODUCTION · ${data.finishedAt.slice(0, 10)}</div><h1>Choisir ce qui compte<br>pour votre serveur.</h1><p class="muted">Trois profils : rapidité, compromis et économie de mémoire. Les anciens profils présents dans les mesures sont conservés à titre historique. ${n(responses, 0)} réponses vérifiées · ${runCount} mesures · zéro erreur.</p><div class="cards"><div class="card"><strong>speed · Rapidité</strong><p>Jusqu’à 128 flux vivants par worker ; davantage de RAM pour absorber la concurrence.</p><code>prn start --profile speed</code></div><div class="card"><strong>memory · Mémoire</strong><p>Petite génération jeune, 16 flux vivants ; accepte plus d’attente et de GC.</p><code>prn start --profile memory</code></div><div class="card"><strong>balanced · Compromis</strong><p>Optimisation mémoire avec une génération jeune intermédiaire et 32 flux vivants.</p><code>prn start --profile balanced</code></div></div><p class="notice">Aucun mode ne gagne partout. Les tableaux affichent les coûts autant que les gains. Le mode <code>balanced</code> est désormais le défaut ; <code>classic</code> reprend les réglages de l’ancien <code>standard</code>. Les anciennes étiquettes restent celles des mesures.</p><h2>Streaming à forte concurrence</h2>${table(stream)}<h2>Explorer les compromis</h2><label><span>Scénario</span><select id="scenario">${Object.entries(labels).map(([id, label]) => '<option value="' + id + '">' + label + '</option>').join('')}</select></label><label><span>Charge</span><select id="load">${Object.entries(loadLabels).map(([id, label]) => '<option value="' + id + '">' + label + '</option>').join('')}</select></label><div class="charts" id="charts"></div><h2>Toutes les mesures</h2>${groups.map(group => '<h3>' + labels[group.scenario] + ' — ' + loadLabels[group.load] + '</h3>' + table(group)).join('')}<details><summary>Méthode et limites</summary><ul>${notes.map(note => '<li>' + note + '</li>').join('')}</ul><p>${method.machine.cpu} · ${method.machine.cores} cœurs · ${method.machine.ramGiB} Gio · ${method.machine.os}/${method.machine.arch} · Node ${method.machine.node}</p></details><h2>Activer un profil</h2><pre><code>corepack yarn prn build
corepack yarn prn start --profile balanced</code></pre><p class="muted">Un redémarrage suffit pour changer de profil sur le même build. <a href="../../README.md#choose-your-runtime-profile">Profils disponibles</a>.</p><footer><a href="README.md">Rapport Markdown</a> · <a href="metrics.csv">CSV des mesures</a> · <a href="final-results.json">Résultats bruts</a> · <a href="summary.json">Médianes et variations</a> · <a href="verification.json">Contrôles</a></footer></main><script>const groups=${JSON.stringify(groups)},names=${JSON.stringify(names)},metrics=${JSON.stringify(metrics.filter(([field]) => ['requestsPerSecond', 'cpuMsPerResponse', 'loadMedianRssMiB', 'ttfbP95Ms'].includes(field)))},colors=['#a7b6cc','#bd9ae8','#7de1bf','#87b9ff','#ffd187','#eea5bf'];function draw(){const g=groups.find(g=>g.scenario===document.querySelector('#scenario').value&&g.load===document.querySelector('#load').value);document.querySelector('#charts').innerHTML=metrics.map(([field,title,unit,digits])=>{const max=Math.max(...names.map(name=>g.variants[name][field].max));const fmt=v=>v.toLocaleString('fr-FR',{minimumFractionDigits:digits,maximumFractionDigits:digits});return '<div class="chart"><strong>'+title+'</strong><div class="muted">'+(field==='requestsPerSecond'?'Plus haut = plus de débit':'Plus bas = moins de coût ou d’attente')+'</div>'+names.map((name,i)=>{const m=g.variants[name][field];return '<div class="bar"><div><span>'+name+'</span><span>'+fmt(m.median)+' '+unit+'</span></div><div class="track" title="Min–max : '+fmt(m.min)+' – '+fmt(m.max)+'"><div class="fill" style="width:'+100*m.median/max+'%;background:'+colors[i]+'"></div></div></div>'}).join('')+'</div>'}).join('')}document.querySelectorAll('select').forEach(s=>s.addEventListener('change',draw));draw();</script></html>`;
await writeFile(path.join(root, 'index.html'), html);
await writeFile(path.join(root, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), responses, runs: runCount, errors: 0, parityChecks: parityCount, ssrExecutionsPerConfiguration: 10000, binarySha256: data.binarySha256, applicationArtifactSha256: data.candidateSha256, clientLimitedRuns: data.runs.filter(r => r.clientLimited).map(r => [r.variant, r.scenario, r.profile, r.repetition]), sources: method.sources }, null, 2) + '\n');
console.log('Verified profiles report:', responses, `responses; ${runCount} runs; ${parityCount} parity checks.`);
