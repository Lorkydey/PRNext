import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.env.AUDIT_REPORT_DIR || 'reports/current-comparison');
const data = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const distribution = values => {
  const numbers = values.filter(finite);
  if (!numbers.length) return {n: 0, median: null, min: null, max: null, mean: null, sampleStdDev: null, cvPercent: null};
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  const sampleStdDev = numbers.length > 1 ? Math.sqrt(numbers.reduce((n, x) => n + (x - mean) ** 2, 0) / (numbers.length - 1)) : null;
  return {n: numbers.length, median: median(numbers), min: Math.min(...numbers), max: Math.max(...numbers), mean, sampleStdDev, cvPercent: sampleStdDev === null || !mean ? null : 100 * sampleStdDev / mean};
};
const metrics = ['requestsPerSecond', 'cpuMsPerRequest', 'loadMedianRssMiB', 'sampledPeakRssMiB', 'p50Ms', 'p95Ms', 'p99Ms', 'ttfbP95Ms', 'cpuPercentOneCore', 'meanBodyBytes', 'meanDecodedBytes', 'startupMs'];
const valid = row => !row.error && row.errors === 0 && row.cpuValid === true && !row.reachedCap;
const names = {boutique: 'Boutique · Edge', 'boutique-node': 'Boutique · Node', journal: 'Journal · i18n / Pages', dashboard: 'Dashboard · PPR', portail: 'Portail · SSR / proxy', documentation: 'Documentation · 100 pages'};
const all = data.sites.flatMap(site => site.runs.map(run => ({...run, site: site.name})));
const stress = await readFile(path.join(directory, 'stress.json'), 'utf8').then(JSON.parse).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
const groups = data.sites.flatMap(site => [...new Set(site.runs.map(run => run.scenario))].map(scenario => {
  const rows = all.filter(run => run.site === site.name && run.scenario === scenario);
  const engines = Object.fromEntries(['next', 'rustyx'].map(engine => {
    const trials = rows.filter(run => run.engine === engine), accepted = trials.filter(valid);
    return [engine, {runs: trials.length, validRuns: accepted.length, attempts: sum(trials, 'attempts'), requests: sum(trials, 'requests'), errors: sum(trials, 'errors'), failedRuns: trials.filter(run => run.error).length,
      peakRssMiB: accepted.length ? Math.max(...accepted.map(run => run.sampledPeakRssMiB)) : null,
      encodings: trials.reduce((counts, run) => {for (const [name, count] of Object.entries(run.encodings || {})) counts[name] = (counts[name] || 0) + count; return counts;}, {}),
      clientCpuPercent: distribution(accepted.map(run => 100 * run.clientCpuMs / run.elapsedMs)),
      metrics: Object.fromEntries(metrics.map(key => [key, distribution(accepted.map(run => run[key]))]))}];
  }));
  const pairedChanges = Object.fromEntries(metrics.map(key => [key, distribution(rows.filter(run => run.engine === 'next' && valid(run)).flatMap(next => {
    const rust = rows.find(run => run.engine === 'rustyx' && run.repetition === next.repetition && valid(run));
    return rust && finite(next[key]) && next[key] !== 0 && finite(rust[key]) ? [100 * (rust[key] / next[key] - 1)] : [];
  }))]));
  const label = rows[0].label + (scenario.includes('gzip') ? ' (gzip accepté par le client)' : '');
  return {site: site.name, scenario, label, kind: rows[0].kind, concurrency: rows[0].concurrency, durationMs: rows[0].durationMs, engines, pairedChanges};
}));
const checks = data.sites.flatMap(site => site.comparisons || []);
const sustained = all.filter(run => run.kind === 'sustained');
const summary = {date: data.date, finishedAt: data.finishedAt, completed: data.completed, versions: data.versions, machine: data.machine, trials: all.length,
  validTrials: all.filter(valid).length, validResponses: sum(all, 'requests'), errors: sum(all, 'errors'), incompleteTrials: all.filter(run => run.error).length,
  functionalPassed: checks.filter(check => check.equal).length, functionalTotal: checks.length,
  recoveryResponses: sum(sustained.map(run => run.recovery || {}), 'requests'), recoveryErrors: sum(sustained.map(run => run.recovery || {}), 'errors'),
  overload: stress ? {trials: stress.runs.length, responses: sum(stress.runs, 'requests'), errors: sum(stress.runs, 'errors'), recoveryErrors: sum(stress.runs.map(run => run.recovery || {}), 'errors')} : null, groups};
const csv = (headers, rows) => '\uFEFF' + [headers, ...rows].map(row => row.map(value => '"' + String(finite(value) ? String(value).replace('.', ',') : value ?? '').replace(/"/g, '""') + '"').join(';')).join('\n') + '\n';
const rawKeys = ['site', 'engine', 'scenario', 'kind', 'repetition', 'concurrency', 'durationMs', 'requests', 'attempts', 'errors', ...metrics, 'encodings', 'clientCpuMs', 'elapsedMs', 'cpuValid', 'reachedCap', 'error'];
await writeFile(path.join(directory, 'measurements.csv'), csv(rawKeys, all.map(row => rawKeys.map(key => key === 'encodings' ? JSON.stringify(row[key]) : row[key]))));
await writeFile(path.join(directory, 'summary.csv'), csv(['site', 'scenario', 'engine', 'valid_runs', 'runs', 'errors', ...metrics.flatMap(key => [key + '_median', key + '_min', key + '_max', key + '_cv_percent'])], groups.flatMap(group => ['next', 'rustyx'].map(engine => {
  const value = group.engines[engine];
  return [group.site, group.scenario, engine, value.validRuns, value.runs, value.errors, ...metrics.flatMap(key => [value.metrics[key].median, value.metrics[key].min, value.metrics[key].max, value.metrics[key].cvPercent])];
}))));
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(directory, 'builds.csv'), csv(['site', 'engine', 'kind', 'ok', 'wall_ms', 'sampled_peak_rss_mib', 'samples', 'output_bytes'], data.sites.flatMap(site => ['next', 'rustyx'].flatMap(engine => {
  const record = site.engines[engine];
  return [...record.builds, ...(record.restoredBuild ? [record.restoredBuild] : [])].map(build => [site.name, engine, build.kind, build.ok, build.wallMs, build.sampledPeakRssMiB, build.samples, build.outputBytes]);
}))));
if (stress) await writeFile(path.join(directory, 'overload.csv'), csv(['engine', 'repetition', 'concurrency', 'requests', 'attempts', 'errors', 'requests_per_second', 'rss_mib', 'peak_rss_mib', 'p95_success_ms', 'recovery_errors', 'failures'], stress.runs.map(row => [row.engine, row.repetition, row.concurrency, row.requests, row.attempts, row.errors, row.requestsPerSecond, row.loadMedianRssMiB, row.sampledPeakRssMiB, row.p95Ms, row.recovery?.errors, JSON.stringify(row.failures)])));

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const fmt = (value, digits = 1) => finite(value) ? value.toLocaleString('fr-FR', {minimumFractionDigits: digits, maximumFractionDigits: digits}) : '—';
const med = (group, engine, key) => group?.engines[engine]?.metrics[key].median;
const delta = (group, key) => {const next = med(group, 'next', key), rust = med(group, 'rustyx', key); return finite(next) && next && finite(rust) ? 100 * (rust / next - 1) : null;};
const change = (group, key) => {
  const value = delta(group, key), good = key === 'requestsPerSecond' ? value > 0 : value < 0;
  return `<span class="${!finite(value) || Math.abs(value) < 5 ? 'muted' : good ? 'good' : 'bad'}">${finite(value) && value > 0 ? '+' : ''}${fmt(value)} %</span>`;
};
const pair = (group, key, digits = 1) => `${fmt(med(group, 'next', key), digits)} → <b>${fmt(med(group, 'rustyx', key), digits)}</b><br>${change(group, key)}`;
const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const mixed = groups.filter(group => group.scenario === 'mixed');
const mixedTable = table(['Projet · Next → Rustyx', 'req/s ↑', 'CPU ms/rép. ↓', 'RSS Mio ↓', 'P95 ms ↓'], mixed.map(group => `<tr data-site="${group.site}"><th>${names[group.site]}</th>${['requestsPerSecond', 'cpuMsPerRequest', 'loadMedianRssMiB', 'p95Ms'].map((key, i) => `<td>${pair(group, key, [0, 3, 1, 2][i])}</td>`).join('')}</tr>`));
const detailRows = groups.flatMap(group => ['next', 'rustyx'].map(engine => {
  const value = group.engines[engine], metric = key => value.metrics[key].median;
  return `<tr data-site="${group.site}" data-kind="${group.kind}"><th>${names[group.site]}<small>${esc(group.label)} · C${group.concurrency}</small></th><td class="${engine}">${engine === 'next' ? 'Next.js' : 'Rustyx'}</td><td>${value.validRuns}/${value.runs}</td><td>${fmt(metric('requestsPerSecond'), 0)}<small>${fmt(value.metrics.requestsPerSecond.min, 0)}–${fmt(value.metrics.requestsPerSecond.max, 0)}</small></td><td>${fmt(metric('cpuMsPerRequest'), 3)}</td><td>${fmt(metric('cpuPercentOneCore'), 0)} %</td><td>${fmt(metric('loadMedianRssMiB'))}</td><td>${fmt(value.peakRssMiB)}</td><td>${fmt(metric('p95Ms'), 2)}</td><td>${fmt(metric('p99Ms'), 2)}</td><td>${fmt(metric('ttfbP95Ms'), 2)}</td><td class="${value.errors || value.failedRuns ? 'bad' : 'good'}">${fmt(value.errors, 0)}${value.failedRuns ? ' / ' + value.failedRuns + ' essais incomplets' : ''}</td></tr>`;
}));
const buildRows = data.sites.flatMap(site => ['next', 'rustyx'].map(engine => {
  const record = site.engines[engine], build = kind => record.builds.find(item => item.kind === kind);
  const starts = all.filter(run => run.site === site.name && run.engine === engine).map(run => run.startupMs);
  return `<tr data-site="${site.name}"><th>${names[site.name]}</th><td class="${engine}">${engine === 'next' ? 'Next.js' : 'Rustyx'}</td>${['cold', 'unchanged', 'page-edit'].map(kind => `<td>${build(kind)?.ok ? fmt(build(kind).wallMs / 1000, 2) + ' s' : 'ÉCHEC'}</td>`).join('')}<td>${fmt(build('cold')?.sampledPeakRssMiB)}</td><td>${fmt(median(starts), 0)} ms</td><td>${fmt(record.afterJourney?.rssMiB)}</td></tr>`;
}));
const enduranceRows = sustained.map(row => `<tr data-site="${row.site}"><th>${names[row.site]}</th><td class="${row.engine}">${row.engine === 'next' ? 'Next.js' : 'Rustyx'}</td><td>${fmt(row.requestsPerSecond, 0)}</td><td>${fmt(row.cpuMsPerRequest, 3)}</td><td>${fmt(row.loadMedianRssMiB)}</td><td>${fmt(row.sampledPeakRssMiB)}</td><td>${fmt(row.afterIdle?.rssMiB)}</td><td>${fmt(row.p95Ms, 2)}</td><td>${fmt(row.errors, 0)}</td><td>${row.recovery && valid(row.recovery) ? 'OK' : 'À vérifier'}</td></tr>`);
const bundleRows = data.sites.flatMap(site => ['next', 'rustyx'].map(engine => {
  const record = site.engines[engine], browser = record.browserCold;
  return `<tr data-site="${site.name}"><th>${names[site.name]}</th><td class="${engine}">${engine === 'next' ? 'Next.js' : 'Rustyx'}</td><td>${fmt(browser?.jsEncodedBytes / 1024)}</td><td>${fmt(browser?.cssEncodedBytes / 1024)}</td><td>${fmt(browser?.documentEncodedBytes / 1024)}</td><td>${fmt(record.imageCold?.completeMs, 1)}</td><td>${fmt(record.imageWarm?.completeMs, 1)}</td></tr>`;
}));
const compressionRows = groups.filter(group => group.scenario.includes('gzip') || group.scenario === 'export-identity').flatMap(group => ['next', 'rustyx'].map(engine => `<tr data-site="${group.site}"><th>${names[group.site]}<small>${esc(group.label)}</small></th><td class="${engine}">${engine === 'next' ? 'Next.js' : 'Rustyx'}</td><td>${esc(Object.keys(group.engines[engine].encodings).join(', '))}</td><td>${fmt(med(group, engine, 'meanBodyBytes') / 1024, 2)}</td><td>${fmt(med(group, engine, 'meanDecodedBytes') / 1024, 2)}</td><td>${fmt(med(group, engine, 'cpuMsPerRequest'), 3)}</td></tr>`));
const functionalRows = data.sites.map(site => `<tr><th>${names[site.name]}</th><td>${(site.comparisons || []).filter(check => check.equal).length}/${site.comparisons?.length || 0}</td><td>${fmt(site.visual?.changedPercent, 2)} %</td><td><a href="${site.name}-next.png">Next</a> · <a href="${site.name}-rustyx.png">Rustyx</a></td><td>${['next', 'rustyx'].map(engine => `${engine}: ${(site.engines[engine]?.runtimeErrors || []).length}`).join(' / ')}</td></tr>`);
const overloadRows = (stress?.runs || []).map(row => `<tr><th>${row.engine === 'next' ? 'Next.js' : 'Rustyx'} · passage ${row.repetition}</th><td>${fmt(row.requestsPerSecond, 0)}</td><td>${fmt(row.attempts, 0)}</td><td>${fmt(row.errors, 0)}</td><td>${fmt(100 * row.errors / row.attempts)} %</td><td>${fmt(row.loadMedianRssMiB)}</td><td>${fmt(row.p95Ms, 1)}</td><td>${esc(JSON.stringify(row.failures || {}))}</td><td>${row.recovery && valid(row.recovery) ? 'OK' : 'ÉCHEC'}</td></tr>`);
const analysis = await readFile(path.join(directory, 'analysis.md'), 'utf8').catch(() => 'Mesures en cours. L’analyse sera rédigée après validation de toute la campagne.');
const blocks = analysis.trim().split(/\n\s*\n/);
const inline = text => esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const analysisHtml = blocks.map(block => /^#{1,3} /.test(block) ? `<h3>${inline(block.replace(/^#{1,3} /, ''))}</h3>` : block.split('\n').every(line => /^- /.test(line)) ? `<ul>${block.split('\n').map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>` : `<p>${inline(block).replace(/\n/g, ' ')}</p>`).join('');
const lead = blocks.filter(block => !/^#/.test(block)).slice(0, 2).map(block => `<p>${inline(block)}</p>`).join('');
const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rustyx face à Next.js · Mesures actuelles</title>
<style>
:root{color-scheme:dark;--bg:#0a1220;--card:#142236;--line:#2b3b52;--text:#edf3fc;--muted:#adbed4;--rust:#74dfb6;--next:#91b9fa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:48px 32px}h1{font-size:clamp(34px,5vw,64px);letter-spacing:-2px;line-height:1.09;margin:16px 0 24px;max-width:1060px}h2{font-size:27px;margin:42px 0 12px}h3{font-size:18px;margin:0 0 15px}p{max-width:1100px}a{color:#96caff}nav{display:flex;flex-wrap:wrap;gap:16px}.eyebrow{text-transform:uppercase;letter-spacing:2px;color:var(--rust);font-size:12px}.intro{font-size:19px;color:var(--muted);max-width:950px}.stats,.grid{display:grid;gap:16px;grid-template-columns:repeat(4,1fr);margin:25px 0}.stat,article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}.stat b{font-size:32px;display:block;color:var(--rust)}.stat span,.muted,small{color:var(--muted)}.stat small{display:block;margin-top:5px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.controls{display:flex;flex-wrap:wrap;gap:18px;align-items:center;padding:16px 0}select{font:inherit;background:#192b43;border:1px solid #435a75;border-radius:8px;padding:9px 12px;color:var(--text);max-width:100%}label{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.scroll{overflow:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}td,th{padding:12px;text-align:right;border-bottom:1px solid var(--line);vertical-align:top}th:first-child{text-align:left}thead{background:#1c304a}th small,td small{display:block;font-size:11px;font-weight:400}.good,.rustyx{color:var(--rust)}.bad{color:#ffa691}.next{color:var(--next)}.notice{padding:16px 20px;border-left:3px solid var(--rust);background:#142a36}.analysis{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.75 system-ui;background:var(--card);padding:24px;border-radius:16px}.barrow{margin:18px 0}.barlabel{display:flex;justify-content:space-between;gap:12px;font-size:13px}.track{height:12px;background:#26374d;border-radius:4px;overflow:hidden;margin:6px 0}.fill{height:100%;background:var(--rust)}.fill.next{background:var(--next)}svg{max-width:100%;height:auto}.legend{display:flex;gap:20px;color:var(--muted);font-size:13px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;background:var(--rust)}.dot.next{background:var(--next)}.capacity svg text{font:11px system-ui;fill:var(--muted)}footer{margin:45px 0 0;color:var(--muted);font-size:13px}[hidden]{display:none!important}@media(max-width:760px){main{padding:28px 15px}.grid,.stats{grid-template-columns:1fr}h1{letter-spacing:-1px}.stat{padding:16px}.stat b{font-size:27px}}
</style></head><body><main>
<div class="eyebrow">Comparaison locale · ${esc(data.machine.cpu)} · ${fmt(data.machine.totalMemoryMiB / 1024, 0)} Gio · Node ${esc(data.versions.node)}</div>
<h1>Rustyx vaut-il le coup<br>face à Next.js ?</h1>
<p class="intro">Six configurations, les mêmes sources et des réponses vérifiées. Débit, coût CPU, mémoire, compilation et comportement après migration — avec les limites de chaque mesure.</p>
<nav><a href="#bilan">Bilan</a><a href="#comparaison">Comparaisons</a><a href="#concurrence">Concurrence</a><a href="#details">Détails</a><a href="#protocole">Protocole</a><a href="summary.csv">CSV Excel</a><a href="results.json">Données brutes</a></nav>
<div class="stats"><div class="stat"><b>${summary.trials + (summary.overload?.trials || 0)}</b><span>${summary.trials} passages principaux${summary.overload ? " + " + summary.overload.trials + " à 512 clients" : ""}</span></div><div class="stat"><b>${summary.functionalPassed}/${summary.functionalTotal}</b><span>contrôles fonctionnels équivalents</span></div><div class="stat"><b>${fmt(summary.validResponses, 0)}</b><span>réponses validées · essais principaux</span></div><div class="stat"><b>${fmt(summary.errors, 0)}</b><span>erreurs · essais principaux</span>${summary.overload ? `<small class="${summary.overload.errors ? "bad" : "good"}">${fmt(summary.overload.errors, 0)} erreurs / refus à 512 clients</small>` : ""}</div></div>
<p class="notice">Next.js ${esc(data.versions.next)} compilé avec webpack / React ${esc(data.versions.react)} face à Rustyx ${esc(data.versions.rustyx)}, version actuelle. Un worker Rustyx configuré ; les descendants et les threads React sont inclus dans le CPU et le RSS. Le JavaScript applicatif continue à tourner dans Node/V8.</p>
<section id="bilan"><h2>Ce que les résultats permettent de conclure</h2>${lead}<details><summary>Lire l’analyse complète, les avantages et les priorités d’amélioration</summary><div class="analysis" style="white-space:normal">${analysisHtml}</div></details></section>
<section id="comparaison"><h2>Un parcours mixte par projet</h2><p>Trois passages de ${data.method.mixedMs / 1000} secondes à quatre clients simultanés. Chaque projet a son propre mélange fixe de routes. Médianes ; les pourcentages comparent Rustyx à Next. Il n’existe pas de score global de vitesse valable pour tous ces usages.</p>
<div class="controls"><label>Projet <select id="site"><option value="all">Tous les projets</option>${Object.entries(names).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></label><label>Graphique <select id="metric"><option value="requestsPerSecond">Débit · req/s ↑</option><option value="cpuMsPerRequest">CPU · ms/réponse ↓</option><option value="loadMedianRssMiB">RSS · Mio ↓</option><option value="p95Ms">Latence P95 · ms ↓</option></select></label></div>
<div class="legend"><span><i class="dot next"></i>Next.js</span><span><i class="dot"></i>Rustyx</span></div><div class="grid" id="charts"></div>${mixedTable}</section>
<section id="concurrence"><h2>Comment évolue la capacité</h2><p>Parcours mixtes à 1, 4, 16, 64 et 128 clients simultanés. Le point C4 vient du parcours mixte ; les autres durent six secondes. Trois répétitions à C16/C64/C128 pour le dashboard et le portail, une observation pour les autres points. Une courbe qui plafonne ne mesure pas à elle seule un débit garanti en production.</p><div class="grid capacity" id="capacity"></div></section>
<section><h2>Charge continue et retour au calme</h2><p>Un passage de 60 secondes à 64 clients par moteur, puis 15 secondes sans charge et une vérification de récupération de deux secondes. Ce contrôle court ne constitue pas une preuve d’absence de fuite mémoire sur plusieurs jours.</p>${table(['Projet', 'Moteur', 'req/s', 'CPU ms/rép.', 'RSS médian', 'Pic RSS', 'RSS après repos', 'P95 ms', 'Erreurs', 'Reprise'], enduranceRows)}</section>
${stress ? `<section><h2>API asynchrone : 512 clients</h2><p>Test distinct sur l’API du portail avec 30 ms d’attente : trois passages de cinq secondes par moteur, puis une vérification de récupération. Le client réémet immédiatement, y compris après un refus, sans attendre Retry-After. Cette charge élevée peut dépasser la capacité d’admission ; les éventuelles erreurs restent séparées des passages principaux. Une absence de refus à ce point ne démontre pas une capacité illimitée.</p><p>En présence de refus, le coût CPU par succès inclut aussi le travail des refus et ne correspond plus à un travail utile identique. Le P95 ci-dessous ne concerne que les réponses réussies. Les résultats détaillés sont conservés dans <a href="stress.json">stress.json</a>.</p>${table(['Moteur / passage', 'Succès req/s', 'Tentatives', 'Erreurs / refus', 'Taux', 'RSS Mio', 'P95 succès ms', 'Nature des erreurs', 'Reprise'], overloadRows)}</section>` : ''}
<section id="details"><h2>Tous les scénarios et leur dispersion</h2><p>Débit : médiane et intervalle min–max observé. CPU/RSS/latences : médianes des essais valides. Pic RSS : maximum échantillonné parmi les essais valides, pas un plafond garanti. « Valides » exclut erreurs, essais incomplets, compteur CPU invalide et plafonds du client atteints ; ces exclusions restent visibles. P95/P99 portent sur les réponses réussies. 100 % CPU correspond à un cœur. Les variations de moins de 5 % sont grisées dans les comparaisons, sans test de significativité.</p>
<label>Scénarios <select id="kind"><option value="all">Tous</option><option value="route">Routes individuelles</option><option value="mixed">Parcours mixtes</option><option value="capacity">Concurrence</option><option value="sustained">Charge continue</option></select></label><br>
${table(['Projet / scénario', 'Moteur', 'Valides', 'req/s ↑ · min–max', 'CPU ms/rép. ↓', 'CPU total', 'RSS Mio ↓', 'Pic RSS Mio', 'P95 ms', 'P99 ms', 'TTFB P95 ms', 'Erreurs'], detailRows)}</section>
<section><h2>Compiler et démarrer</h2><p>Build initial sans artefacts, rebuild inchangé, puis modification identique du titre de la page d’accueil. Une observation par build ; caches système non purgés. Next utilise <code>--webpack</code> : ces temps ne comparent pas Turbopack. Le démarrage est la médiane des serveurs de charge jusqu’à un fichier de santé statique ; il n’inclut pas l’initialisation différée du premier rendu dynamique.</p>${table(['Projet', 'Moteur', 'Initial', 'Inchangé', 'Page modifiée', 'Pic RSS build Mio', 'Démarrage', 'RSS après navigation'], buildRows)}</section>
<section><h2>Ce que reçoit le navigateur</h2><p>Une observation par page d’accueil : octets transférés pour les ressources JS/CSS avant la capture, préchargements possibles inclus. Ce n’est ni le CPU du navigateur, ni une mesure LCP/INP, ni le poids minimal du bundle. L’image n’est chronométrée à froid/chaud que pour la boutique Edge.</p>${table(['Projet', 'Moteur', 'JS Kio', 'CSS Kio', 'Document Kio', 'Image froide ms', 'Image chaude ms'], bundleRows)}</section>
<section><h2>Compression réellement effectuée</h2><p>Accepter gzip dans la requête n’oblige pas le serveur à compresser. Sur l’export JSON du portail, Next renvoie ici le corps sans compression, tandis que Rustyx le compresse. Le supplément CPU de ce scénario finance donc aussi une réduction du trafic réseau ; ce n’est pas un comparatif de deux compresseurs effectuant la même tâche. La ligne sans compression permet de comparer le traitement de corps de même taille.</p>${table(['Projet / scénario', 'Moteur', 'Encodage observé', 'Transféré Kio/rép.', 'Décodé Kio/rép.', 'CPU ms/rép.'], compressionRows)}</section>
<section><h2>Comportement avant / après migration</h2><p>Navigation SPA, hydratation, Server Actions, cookies, routes interceptées, i18n, ISR, proxy, streaming et optimisation réelle d’image. Les captures et les sources des douze copies sont conservées. La différence de pixels utilise un seuil de 16 niveaux RGB ; elle ne prouve pas l’équivalence de toutes les interactions.</p>${table(['Projet', 'Contrôles égaux', 'Pixels différents', 'Captures', 'Erreurs JS non interceptées'], functionalRows)}</section>
<section id="protocole"><h2>Protocole et limites</h2><ul>
<li>Serveurs de production successifs, nouveau processus avant chaque essai, ordre des moteurs alterné. Aucun changement du moteur pendant cette campagne. Empreintes des sources, du binaire et des scripts enregistrées.</li>
<li>Routes : trois essais de cinq secondes. Parcours mixtes : trois essais de huit secondes. Échauffement de 200 requêtes à C4, sauf streaming (16) et API asynchrone (40). Les cookies et paramètres personnalisés changent et sont vérifiés à chaque réponse.</li>
<li>CPU : différence du temps cumulé du serveur et de ses descendants. RSS : somme des processus, échantillonnée environ toutes les 150 ms ; des pages physiques partagées peuvent être comptées plusieurs fois. Le pic réel entre échantillons peut être plus élevé.</li>
<li>Le client de charge est un processus distinct, exclu des chiffres serveur mais sur la même machine. Son CPU est conservé dans le JSON. Il peut limiter les routes très rapides. Charge en boucle fermée, sans débit d’arrivée indépendant imposé.</li>
<li>Les cœurs du Mac M4 sont disponibles pour les serveurs ; « un worker » ne signifie pas « un seul cœur ». Aucun quota CPU de conteneur n’est imposé. Les résultats ne prédisent pas ceux d’un hébergement à un vCPU ou d’une machine Linux/x86.</li>
<li>Pas de CDN, TLS, réseau distant ou base de données externe. Attentes asynchrones synthétiques de 30/80 ms. Pas de test d’endurance de plusieurs heures. Pas de mesure énergétique ou de facture d’hébergement.</li>
<li>La référence Next est un serveur <code>next start</code> issu d’un build webpack. Turbopack et un export statique Next servi sans Node ne sont pas mesurés ici. Les très faibles RSS Rustyx des routes purement statiques concernent un serveur neuf qui n’a pas encore démarré son worker JavaScript.</li>
<li>Projets de démonstration contrôlés, pas six applications de production indépendantes : la boutique Node est une variante de la boutique Edge. Les contrôles passés n’établissent pas une compatibilité Next.js à 100 %.</li>
<li>Médianes et dispersion descriptive, sans intervalle de confiance : trois répétitions ne suffisent pas à établir de petits gains. Les différences de CPU, RAM, débit et poids réseau doivent être lues ensemble.</li></ul>
<p><a href="README.md">Reproduction</a> · <a href="analysis.md">Analyse</a> · <a href="measurements.csv">Passages principaux CSV</a> · <a href="summary.csv">Médianes et dispersion CSV</a> · <a href="builds.csv">Compilations CSV</a> ${stress ? '· <a href="overload.csv">Surcharge CSV</a> ' : ''}· <a href="summary.json">Synthèse JSON</a> · <a href="results.json">Résultats et processus bruts</a></p></section>
<footer>Campagne ${esc(data.date)} → ${esc(data.finishedAt || 'en cours')}. ${data.completed ? 'Mesures terminées.' : 'Résultats provisoires.'} ${summary.recoveryResponses.toLocaleString('fr-FR')} réponses de récupération supplémentaires, ${summary.recoveryErrors} erreurs, comptées séparément.</footer>
</main><script>
const groups=${JSON.stringify(groups).replace(/</g, '\\u003c')},names=${JSON.stringify(names)};
const site=document.querySelector('#site'),metric=document.querySelector('#metric'),kind=document.querySelector('#kind');
const f=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('fr-FR',{maximumFractionDigits:d}):'—';
const val=(g,e,k)=>g?.engines[e].metrics[k].median;
function render(){
 const selected=site.value,key=metric.value,rows=groups.filter(g=>g.scenario==='mixed'&&(selected==='all'||g.site===selected));
 document.querySelector('#charts').innerHTML=rows.map(g=>{const max=Math.max(1e-9,val(g,'next',key)||0,val(g,'rustyx',key)||0);return '<article><h3>'+names[g.site]+'</h3>'+['next','rustyx'].map(e=>'<div class="barrow"><div class="barlabel"><span>'+(e==='next'?'Next.js':'Rustyx')+'</span><b>'+f(val(g,e,key),key==='cpuMsPerRequest'?3:key==='requestsPerSecond'?0:2)+'</b></div><div class="track"><div class="fill '+e+'" style="width:'+100*(val(g,e,key)||0)/max+'%"></div></div></div>').join('')+'</article>'}).join('');
 document.querySelectorAll('[data-site]').forEach(row=>row.hidden=(selected!=='all'&&row.dataset.site!==selected)||(row.dataset.kind&&kind.value!=='all'&&kind.value!==row.dataset.kind));
 document.querySelector('#capacity').innerHTML=Object.keys(names).filter(s=>selected==='all'||selected===s).map(s=>{
  const points=[1,4,16,64,128],get=c=>groups.find(g=>g.site===s&&g.scenario===(c===4?'mixed':'capacity-'+c));
  const max=Math.max(1e-9,...points.flatMap(c=>['next','rustyx'].map(e=>val(get(c),e,key)||0)))*1.12;
  const x=i=>55+i*100,y=n=>225-180*n/max;
  let svg='<svg viewBox="0 0 500 275" role="img" aria-label="'+names[s]+' capacité">';
  for(let i=0;i<4;i++){let v=max*i/3;svg+='<path d="M55 '+y(v)+' H460" stroke="#304156"/><text x="4" y="'+(y(v)+4)+'">'+f(v,key==='cpuMsPerRequest'?2:0)+'</text>'}
  for(const e of ['next','rustyx']){const color=e==='next'?'#91b9fa':'#74dfb6';const good=points.map((c,i)=>({g:get(c),i})).filter(p=>Number.isFinite(val(p.g,e,key)));svg+='<polyline fill="none" stroke="'+color+'" stroke-width="3" points="'+good.map(p=>x(p.i)+','+y(val(p.g,e,key))).join(' ')+'"/>';svg+=good.map(p=>'<circle r="4" fill="'+color+'" cx="'+x(p.i)+'" cy="'+y(val(p.g,e,key))+'"><title>'+e+' C'+points[p.i]+': '+f(val(p.g,e,key),3)+'</title></circle>').join('')}
  svg+=points.map((c,i)=>'<text text-anchor="middle" x="'+x(i)+'" y="250">C'+c+'</text>').join('')+'</svg>';return '<article><h3>'+names[s]+'</h3>'+svg+'</article>';
 }).join('');
}
for(const control of [site,metric,kind])control.addEventListener('change',render);render();
</script></body></html>`;
await writeFile(path.join(directory, 'performance.html'), html);
assert.equal(groups.flatMap(group => Object.values(group.engines)).reduce((n, value) => n + value.runs, 0), all.length);
console.log(JSON.stringify({trials: summary.trials, valid: summary.validTrials, requests: summary.validResponses, errors: summary.errors, checks: `${summary.functionalPassed}/${summary.functionalTotal}`, groups: groups.length}));
