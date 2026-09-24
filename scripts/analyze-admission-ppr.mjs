import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const dir='reports/admission-ppr';
const r=JSON.parse(await readFile(dir+'/results.json','utf8'));
const groups=JSON.parse(await readFile(dir+'/summary.json','utf8'));
assert.ok(r.completed);
const get=(site,id)=>groups.find(g=>g.site===site&&g.scenario===id);
const val=(g,e,k)=>g.engines[e].metrics[k].median;
const f=(x,d=1)=>x.toLocaleString('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(a,b)=>((a/b-1)*100);
const change=(g,e,k)=>{const d=pct(val(g,'rustyx',k),val(g,e,k));return (d>=0?'+':'')+f(d)+' %'};
const pprLong=get('dashboard','sustained-ppr');
const total=r.runs.reduce((n,x)=>n+x.requests,0);
const baseRows=[['portail','async-64'],['portail','async-512'],['portail','mixed-128'],['portail','proxy-64'],['dashboard','ppr-html'],['dashboard','ppr-flight'],['dashboard','mixed-64'],['journal','api-pages']].map(([site,id])=>{const g=get(site,id);return`| ${site} · ${g.label} | ${f(val(g,'before','requestsPerSecond'),0)} → ${f(val(g,'rustyx','requestsPerSecond'),0)} | ${change(g,'before','requestsPerSecond')} | ${g.engines.before.errors?'Non comparable¹':change(g,'before','cpuMsPerRequest')} | ${f(val(g,'before','loadMedianRssMiB'),0)} → ${f(val(g,'rustyx','loadMedianRssMiB'),0)} |`}).join('\n');
const nextRows=[['portail','async-512'],['portail','mixed-128'],['dashboard','ppr-html'],['dashboard','ppr-flight'],['journal','api-pages']].map(([site,id])=>{const g=get(site,id);return`| ${site} · ${g.label} | ${f(val(g,'rustyx','requestsPerSecond')/val(g,'next','requestsPerSecond'),2)}× | ${change(g,'next','cpuMsPerRequest')} | ${change(g,'next','loadMedianRssMiB')} |`}).join('\n');
const sustained=['portail','dashboard'].map(site=>{const id=site==='portail'?'sustained-async':'sustained-ppr',g=get(site,id);return`${site} : ${['before','next','rustyx'].map(e=>`${e==='before'?'Rustyx avant':e==='next'?'Next':'Rustyx final'} = ${f(val(g,e,'requestsPerSecond'),0)} réponses/s, ${f(val(g,e,'cpuMsPerRequest'),3)} ms CPU/réponse, ${f(val(g,e,'loadMedianRssMiB'),0)} Mio RSS, P95 ${f(val(g,e,'p95Ms'),1)} ms`).join(' ; ')}. Face à la version précédente : débit ${change(g,'before','requestsPerSecond')}, ${g.engines.before.errors?'CPU par réponse non comparable¹':'CPU/réponse '+change(g,'before','cpuMsPerRequest')}, RSS ${change(g,'before','loadMedianRssMiB')}, P95 ${change(g,'before','p95Ms')}. Face à Next : débit ${change(g,'next','requestsPerSecond')}, CPU/réponse ${change(g,'next','cpuMsPerRequest')}, RSS ${change(g,'next','loadMedianRssMiB')}.`}).join('\n\n');
const overload=r.runs.filter(x=>x.scenario==='overload-1024').map(x=>`${x.engine==='before'?'Rustyx avant':x.engine==='next'?'Next':'Rustyx final'} : ${f(x.errors,0)} erreurs/refus sur ${f(x.attempts,0)} tentatives (${f(100*x.errors/x.attempts,2)} %)${x.errors?' ; '+Object.entries(x.failures).map(([k,v])=>`${k} : ${f(v,0)}`).join(', '):''}. Récupération C4 : ${x.recovery.errors} erreur.`).join('\n\n');
const heap=JSON.parse(await readFile(dir+'/experiments/heap.json','utf8'));
const heapRows=[8,16,32].map(n=>{const a=heap.runs.filter(x=>x.heap===n);return`| ${n} Mio | ${f(a.reduce((s,x)=>s+x.cpuMsPerRequest,0)/a.length,3)} | ${f(a.reduce((s,x)=>s+x.loadMedianRssMiB,0)/a.length,1)} |`}).join('\n');
const text=`# Résultats des optimisations d’admission et du PPR

Version finale : ordonnanceur Rust à connexions créées à la demande, jusqu’à 512 admissions API et 16 rendus React par worker, préparation statique PPR bornée et jeune génération RSC de 16 Mio. Les codes JavaScript/npm et React s’exécutent toujours dans Node ; l’admission et le transport sont gérés en Rust.

108 essais, ${f(total,0)} réponses validées, neuf vérifications de récupération réussies. Rustyx final ne produit aucune erreur hors surcharge C1024. Les 22 comparaisons fonctionnelles des trois projets passent, ainsi que 537 tests JavaScript, 124 tests Rust, 273 tests HTTP et 30 tests navigateur. TypeScript et Clippy passent également.

## Face à Rustyx avant cette intervention

Médianes de trois essais de 6 secondes. RSS médian en charge, pas plafond de mémoire.

| Scénario | Réponses/s avant → après | Variation débit | Variation CPU/réponse | RSS Mio avant → après |
|---|---:|---:|---:|---:|
${baseRows}

¹ À C512, l’ancien moteur refuse une grande partie des tentatives. Son CPU par réponse utile inclut les refus : une baisse de ce ratio ne mesure pas seulement une accélération du code applicatif. Le gain de débit valide et la disparition des refus à C512 sont les indications pertinentes. À C64, les réponses de l’ancienne version restent valides, mais sa limite de 16 opérations actives bloque le débit.

## Face à Next.js 16.3.5

Même application source, version de production ; Next est compilé avec webpack. Un signe négatif sur CPU/RSS est favorable à Rustyx.

| Scénario | Débit Rustyx / Next | CPU par réponse | RSS |
|---|---:|---:|---:|
${nextRows}

Un coût CPU inférieur ne signifie pas nécessairement moins de CPU total : servir davantage de requêtes peut utiliser plus de cœurs. Les latences ne portent que sur les réponses valides ; les refus et erreurs sont comptés séparément.

## Charges prolongées : 45 secondes, une observation par moteur

${sustained}

La charge prolongée peut nuancer les essais courts : le préchauffage de V8, les collections mémoire et les ressources partagées de la machine évoluent. Une mesure de 45 secondes ne démontre pas l’absence de fuite sur plusieurs jours. Le PPR garde un aller-retour d’encodage/décodage du modèle vivant ; les préparations statiques ne suppriment pas ce travail. Dans cet essai prolongé PPR, les écarts face à Next sont de ${change(pprLong,'next','cpuMsPerRequest')} pour le CPU et ${change(pprLong,'next','loadMedianRssMiB')} pour le RSS. Des écarts proches de 1 % ne permettent pas de conclure à une supériorité sur ces deux métriques. Face à l’ancien Rustyx, le RSS passe de ${f(val(pprLong,'before','loadMedianRssMiB'),0)} à ${f(val(pprLong,'rustyx','loadMedianRssMiB'),0)} Mio et le P95 de ${f(val(pprLong,'before','p95Ms'),1)} à ${f(val(pprLong,'rustyx','p95Ms'),1)} ms. Le débit supérieur n’est donc pas un gain uniforme de latence. Les API Pages très rapides restent aussi un point à surveiller face à Next.

## Surcharge volontaire : C1024

${overload}

Les refus Rustyx sont intentionnels : 512 admissions API et 256 places d’attente par worker, avec délai borné, au lieu d’une accumulation sans limite. Le client relance immédiatement après chaque refus, sans respecter Retry-After. Ce taux n’est donc pas une prévision du taux d’erreur d’un site réel. Les éventuels ETIMEDOUT sont des erreurs de transport observées côté client dans cette rafale ; ces essais n’en identifient pas la cause et ne prouvent pas un défaut applicatif de Next. Le temps écoulé inclut la vidange des requêtes, ce qui peut pénaliser le débit mesuré en présence de délais réseau.

## Compromis CPU / RAM

La concurrence supplémentaire consomme plus de RAM sous forte charge que l’ancien plafond de 16 opérations. Le budget des corps reste de 32 Mio et les buffers de réponse restent bornés par flux, mais ce ne sont pas des plafonds globaux de RSS. Les connexions supplémentaires inactives ferment après 30 secondes. Les requêtes séquentielles réutilisent quelques connexions au lieu d’en ouvrir plusieurs centaines.

La préparation RSC conserve au plus huit représentations statiques détachées du décodeur, avec budget comptable de 512 Kio. Le mémo JSON garde au plus 16 artefacts et 256 Kio encodés ; les objets décodés s’ajoutent à cette limite. Les modèles vivants et les contextes visiteurs ne sont pas partagés. Les invalidations continuent à passer par le cache natif.

Le réglage V8 a fait l’objet d’une expérience séparée : deux passages de 30 secondes par valeur, ordre 8/16/32 puis 32/16/8, sur une copie du même build. Moyennes des deux passages :

| Jeune génération RSC | CPU ms/réponse | RSS Mio |
|---|---:|---:|
${heapRows}

16 Mio a été retenu comme compromis. La dispersion est visible dans les données brutes ; ces niveaux ne doivent pas être comparés directement à ceux d’une autre série. La campagne principale a été entièrement relancée après ce choix. Les résultats antérieurs restent dans heap8/ et pilot-results.json ; ils ne sont pas agrégés aux chiffres ci-dessus.

## Portée

Ces résultats montrent surtout l’intérêt de Rustyx pour un serveur combinant beaucoup d’attentes asynchrones avec des routes dynamiques. L’avantage n’est pas uniforme pour chaque route, chaque niveau de charge ou chaque budget CPU. Le transport Rust/Node et le runtime React officiel conservent un coût. Trois applications de démonstration, même avec des millions de réponses contrôlées, ne prouvent ni la compatibilité exhaustive Next.js/npm ni une capacité universelle en production.

Les essais sont exécutés un par un sur le même Mac Apple M4 de 16 Gio, sans compilations, tests ou profileurs en parallèle. Le client de charge partage la machine mais est exclu du CPU/RSS serveur. Des processus de bureau et les caches OS restent présents ; le RSS peut compter plusieurs fois des pages partagées. Consulter README.md pour le protocole, summary.csv pour les minimums/maximums et écarts-types, results.json pour chaque mesure et validation.json pour les contrôles arithmétiques indépendants.
`;
await writeFile(dir+'/analysis.md',text);
