// Same unchanged Next sources, isolated production builds, real Chromium interactions.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {inspectSite} from './migration-browser-checks.mjs';
import sharp from 'sharp';
import {repositoryRoot,binary,freePort} from '../tests/support.mjs';
import {benchmarkWorkload,workloadsFor} from './migration-load.mjs';
import {writePerformanceReport} from './migration-performance-report.mjs';

const exec=promisify(execFile),require=createRequire(import.meta.url);
const benchmarkEnabled=process.env.MIGRATION_BENCH==='1';
const reference=process.env.RUSTYX_NEXT_REFERENCE;
assert.ok(reference,'Set RUSTYX_NEXT_REFERENCE to an installed next@16.3.5 directory with react@19.3.0 and react-dom@19.3.0 beside it.');
assert.equal(JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,'16.3.5');
const output=path.resolve(process.env.MIGRATION_REPORT_DIR || path.join(repositoryRoot,'reports/next-migration'));
await mkdir(output,{recursive:true});
for(const dependency of ['react','react-dom'])assert.equal(JSON.parse(await readFile(path.join(path.dirname(reference),dependency,'package.json'),'utf8')).version,'19.3.0');
const report={benchmarkEnabled,benchmarkScriptSha256:createHash('sha256').update(await readFile(new URL('./migration-load.mjs',import.meta.url))).update(await readFile(new URL('./bench-next-comparison.mjs',import.meta.url))).digest('hex'),frameworkSourceSha256:await digest(path.join(repositoryRoot,'packages/rustyx')),binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),runnerSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),date:new Date().toISOString(),versions:{next:'16.3.5',react:'19.3.0',rustyx:JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8')).version},machine:{os:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,node:process.version},method:'Three fictional sites plus an explicitly separate Node-only shop variant, identical sources for both engines; Next production --webpack; one server at a time; Chromium 1280×900. Latency: 10 warmups + 50 sequential GETs, 3 passes with alternating engine order; these latency samples are separate from the optional CPU/load benchmark. RSS: sum of server and descendant RSS after the functional journey, plus two fresh-server home-only readings; shared pages can be counted twice. Rustyx --workers 1; Next default worker configuration. One cold build per engine/site; timings are indicative, not speedup claims.',sites:[]};
const scratch=await mkdtemp(path.join(tmpdir(),'rustyx-site-comparison-'));
const browser=await chromium.launch();
if(benchmarkEnabled)report.method+=' Additional CPU/load benchmark: 3 repetitions, 2s per run, concurrency 4, 200 warmup requests, fresh server per home/mixed scenario; see performance.html for the full method.';
async function files(root){let result=[];for(const entry of await readdir(root,{withFileTypes:true})){if(['node_modules','.next','.rustyx','.rustyx-cache'].includes(entry.name))continue;const file=path.join(root,entry.name);if(entry.isDirectory())result.push(...await files(file));else result.push(file)}return result.sort()}
async function digest(root){const hash=createHash('sha256');for(const file of await files(root)){hash.update(path.relative(root,file));hash.update(await readFile(file))}return hash.digest('hex')}
async function command(args,cwd,log){const start=performance.now();try{const r=await exec(process.execPath,args,{cwd,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production'},maxBuffer:16*1024*1024,timeout:180000});await writeFile(log,r.stdout+r.stderr);return{ok:true,seconds:(performance.now()-start)/1000}}catch(e){await writeFile(log,(e.stdout||'')+(e.stderr||'')+'\n'+e.message);return{ok:false,seconds:(performance.now()-start)/1000,error:e.message.slice(0,1500)}}}
async function server(engine,root){
  const port=await freePort(),url=`http://127.0.0.1:${port}`;
  const child=spawn(engine==='next'?process.execPath:binary,engine==='next'?[path.join(reference,'dist/bin/next'),'start',root,'--port',String(port),'--hostname','127.0.0.1']:['start',root,'--port',String(port),'--hostname','127.0.0.1','--workers','1'],{cwd:root,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
  let log='',error;child.stdout.on('data',data=>{log=(log+data).slice(-2*1024*1024)});child.stderr.on('data',data=>{log=(log+data).slice(-2*1024*1024)});child.on('error',e=>{error=e});
  const close=async()=>{if(child.exitCode!==null||child.signalCode)return;await new Promise(resolve=>{const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timeout);resolve()});child.kill('SIGTERM')})};
  try{for(let i=0;i<300;i++){if(error)throw error;if(child.exitCode!==null)throw new Error(log);try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(1000)});if(r.ok)return{url,child,close,log:()=>log}}catch{}await delay(50)}throw new Error('Server readiness timed out: '+log)}catch(e){await close();throw e}
}
async function rss(pid){const{stdout}=await exec('ps',['-axo','pid=,ppid=,rss=']);const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));const ids=new Set([pid]);for(let i=0;i<rows.length;i++)for(const[id,parent]of rows)if(ids.has(parent))ids.add(id);return rows.filter(([id])=>ids.has(id)).reduce((sum,row)=>sum+row[2],0)/1024}
async function measure(url){for(let i=0;i<10;i++)await(await fetch(url)).arrayBuffer();const values=[];for(let i=0;i<50;i++){const start=performance.now(),r=await fetch(url);assert.equal(r.status,200);await r.arrayBuffer();values.push(performance.now()-start)}values.sort((a,b)=>a-b);return{p50Ms:values[24],p95Ms:values[47],requests:50}}
const inspect=(name,engine,srv)=>inspectSite(name,engine,srv,{browser,output});
async function pixels(name,suffix=''){try{const images=await Promise.all(['next','rustyx'].map(engine=>sharp(path.join(output,`${name}-${engine}${suffix}.png`)).ensureAlpha().raw().toBuffer({resolveWithObject:true})));const[a,b]=images;if(a.info.width!==b.info.width||a.info.height!==b.info.height)return{sameDimensions:false,next:a.info,rustyx:b.info};let changed=0;for(let i=0;i<a.data.length;i+=4)if([0,1,2].some(c=>Math.abs(a.data[i+c]-b.data[i+c])>16))changed++;return{sameDimensions:true,changedPercent:100*changed/(a.info.width*a.info.height),thresholdPerChannel:16}}catch{return{unavailable:true}}}
function escape(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function save(){
  const all=report.sites.flatMap(s=>s.comparisons||[]),passed=all.filter(c=>c.equal).length,blocked=all.filter(c=>c.blocked).length;
  const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const number=value=>Number.isFinite(value)?value.toFixed(2):'—';
  const rows=report.sites.map(s=>{const metric=e=>{const data=s[e];return {journeyRss:number(data?.rssMiB),build:data?.build?.ok?number(data.build.seconds):'BLOQUÉ',latency:number(data?.latency?.length?median(data.latency.map(v=>v.p50Ms)):NaN),rss:number(data?.warmHomeRssMiB?.length?data.warmHomeRssMiB.reduce((a,b)=>a+b,0)/data.warmHomeRssMiB.length:NaN)}};return{name:s.name,next:metric('next'),rustyx:metric('rustyx')}});
  const stats='<h2>Mesures locales indicatives</h2><p>Dans chaque cellule : Next.js / Rustyx. RAM : moyenne des deux relevés après démarrage neuf et échauffement de l’accueil.</p><table><tr><th>Projet</th><th>Build (s)</th><th>Latence p50 (ms)</th><th>RSS accueil (Mio)</th><th>RSS après parcours (Mio)</th></tr>'+rows.map(r=>`<tr><td>${r.name}</td><td>${r.next.build} / ${r.rustyx.build}</td><td>${r.next.latency} / ${r.rustyx.latency}</td><td>${r.next.rss} / ${r.rustyx.rss}</td><td>${r.next.journeyRss} / ${r.rustyx.journeyRss}</td></tr>`).join('')+'</table>';
  const edgeFailure=report.sites.find(s=>s.name==='boutique'&&!s.rustyx?.build?.ok);
  const findings=edgeFailure?'Un blocage reproductible : le CSS global du layout est refusé lorsque la boutique contient une page Edge. Next compile et exécute cette même source. La variante Node passe ; ce contournement est présenté séparément.':'La boutique Edge compile désormais. Voir les vérifications de rendu, actions et cookies ci-dessous.';
  await writeFile(path.join(output,'rapport.md'),`# Comparaison de migration Next.js → Rustyx

Date : ${report.date}. Next ${report.versions.next}, React ${report.versions.react}, Rustyx ${report.versions.rustyx}.

${passed} scénarios identiques, ${blocked} bloqués, ${all.length-passed-blocked} écarts fonctionnels exécutés. Un scénario peut contenir plusieurs assertions.

${findings}

| Projet | Build Next / Rustyx (s) | p50 Next / Rustyx (ms) | RSS accueil Next / Rustyx (Mio) | RSS après parcours Next / Rustyx (Mio) |
|---|---:|---:|---:|---:|
${rows.map(r=>`| ${r.name} | ${r.next.build} / ${r.rustyx.build} | ${r.next.latency} / ${r.rustyx.latency} | ${r.next.rss} / ${r.rustyx.rss} | ${r.next.journeyRss} / ${r.rustyx.journeyRss} |`).join('\n')}

Mesures indicatives : un build à froid par moteur, trois séries de 50 GET après 10 requêtes d’échauffement (médiane des trois p50), deux relevés RSS après démarrage neuf. Le RSS additionne le serveur et ses descendants, peut compter des pages partagées plusieurs fois, et exclut le navigateur. Rustyx utilise un worker ; Next sa configuration par défaut. Un accueil statique Rustyx peut être servi sans démarrer de worker JavaScript ; le relevé après parcours inclut le coût des API et actions exercées. Ce tableau ne mesure ni le CPU ni la saturation et ne démontre pas de gain universel. ${benchmarkEnabled?"La campagne CPU et charge répétée est disponible dans [performance.md](performance.md).":""}

Les captures d’accueil et de modal comparent le rendu stabilisé à 1280×900. Les différences d’encodage PNG/WebP sont conservées dans results.json ; elles ne sont pas automatiquement des erreurs fonctionnelles. Les 404 provoqués par les tests de pages absentes et les requêtes annulées lors de navigations sont conservés dans les diagnostics.

Voir [le rapport visuel](index.html), [les données brutes](results.json) et [les projets reproductibles](../../examples/next-migration/README.md).
`);

  if(benchmarkEnabled)await writePerformanceReport(report,output);
  await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  const sections=report.sites.map(site=>{const rows=site.comparisons||[];return`<section><h2>${escape(site.name)}</h2><p>Sources SHA-256 : <code>${site.sourceSha256}</code></p><table><tr><th>Vérification</th><th>Next.js</th><th>Rustyx</th><th>Comparaison</th></tr>${rows.map(r=>`<tr><td>${escape(r.label)}</td><td>${r.next?'OK':r.blocked?'NON EXÉCUTÉ':'ÉCHEC'}</td><td>${r.rustyx?'OK':r.blocked?'NON EXÉCUTÉ':'ÉCHEC'}</td><td>${r.equal?'Identique':r.blocked?'BLOQUÉ':'ÉCART'}</td></tr>`).join('')}</table><p>Build Next : ${site.next?.build?.seconds?.toFixed(2)} s ; Rustyx : ${site.rustyx?.build?.seconds?.toFixed(2)} s. RSS après parcours : ${site.next?.rssMiB?.toFixed(1)||'—'} / ${site.rustyx?.rssMiB?.toFixed(1)||'—'} Mio.</p><p>Pixels différents sur l’accueil (seuil 16/255) : ${site.visual?.changedPercent?.toFixed(3)??'indisponible'} %.</p><div class="screens"><figure><figcaption>Avant · Next.js</figcaption><a href="${site.name}-next.png"><img src="${site.name}-next.png"></a></figure><figure><figcaption>Après · Rustyx</figcaption>${site.rustyx?.build?.ok?`<a href="${site.name}-rustyx.png"><img src="${site.name}-rustyx.png"></a>`:"<p>Compilation bloquée : aucune capture Rustyx.</p>"}</figure></div>${rows.filter(r=>!r.equal).map(r=>`<pre>${escape(JSON.stringify(r,null,2))}</pre>`).join('')}${['next','rustyx'].filter(e=>site[e]?.error||!site[e]?.build?.ok).map(e=>`<pre>${escape(e+': '+(site[e]?.error||site[e]?.build?.error))}</pre>`).join('')}</section>`}).join('');
  await writeFile(path.join(output,'index.html'),`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Migration Next.js → Rustyx</title><style>body{font:16px system-ui;background:#f2f5f4;color:#20332c;margin:40px auto;max-width:1400px;padding:20px}section{background:white;padding:25px;margin:25px 0;border-radius:16px}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}.screens{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%;border:1px solid #ddd}pre{white-space:pre-wrap;background:#fff1ed;padding:15px}code{overflow-wrap:anywhere}</style><h1>Trois sites Next.js face à Rustyx</h1><p>${escape(report.date)} · Next ${report.versions.next} · Rustyx ${report.versions.rustyx}</p><p>Les mêmes sources sont compilées séparément. Les erreurs restent enregistrées, y compris celles de Next. Les captures et vérifications ciblées ne prouvent pas une compatibilité exhaustive.</p><p><strong>${passed} scénarios identiques · ${blocked} bloqués · ${all.length-passed-blocked} écarts exécutés</strong></p><p>${escape(findings)}</p><p><a href="rapport.md">Synthèse Markdown</a>${benchmarkEnabled?' · <a href="performance.html">RAM, CPU, débit et graphiques</a>':''}</p><p>${escape(report.method)}</p>${stats}${sections}<p><a href="results.json">Résultats bruts, latences, erreurs console et journaux</a></p></html>`);
}
try{
  for(const name of ['boutique','boutique-node','journal','dashboard']){
    const source=path.join(repositoryRoot,'examples/next-migration',name),sourceSha256=await digest(source),site={name,sourceSha256};report.sites.push(site);
    for(const engine of ['next','rustyx']){
      console.log(name,engine,'build');const root=path.join(scratch,name,engine);for(const suffix of ['', '-modal'])await rm(path.join(output,`${name}-${engine}${suffix}.png`),{force:true});await cp(source,root,{recursive:true});await mkdir(path.join(root,'node_modules'),{recursive:true});
      for(const dependency of ['next','react','react-dom'])await symlink(path.join(path.dirname(reference),dependency),path.join(root,'node_modules',dependency),'dir');
      for(const dependency of ['react-server-dom-webpack','scheduler'])await symlink(path.dirname(require.resolve(dependency+'/package.json')),path.join(root,'node_modules',dependency),'dir');
      assert.equal(await digest(root),sourceSha256);
      site[engine]={sourceSha256:await digest(root)};site[engine].build=await command(engine==='next'?[path.join(reference,'dist/bin/next'),'build',root,'--webpack']:[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',root],root,path.join(output,`${name}-${engine}-build.log`));
      if(!site[engine].build.ok){console.error(name,engine,'BUILD FAILED');continue}
      let srv;try{srv=await server(engine,root);Object.assign(site[engine],await inspect(name,engine,srv));site[engine].latency=[await measure(srv.url)];site[engine].rssMiB=await rss(srv.child.pid)}catch(e){site[engine].error=e.stack}finally{if(srv){await srv.close();await writeFile(path.join(output,`${name}-${engine}-server.log`),srv.log())}}
    }
    for(let pass=1;pass<3;pass++)for(const engine of pass%2?['rustyx','next']:['next','rustyx']){if(!site[engine]?.build.ok)continue;let srv;try{srv=await server(engine,path.join(scratch,name,engine));site[engine].latency??=[];site[engine].latency.push(await measure(srv.url));site[engine].warmHomeRssMiB??=[];site[engine].warmHomeRssMiB.push(await rss(srv.child.pid))}catch(e){site[engine].measurementError=e.message}finally{await srv?.close()}}
    if(benchmarkEnabled){
      site.load=[];
      for(let repetition=1;repetition<=3;repetition++)for(const scenario of ['home','mixed'])for(const engine of repetition%2?['next','rustyx']:['rustyx','next']){
        if(!site[engine]?.build.ok)continue;
        const workloads=workloadsFor(name);if(scenario==='home')workloads.splice(1);
        let srv;
        try{
          srv=await server(engine,path.join(scratch,name,engine));
          const row={engine,scenario,repetition,workloads,...await benchmarkWorkload(srv,workloads)};site.load.push(row);
          console.log('LOAD',name,engine,scenario,repetition,Math.round(row.requestsPerSecond)+' req/s',row.loadMedianRssMiB.toFixed(1)+' MiB',row.cpuMsPerRequest?.toFixed(3)+' CPU ms/req',row.errors+' errors');
        }catch(error){site.loadErrors??=[];site.loadErrors.push({engine,scenario,repetition,error:error.stack});console.error('LOAD FAILED',name,engine,error.message)}
        finally{await srv?.close()}
        await save();
      }
    }
    const labels=new Set(['next','rustyx'].flatMap(e=>(site[e]?.checks||[]).map(c=>c.label)));site.comparisons=[...labels].map(label=>{const before=site.next?.checks?.find(c=>c.label===label),after=site.rustyx?.checks?.find(c=>c.label===label);let equal=false;try{assert.ok(before?.ok&&after?.ok);assert.deepEqual(after.value,before.value);equal=true}catch{}return{label,next:before?.ok===true,rustyx:after?.ok===true,blocked:!before||!after,equal,...equal?{}:{before,after}}});
    site.visual=await pixels(name);if(name==='dashboard')site.modalVisual=await pixels(name,'-modal');
    assert.equal(await digest(source),sourceSha256,'Source project was unexpectedly modified');await save();
    console.log(name,site.comparisons.filter(c=>c.equal).length+'/'+site.comparisons.length,'checks equal');
  }
}finally{await browser.close();await rm(scratch,{recursive:true,force:true});await save()}
console.log('Report:',path.join(output,'index.html'));
if(report.sites.some(s=>!s.next?.build.ok||!s.rustyx?.build.ok||s.next?.error||s.rustyx?.error||s.loadErrors?.length||s.load?.some(r=>r.errors||!r.cpuValid)||s.comparisons?.some(c=>!c.equal)))process.exitCode=1;
