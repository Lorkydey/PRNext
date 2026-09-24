import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null};
const fmt=(value,digits=2)=>Number.isFinite(value)?value.toFixed(digits):'—';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function summarizeLoad(report){
  return report.sites.flatMap(site=>['home','mixed'].map(scenario=>{
    const engines={};
    for(const engine of ['next','rustyx']){
      const runs=(site.load||[]).filter(r=>r.engine===engine&&r.scenario===scenario);
      engines[engine]={repetitions:runs.length,errors:runs.reduce((n,r)=>n+r.errors,0),requests:runs.reduce((n,r)=>n+r.requests,0),
        rssMiB:median(runs.map(r=>r.loadMedianRssMiB)),peakMiB:runs.length?Math.max(...runs.map(r=>r.sampledPeakRssMiB)):null,
        cpuPer1000:median(runs.map(r=>r.cpuMsPerRequest===null?null:r.cpuMsPerRequest*1000)),cpuPercent:median(runs.map(r=>r.cpuPercentOneCore)),
        reqSec:median(runs.map(r=>r.requestsPerSecond)),p95Ms:median(runs.map(r=>r.p95Ms)),bodyKiB:median(runs.map(r=>r.meanBodyBytes/1024)),
        valid:runs.length===3&&runs.every(r=>r.cpuValid&&!r.errors&&!r.reachedCap)};
    }
    return{site:site.name,scenario,...engines};
  })).filter(row=>row.next.repetitions||row.rustyx.repetitions);
}
function chart(rows,key,title,unit){
  const width=660,height=100+rows.length*100,max=Math.max(1,...rows.flatMap(r=>[r.next[key]||0,r.rustyx[key]||0]));
  let body=`<rect width="100%" height="100%" fill="#fff"/><text x="24" y="30" font-size="20" font-weight="700">${escape(title)}</text><text x="24" y="52" fill="#61716c" font-size="12">${escape(unit)} · bleu : Next.js · vert : Rustyx</text>`;
  rows.forEach((r,i)=>{const y=80+i*100;body+=`<text x="24" y="${y}" font-size="14">${escape(r.site+' / '+(r.scenario==='home'?'accueil':'mixte'))}</text>`;['next','rustyx'].forEach((engine,j)=>{const value=r[engine][key];body+=`<rect x="24" y="${y+10+j*26}" width="${(value||0)/max*510}" height="18" rx="3" fill="${engine==='next'?'#4479c5':'#27836a'}"/><text x="${34+(value||0)/max*510}" y="${y+24+j*26}" font-size="12">${fmt(value,key==='reqSec'?0:2)}</text>`})});
  return`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,sans-serif" fill="#19382c">${body}</svg>`;
}
export async function writePerformanceReport(report,output){
  const rows=summarizeLoad(report);if(!rows.length)return;
  const method='Production sur la même machine, sans CDN ni TLS. Trois répétitions de 2 secondes, quatre requêtes concurrentes, 200 requêtes d’échauffement identiques par moteur, serveur neuf pour chaque charge et ordre Next/Rustyx alterné. Accueil : une seule route. Mixte : répartition égale entre les routes décrites ci-dessous. Le CPU est le delta du temps CPU cumulé du serveur et de ses descendants, mesuré par ps ; 100 % représente un cœur et non toute la machine. Le générateur de charge est un processus séparé, exclu du CPU/RAM serveur, mais partage le processeur. La RAM est la somme du RSS des processus serveur, échantillonnée environ toutes les 150 ms ; des pages partagées peuvent être comptées plusieurs fois. Les pics sont des maxima observés, pas des pics instantanés garantis. Les chiffres sont les médianes des répétitions, sauf le pic (maximum) et les erreurs (somme). Rustyx : un worker configuré, démarré à la demande ; Next : configuration par défaut. Ce test ne mesure pas la saturation maximale, le CPU de compilation ou le coût CPU du navigateur.';
  const headers=['Projet / charge','Moteur','RAM (Mio)','Pic (Mio)','CPU (% cœur)','CPU / 1 000 req (ms)','Req/s','p95 (ms)','Corps (Kio)','Erreurs','Rép.'];
  const values=rows.flatMap(r=>['next','rustyx'].map(e=>[r.site+' / '+r.scenario,e,fmt(r[e].rssMiB),fmt(r[e].peakMiB),fmt(r[e].cpuPercent,1),fmt(r[e].cpuPer1000),fmt(r[e].reqSec,0),fmt(r[e].p95Ms),fmt(r[e].bodyKiB),String(r[e].errors),String(r[e].repetitions)+(r[e].valid?'':' *')]));
  for(const[key,title,unit]of [['rssMiB','RAM sous charge','Mio — moins est mieux'],['cpuPer1000','CPU par quantité de travail','ms / 1 000 requêtes valides — moins est mieux'],['reqSec','Débit avec 4 requêtes concurrentes','requêtes / seconde — plus est mieux']])await writeFile(path.join(output,`performance-${key}.svg`),chart(rows,key,title,unit));
  const workloads=report.sites.map(site=>`${site.name}: ${(site.load?.find(r=>r.scenario==='mixed')?.workloads||[]).map(w=>(w.method||'GET')+' '+w.endpoint).join(' ; ')}`).join('\n');
  const totalErrors=rows.reduce((n,r)=>n+r.next.errors+r.rustyx.errors,0);
  const status=`${rows.length} charges comparées ; ${totalErrors} réponses invalides/erreurs. * = mesure incomplète ou non comparable (erreur, limite de requêtes ou disparition d’un processus).`;
  const provenance=`${report.date} · Next ${report.versions.next} · Rustyx ${report.versions.rustyx} · ${report.machine.cpu} · ${report.machine.os}/${report.machine.arch} · ${report.machine.node}`;
  await writeFile(path.join(output,'performance-summary.json'),JSON.stringify({date:report.date,method,rows},null,2)+'\n');
  await writeFile(path.join(output,'performance.md'),`# RAM, CPU et débit : Next.js / Rustyx\n\n${provenance}\n\n${status}\n\n${method}\n\n| ${headers.join(' | ')} |\n| ${headers.map(()=> '---').join(' | ')} |\n${values.map(v=>'| '+v.join(' | ')+' |').join('\n')}\n\n## Charges\n\n\`\`\`text\n${workloads}\n\`\`\`\n\nLes requêtes PPR portent des cookies distincts et la recherche SSR des paramètres distincts ; les réponses doivent contenir leur valeur. Les statuts et contenus sont contrôlés, y compris les POST API. La moyenne des octets de réponse est indiquée car les transports HTML/RSC des moteurs diffèrent.\n\n[Graphiques et tableau](performance.html) · [Mesures brutes et détails des processus](results.json) · [Tests fonctionnels](index.html).\n`);
  const table=`<table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${values.map(v=>'<tr>'+v.map(cell=>`<td>${escape(cell)}</td>`).join('')+'</tr>').join('')}</tbody></table>`;
  await writeFile(path.join(output,'performance.html'),`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rustyx / Next.js — RAM et CPU</title><style>body{font:15px system-ui;background:#f3f6f4;color:#19382c;margin:32px auto;padding:24px;max-width:1500px}h1{font-size:36px}section{background:#fff;padding:24px;border-radius:14px;margin:20px 0}.charts{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.charts img{width:100%}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px;border-bottom:1px solid #dee5df;text-align:right}th:first-child,td:first-child{text-align:left}tr:nth-child(even){background:#edf6f0}a{color:#236c55}pre{white-space:pre-wrap}.scroll{overflow:auto}@media(max-width:900px){.charts{grid-template-columns:1fr}}</style><h1>Next.js et Rustyx après correction</h1><p>${escape(provenance)}</p><p><a href="index.html">Tests et captures avant/après</a> · <a href="performance.md">Tableau Markdown</a> · <a href="results.json">Données brutes</a></p><section><strong>${escape(status)}</strong><p>Le CPU par 1 000 requêtes compare le coût d’un même nombre de réponses. Un pourcentage CPU plus bas seul ne signifie pas une meilleure efficacité si le débit est aussi plus bas.</p></section><div class="charts">${['rssMiB','cpuPer1000','reqSec'].map(key=>`<a href="performance-${key}.svg"><img alt="${key}" src="performance-${key}.svg"></a>`).join('')}</div><section class="scroll">${table}</section><section><h2>Méthode et limites</h2><p>${escape(method)}</p><h2>Charges réelles des sites</h2><pre>${escape(workloads)}</pre><p>Les cookies PPR et paramètres SSR changent entre requêtes ; leur présence dans la réponse est vérifiée. Les corps HTML/RSC et leurs tailles diffèrent normalement entre moteurs. Les tests fonctionnels valident séparément le comportement dans le navigateur.</p></section></html>`);
}
