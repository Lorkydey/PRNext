import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {sha} from './dynamic-benchmark/harness.mjs';
import {scenarios} from './dynamic-benchmark/protocol.mjs';
import {binary} from '../tests/support.mjs';

const root=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/stream-optimization');
const data=JSON.parse(await readFile(path.join(root,'final-results.json'),'utf8'));
const method=JSON.parse(await readFile(path.join(root,'method.json'),'utf8'));
const require=createRequire(path.join(root,'projects/next/package.json'));
const versions=Object.fromEntries(['next','react'].map(name=>[name,require(name+'/package.json').version]));
let validation;
try{validation=JSON.parse(await readFile(path.join(root,'validation.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
if(validation)assert.equal(validation.binarySha256,data.binarySha256,'Integration tests used another binary');
assert.equal(data.valid,true);assert.equal(data.runs.length,90);assert.equal(data.repetitions,3);
assert.ok(data.parity);
for(const [file,hash] of Object.entries(method.sources))assert.equal(sha(await readFile(file)),hash,'Measurement source changed: '+file);
assert.equal(sha(await readFile(binary)),data.binarySha256);assert.equal(data.binarySha256,method.binarySha256);
assert.equal(sha(await readFile(path.join(root,'projects/baseline-binary/rustyx'))),data.baseline.binarySha256);
async function fingerprint(root){
  const rows=[];
  async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())rows.push([path.relative(root,file),sha(await readFile(file))]);}}
  await walk(path.join(root,'.rustyx'));return sha(JSON.stringify(rows));
}
assert.equal(await fingerprint(path.join(root,'projects/baseline')),data.baseline.runtimeSha256);
assert.equal(await fingerprint(path.join(root,'projects/candidate')),data.candidateSha256);
const variants=['baseline','baseline-compact','candidate','compact','next'];
const names={baseline:'Avant · standard','baseline-compact':'Avant · compact',candidate:'Après · standard',compact:'Après · compact',next:'Next.js'};
const labels={stream:'Streaming / Suspense',ssr:'SSR sans cache',data:'SSR avec données'};
const fields=['requestsPerSecond','cpuMsPerResponse','cpuPercentOneCore','idleColdRssMiB','idleWarmRssMiB','loadMedianRssMiB','loadPeakRssMiB','p50Ms','p95Ms','p99Ms','ttfbP50Ms','ttfbP95Ms','ttfbP99Ms','meanBodyBytes','backendCallsPerSecond','clientCpuPercent'];
const signatures=new Set();
for(const row of data.runs){
  const signature=[row.variant,row.scenario,row.profile,row.repetition].join('/');assert.ok(!signatures.has(signature));signatures.add(signature);
  assert.ok(row.valid);assert.deepEqual(row.errors,{});assert.equal(row.requests,row.attempts);assert.ok(row.requests>0);
  assert.deepEqual(row.encodings,{gzip:row.requests});
  const scenario=scenarios.find(s=>s.id===row.scenario);
  assert.equal(row.work.counts[scenario.event],row.requests);assert.equal(row.work.backendCalls,row.requests*scenario.backendPerRequest);
  if(row.scenario==='stream')for(const event of ['async:stream','complete:stream'])assert.equal(row.work.counts[event],row.requests);
  assert.ok(row.ttfbP95Ms<=row.p95Ms&&row.p50Ms<=row.p95Ms&&row.p95Ms<=row.p99Ms);
  assert.ok(row.loadMedianRssMiB<=row.loadPeakRssMiB);
  assert.ok(Math.abs(row.cpuPercentOneCore-row.cpuMsPerResponse*row.requestsPerSecond/10)<1e-8);
  if(row.profile==='fixed-250'){assert.ok(Math.abs(row.requestsPerSecond/250-1)<.05);assert.ok(row.scheduleLagP95Ms<10)}
  Object.assign(row,{idleColdRssMiB:row.idleCold.rssMiB,idleWarmRssMiB:row.idleWarm.rssMiB,backendCallsPerSecond:row.work.backendCalls*1000/row.elapsedMs});
}
for(const variant of variants){
  const folder=path.join(root,'parity-'+variant),engine=variant==='next'?'next':'rustyx';
  const parity=JSON.parse(await readFile(path.join(folder,'results.json'),'utf8'));
  assert.equal(parity.result.checks.length,21);assert.ok(parity.result.checks.every(c=>c.pass));
  if(variant!=='next')assert.equal(sha(JSON.stringify(parity)),method.evidence[variant].sha256);
  const proof=(await readFile(path.join(folder,engine+'-ssr-10000.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(proof.length,10000);assert.ok(proof.every(e=>e.kind==='render:ssr'&&e.input.token==='constant'));
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const groups=[];
for(const scenario of Object.keys(labels))for(const profile of ['concurrency-32','fixed-250']){
  const group={scenario,label:labels[scenario],profile,variants:{}};
  for(const variant of variants){
    const rows=data.runs.filter(r=>r.scenario===scenario&&r.profile===profile&&r.variant===variant);assert.equal(rows.length,3);
    group.variants[variant]=Object.fromEntries(fields.map(field=>[field,{median:median(rows.map(r=>r[field])),min:Math.min(...rows.map(r=>r[field])),max:Math.max(...rows.map(r=>r[field]))}]));
  }
  groups.push(group);
}
const summary={finishedAt:data.finishedAt,runs:90,responses:data.runs.reduce((sum,r)=>sum+r.requests,0),parityChecks:105,machine:method.machine,versions,validation,groups};
const n=(value,digits=1)=>value.toLocaleString('fr-FR',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const stream=groups[0],fixed=groups[1];
const value=(g,v,f)=>g.variants[v][f].median;
const gain=(g,v,b,f)=>100*(value(g,v,f)/value(g,b,f)-1);
const notes=[
  'Le natif sépare 16 démarrages avant headers et 32 réponses vivantes par worker compatible avec le transport concurrent. Une 33e page attend. Les anciens transports restent à leur capacité négociée. Le budget natif de réponses en transit reste à 8 Mio par défaut et la file reste bornée ; les contextes React et les buffers des autres couches ne sont pas inclus dans ce budget.',
  'Le permis de démarrage est libéré aux headers. Le permis distinct de réponse reste détenu jusqu’à la consommation, la déconnexion ou l’expiration du flux : les clients lents restent soumis à la pression de retour.',
  'Même fixture applicative, API locale déterministe et générateur de charge. Streaming : un composant Suspense attend un fetch no-store retardé de 40 ms. Chaque réponse exige un rendu, une exécution async, une complétion et un appel backend. La coquille HTML arrive avant la libération du backend et le navigateur confirme le contenu hydraté.',
  'Trois répétitions, ordre des cinq configurations alterné. Chaque passage utilise un serveur neuf, 64 requêtes de chauffe, puis 4 s à concurrence 32 ou 6 s à 250 requêtes/s. Aucun test de charge concurrent. Le premier pilote est exclu des résultats finaux.',
  'RAM : somme RSS du serveur et de tous ses descendants, échantillonnée toutes les 150 ms. CPU : temps processeur serveur par réponse, backend et client exclus. 100 % de charge CPU représente un cœur. Le RSS peut compter certaines pages partagées plusieurs fois et dépend du GC.',
  'La comparaison à concurrence 32 produit des débits différents. La table à 250 requêtes/s compare une charge identique. Accepter davantage de rendus simultanés peut augmenter la RAM : le mode compact reste optionnel, sans plafond RSS garanti.',
  `${method.machine.cpu} / ${method.machine.os}, Node ${method.machine.node}, Next ${versions.next}, React applicatif ${versions.react}. Next embarque aussi son React canary. Mesures locales courtes, pas une garantie sur tous les sites, toutes les concurrences ou les VPS Linux.`,
  'Les différences de protocole Flight/Server Actions, de redirection, de 404 et de compression des Route Handlers restent exclues des comparaisons directes. Ici, tous les scénarios mesurés utilisent gzip et passent leurs contrôles de parité.',
  validation ? `Validation de cette modification : ${validation.tests.map(t=>t.passed+' tests '+t.name).join(', ')}, Clippy sans avertissement. Les tests couvrent 16 démarrages avant headers, 32 shells simultanés, attente de la 33e page, annulation sans perte des pairs et isolation cookies/headers.` : 'Les résultats de tests d’intégration ne sont pas joints à cette campagne ; les contrôles de parité et les réponses du benchmark sont vérifiés séparément.',
  'Les preuves Next et du runtime précédent de cette expérience sont reprises de leurs artefacts figés ; celles du nouveau binaire ont été rejouées avant cette campagne.',
];
const metrics=[['requestsPerSecond','Débit','req/s',0],['cpuMsPerResponse','CPU / réponse','ms',3],['cpuPercentOneCore','Charge CPU','% cœur',1],['loadMedianRssMiB','RAM sous charge','Mio',1],['ttfbP95Ms','TTFB p95','ms',2],['p95Ms','Réponse complète p95','ms',2]];
let md=`# Streaming Rustyx : optimisation de la concurrence\n\n${summary.runs} mesures, ${n(summary.responses,0)} réponses vérifiées, zéro erreur. ${summary.parityChecks} contrôles de parité sur cinq configurations.\n\n`;
md+=`À concurrence 32, le débit standard évolue de ${n(value(stream,'baseline','requestsPerSecond'),0)} à ${n(value(stream,'candidate','requestsPerSecond'),0)} req/s (${n(gain(stream,'candidate','baseline','requestsPerSecond'))} %), avec ${n(gain(stream,'candidate','baseline','loadMedianRssMiB'))} % de RSS supplémentaire. Le profil compact est mesuré séparément avant/après.\n\n`;
for(const group of groups){
  md+=`## ${group.label} — ${group.profile==='fixed-250'?'250 requêtes/s demandées':'concurrence 32'}\n\n| Configuration | ${metrics.map(m=>m[1]).join(' | ')} |\n|---|${metrics.map(()=>'---:|').join('')}\n`;
  for(const variant of variants)md+=`| ${names[variant]} | ${metrics.map(([field,,unit,digits])=>n(value(group,variant,field),digits)+' '+unit).join(' | ')} |\n`;
  md+='\n';
}
md+='## Méthode et limites\n\n'+notes.map(note=>'- '+note).join('\n')+'\n\n## Activation\n\nLe nouveau plafond est actif par défaut après reconstruction du binaire natif. Refaire aussi le build de l’application pour intégrer les optimisations précédentes du runtime.\n\n```sh\ncorepack yarn prn build\nRUSTYX_MEMORY_PROFILE=compact corepack yarn prn start\n```\n\nDans le dépôt Rustyx : `npm run build:native`. Sans variable, le mode standard reste actif. Protocole reproductible : `../../scripts/stream-optimization.md`.\n';
await writeFile(path.join(root,'README.md'),md);
await writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');
await writeFile(path.join(root,'metrics.csv'),'\ufeff'+['scenario;profile;variant;repetition;requests;'+fields.join(';'),...data.runs.map(row=>[row.scenario,row.profile,row.variant,row.repetition,row.requests,...fields.map(field=>row[field])].join(';'))].join('\n')+'\n');
const table=group=>`<div class="scroll"><table><thead><tr><th>Configuration</th>${metrics.map(m=>'<th>'+m[1]+'</th>').join('')}</tr></thead><tbody>${variants.map(v=>'<tr><th>'+names[v]+'</th>'+metrics.map(([field,,unit,digits])=>'<td>'+n(value(group,v,field),digits)+' '+unit+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`;
const html=`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rustyx — Streaming optimisé</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#e7edf8;font:16px/1.65 system-ui,sans-serif}main{max-width:1220px;margin:auto;padding:40px 24px}h1{font-size:clamp(32px,5vw,56px);line-height:1.12}h2{margin-top:38px;font-size:25px}.muted{color:#b6c5db}.eyebrow{color:#79e4bd;font-size:12px;font-weight:800;letter-spacing:.12em}.cards,.charts{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.charts{grid-template-columns:1fr 1fr}.card,.chart,details{background:#141f32;border:1px solid #2b3b52;padding:20px;border-radius:14px}.card strong{display:block;font-size:34px;color:#79e4bd}.card small{display:block;color:#b6c5db}.notice{border-left:3px solid #f5c574;padding:12px 18px;background:#191e28}.scroll{overflow-x:auto;border:1px solid #2b3b52;border-radius:12px}table{width:100%;white-space:nowrap;border-collapse:collapse;font-size:14px}th,td{text-align:right;padding:12px;border-bottom:1px solid #2b3b52}th:first-child{text-align:left}thead{background:#17243a}select{max-width:100%;background:#17243a;color:inherit;border:1px solid #586f8e;border-radius:8px;padding:12px;margin-right:12px}label{display:inline-block;margin-bottom:12px}label>span{display:block;font-size:13px;color:#b6c5db}.bar{margin:12px 0}.bar>div:first-child{display:flex;justify-content:space-between;font-size:13px;gap:12px}.track{height:10px;background:#25354c;margin-top:5px;border-radius:10px}.fill{height:100%;border-radius:10px}a{color:#8bbaff}pre{overflow:auto;background:#17243a;padding:18px;border-radius:12px}details{margin:24px 0}li{margin:12px 0}footer{margin-top:30px;font-size:14px}@media(max-width:680px){main{padding:24px 16px}.cards,.charts{grid-template-columns:1fr}}
</style><main><div class="eyebrow">RUSTYX · STREAMING · ${data.finishedAt.slice(0,10)}</div><h1>Les composants attendent.<br>Les autres pages avancent.</h1><p class="muted">Admission bornée à 16 démarrages et 32 réponses vivantes par worker. Comparaison du standard et du compact avant/après, avec Next.js. ${n(summary.responses,0)} réponses vérifiées sur 90 mesures ; aucune erreur.</p><div class="cards"><div class="card"><strong>${n(value(stream,'candidate','requestsPerSecond'),0)} req/s</strong>Rustyx standard, concurrence 32<small>${n(gain(stream,'candidate','baseline','requestsPerSecond'))} % de débit supplémentaire face au standard précédent.</small></div><div class="card"><strong>${n(value(stream,'compact','loadMedianRssMiB'))} Mio</strong>Rustyx compact sous cette charge<small>Next.js : ${n(value(stream,'next','loadMedianRssMiB'))} Mio, avec un débit différent.</small></div><div class="card"><strong>${n(value(stream,'candidate','cpuMsPerResponse'),3)} ms</strong>CPU par réponse standard<small>Avant : ${n(value(stream,'baseline','cpuMsPerResponse'),3)} ms. Next.js : ${n(value(stream,'next','cpuMsPerResponse'),3)} ms.</small></div></div><p class="notice">Le débit supplémentaire augmente la mémoire nécessaire aux rendus simultanés. Le standard consomme ici ${n(gain(stream,'candidate','baseline','loadMedianRssMiB'))} % de RSS supplémentaire face à sa version précédente. Le compact conserve un compromis distinct ; les deux profils restent affichés.</p><h2>Streaming à concurrence 32</h2>${table(stream)}<h2>Streaming à charge identique</h2><p class="muted">250 requêtes/s demandées aux cinq configurations.</p>${table(fixed)}<h2>Explorer le streaming et les contrôles SSR</h2><label><span>Scénario</span><select id="scenario">${Object.entries(labels).map(([id,label])=>'<option value="'+id+'">'+label+'</option>').join('')}</select></label><label><span>Charge</span><select id="profile"><option value="concurrency-32">32 requêtes simultanées</option><option value="fixed-250">250 requêtes/s demandées</option></select></label><div id="charts" class="charts"></div><details><summary>Méthode, tests et limites</summary><ul>${notes.map(note=>'<li>'+note+'</li>').join('')}</ul></details><h2>Activer le compact</h2><pre><code>corepack yarn prn build
RUSTYX_MEMORY_PROFILE=compact corepack yarn prn start</code></pre><p class="muted">Le nouveau plafond est déjà intégré au binaire natif reconstruit du dépôt. Sans la variable, le profil standard reste actif.</p><footer><a href="README.md">Rapport Markdown</a> · <a href="final-results.json">Mesures brutes</a> · <a href="summary.json">Médianes et variations</a> · <a href="metrics.csv">CSV</a> · <a href="verification.json">Vérification</a></footer></main><script>const groups=${JSON.stringify(groups)},names=${JSON.stringify(names)},variants=${JSON.stringify(variants)},colors=['#b39575','#ccb8a5','#7aa8ff','#79e4bd','#8190a9'];function draw(){const group=groups.find(g=>g.scenario===document.querySelector('#scenario').value&&g.profile===document.querySelector('#profile').value);document.querySelector('#charts').innerHTML=${JSON.stringify(metrics.filter(([field])=>['requestsPerSecond','cpuMsPerResponse','loadMedianRssMiB','ttfbP95Ms'].includes(field)))}.map(([field,title,unit,digits])=>{const max=Math.max(...variants.map(v=>group.variants[v][field].max));const fmt=n=>n.toLocaleString('fr-FR',{maximumFractionDigits:digits,minimumFractionDigits:digits});return '<div class="chart"><strong>'+title+'</strong>'+variants.map((v,i)=>{const m=group.variants[v][field];return '<div class="bar"><div><span>'+names[v]+'</span><span>'+fmt(m.median)+' '+unit+'</span></div><div class="track" title="Min–max : '+fmt(m.min)+' – '+fmt(m.max)+'"><div class="fill" style="width:'+100*m.median/max+'%;background:'+colors[i]+'"></div></div></div>'}).join('')+'</div>'}).join('')}document.querySelectorAll('select').forEach(s=>s.addEventListener('change',draw));draw();</script></html>`;
await writeFile(path.join(root,'index.html'),html);
await writeFile(path.join(root,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),runs:90,responses:summary.responses,errors:0,parityChecks:105,ssrProofPerVariant:10000,binarySha256:data.binarySha256,candidateSha256:data.candidateSha256,sources:method.sources},null,2)+'\n');
console.log('Verified streaming report:',summary.responses,'responses;',90,'runs.');
