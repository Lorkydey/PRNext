"""Summarize retained raw release measurements without dropping failed trials."""
import hashlib, importlib.util, json, pathlib, statistics
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/release-0.1.12-alpha'
spec=importlib.util.spec_from_file_location('v6',pathlib.Path(__file__).with_name('analyze-v6.py'));v6=importlib.util.module_from_spec(spec);spec.loader.exec_module(v6)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def margin(phase):
 return v6.capacity(phase,[[8,9]])['hostSiblingSumP95'][0]
def classes(samples):
 values={}
 for sample in samples:
  totals={}
  for process in sample.get('processDetail',[]):
   name=process['name'];totals[name]=totals.get(name,0)+process['privateCommitMiB']
  for name,value in totals.items():values.setdefault(name,[]).append(value)
 return {name:{'medianPrivateCommitMiB':statistics.median(v),'maxSampledPrivateCommitMiB':max(v)} for name,v in values.items()}
result={'memory':[],'host':[],'scope':'Windows Job commit, all child CPU including exited processes; sampled RSS sums include shared pages. Native/class peaks need not be simultaneous. Failed runs retained.'}
for file in sorted((OUT/'multi').glob('*/result.json')):
 raw=json.loads(file.read_text());phases=raw.get('results',raw.get('phases',[]));samples=[s for phase in phases for s in phase['samples']]
 row={'path':file.relative_to(OUT).as_posix(),'sha256':digest(file),'complete':raw.get('complete'),'limitEvents':raw['final']['jobMemoryLimitEvents'],'peakJobCommitMiB':raw['final']['peakJobCommitMiB'],'classes':classes(samples),'phases':[]}
 for phase in phases:
  value=phase.get('value');apps=value.get('apps',[]) if isinstance(value,dict) else []
  useful=sum(a['useful'] for a in apps)
  row['phases'].append({'phase':phase['phase'],'rssMiB':phase['rssMedianMiB'],'cpuPercent':phase['cpuPercent'],'cpuMsPerResponse':phase['cpuSeconds']*1000/useful if useful else None,'latencies':[{'p50':a['p50'],'p95':a['p95'],'p99':a['p99']} for a in apps],'generatorCpuPercent':value.get('generatorCpuPercent') if isinstance(value,dict) else None,'hostGeneratorPhysicalCoreP95Percent':margin(phase),'classes':classes(phase['samples']),
    'rps':sum(a['rps'] for a in apps),'useful':sum(a['useful'] for a in apps),'failedRequests':sum(a['started']-a['useful']-a['rejected'] for a in apps),'rejected':sum(a['rejected'] for a in apps),'validationErrors':sum(a['validationErrors'] for a in apps),'statuses':[a['statuses'] for a in apps]})
 metrics=[]
 for m in sorted(file.parent.glob('metrics-*.jsonl')):
  entries=[json.loads(line) for line in m.read_text(encoding='utf-8').splitlines() if line.startswith('{')]
  if entries:metrics.append(entries[-1])
 if metrics:
  row['admissionFinal']={key:{'active':sum((m.get(key) or {}).get('active',0) for m in metrics),'waiting':sum((m.get(key) or {}).get('waiting',0) for m in metrics),'waitingHeaderBytes':sum((m.get(key) or {}).get('waitingHeaderBytes',0) for m in metrics),'maxPeakActivePerApp':max((m.get(key) or {}).get('peakActive',0) for m in metrics),'maxPeakWaitingPerApp':max((m.get(key) or {}).get('peakWaiting',0) for m in metrics),'submitted':sum((m.get(key) or {}).get('submitted',0) for m in metrics),'released':sum((m.get(key) or {}).get('released',0) for m in metrics)} for key in ['fileAdmission','fileWorkAdmission']}
 row['failureRestartLogMessages']=sum(p.read_text(encoding='utf-8',errors='replace').count('restarting render worker after failed request') for p in file.parent.glob('app-*.log'))
 result['memory'].append(row)
for file in sorted([*(OUT/'host').glob('*/result.json'),*(OUT/'host-direct-matched').glob('*/result.json')]):
 raw=json.loads(file.read_text());row={'path':file.relative_to(OUT).as_posix(),'sha256':digest(file),'mode':raw['mode'],'repeat':raw['repeat'],'complete':raw['complete'],'limitEvents':raw['final']['jobMemoryLimitEvents'],'phases':[]}
 for phase in raw['phases']:
  item={key:phase[key] for key in ['phase','cpuPercent','cpuSeconds','rssMedianMiB','rssMaxMiB']};v=phase['value']
  item['hostGeneratorPhysicalCoreP95Percent']=margin(phase)
  if isinstance(v,dict) and 'apps' in v:
   apps=v['apps'];n=sum(a['useful'] for a in apps)
   item.update(rps=sum(a['rps'] for a in apps),useful=n,cpuMsPerResponse=phase['cpuSeconds']*1000/n if n else None,failed=sum(a['started']-a['useful']-a['rejected'] for a in apps),rejected=sum(a['rejected'] for a in apps),latencies=[{'p50':a['p50'],'p95':a['p95'],'p99':a['p99']} for a in apps],generatorCpuPercent=v['generatorCpuPercent'])
  elif isinstance(v,list):item['latencyMs']={'min':min(x['ms'] for x in v),'median':statistics.median(x['ms'] for x in v),'max':max(x['ms'] for x in v)}
  row['phases'].append(item)
 row['final']={key:raw['final'][key] for key in ['rssMiB','processes','threads','totalProcesses']}
 result['host'].append(row)
(OUT/'analysis.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
for row in result['memory']:
 print(row['path'],'limit',row['limitEvents'],'failed',sum(p['failedRequests'] for p in row['phases']),'private',row['classes'].get('prnext.exe'),row['classes'].get('node.exe'))
for row in result['host']:
 print(row['path'],json.dumps(row['phases']))
