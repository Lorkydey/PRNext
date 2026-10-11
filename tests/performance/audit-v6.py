"""Fail closed on changed evidence or incomplete campaigns. Does not run load."""
import argparse, datetime, hashlib, importlib.util, json, os, pathlib, re, sys
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf-8'))
def verify(root, hashes):
 mismatches=[]
 for name,expected in hashes.items():
  p=root/name
  if not p.is_file() or sha(p)!=expected:mismatches.append(name)
 assert not mismatches, (str(root),mismatches)
 return len(hashes)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--partial',action='store_true');args=parser.parse_args()
 if os.name=='nt':
  sys.path.insert(0,str(ROOT/'artifacts/performance/python'));import psutil;psutil.Process().cpu_affinity([0,1])
 record={'complete':False,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'partial':args.partial,
         'linuxExecuted':False,'vpsUsed':False,'published':False,'checks':{}}
 audit_name='audit-progress.json' if args.partial else 'final-audit.json'
 try:
  ref=read(OUT/'reference-v5/reference.json');cand=read(OUT/'candidates/final-http/source.json');prov=read(OUT/'candidate-provenance-http.json')
  record['checks']['frozenV5Sources']=verify(OUT/'reference-v5/source',ref['sourceSha256'])
  record['checks']['frozenCandidateSources']=verify(OUT/'candidates/final-http/source',cand['sourceSha256'])
  record['checks']['liveProductionSources']=verify(ROOT,prov['productionSha256'])
  record['checks']['fixtureFiles']=verify(OUT,read(OUT/'fixtures.json')['files'])
  assert sha(OUT/'reference-v5/prnext.exe')==ref['binarySha256']
  assert sha(OUT/'candidates/final-http/prnext.exe')==sha(ROOT/'target/release/prnext.exe')==cand['binarySha256']==prov['binarySha256']
  record['binarySha256']={'v5':ref['binarySha256'],'v6':cand['binarySha256']}
  for key in ('dynamicBuild','staticBuild'):
   record['checks']['reference'+key]=verify(OUT/'reference-v5'/key,ref[key]['sha256'])
  checks=[]
  for group in ['final-http']:
   for path in (OUT/'tests'/group).glob('*.json'):
    d=read(path);assert d['exitCode']==0 and d['binarySha256']==cand['binarySha256'],str(path);checks.append(path.relative_to(OUT).as_posix())
  assert len(checks)==5,checks
  record['checks']['exactCandidateTests']=checks
  functional=read(OUT/'functional-http/result.json');assert functional['complete'] and functional['binarySha256']==cand['binarySha256']
  record['checks']['functionalControls']=len(functional['checks'])
  # Keep every attempt: execution completion does not imply no pressure errors.
  matrix=read(OUT/'multi-campaign-http.json')
  selected=[]
  for row in matrix['finished']:
   d=read(OUT/'multi'/row['label']/'result.json')
   assert d['profile']!='balanced-size'
   assert d['binarySha256']==record['binarySha256'][d['variant']]
   for p in d['results']:
    for app in p['value']['apps']:
     assert abs(app['rps']-app['within']/p['value']['durationSeconds'])<1e-8
     assert app['useful']<=app['completed']<=app['started']
   selected.append(dict(label=row['label'],complete=d['complete'],failure=d.get('failure'),
                        failedRequestsExcluding503=sum(a['started']-a['useful']-a['rejected'] for p in d['results'] for a in p['value']['apps']),
                        errorEvents=sum(a['errors'] for p in d['results'] for a in p['value']['apps'])))
  record['checks']['matrixAttempts']=selected
  soak=read(OUT/'soak-http/result.json')
  if not args.partial:
   assert matrix['complete'] and len(matrix['finished'])==80
   confirmation=read(OUT/'pressure-confirm-http.json')
   assert confirmation['complete'] and len(confirmation['finished'])==6
   record['checks']['pressureConfirmation']=confirmation['finished']
   for row in confirmation['finished']:
    value=read(OUT/'multi'/row['label']/'result.json')
    assert value['binarySha256']==record['binarySha256'][value['variant']]
   assert read(OUT/'sequence-http.json')['complete']
   assert soak['complete'] and soak['binarySha256']==cand['binarySha256']
   hour=next(r for r in soak['results'] if r['label']=='mixed-static-dynamic-one-hour')
   assert hour['value']['durationSeconds']>=3600 and hour['elapsedSeconds']>=3600
   assert hour['after']['jobMemoryLimitEvents']==0
   for app in hour['value']['apps']:
    assert app['started']==app['completed']==app['useful']
    assert app['errors']==app['validationErrors']==app['rejected']==0
   assert hour['value']['cancelStarts']==hour['value']['plannedDisconnects'] and hour['value']['cancelErrors']==0
   record['checks']['soak']={'seconds':hour['elapsedSeconds'],'useful':sum(x['useful'] for x in hour['value']['apps']),
                           'cancellations':hour['value']['plannedDisconnects'],'cpuSeconds':hour['cpuSeconds']}
   idle=next(r for r in soak['results'] if r['label']=='idle-40s')
   assert not any(name.lower()=='node.exe' for _,name in idle['after']['pids']),idle['after']['pids']
   record['checks']['soak']['nodesAfterIdle']=0
   for folder,expected in [('followup-http',24),('extras-http',12)]:
    assert read(OUT/folder/'complete.json')['complete']
    paths=list((OUT/folder).glob('*/result.json'));assert len(paths)==expected,(folder,len(paths))
    record['checks'][folder]=[{'path':p.relative_to(OUT).as_posix(),'complete':read(p)['complete'],'error':read(p).get('error')} for p in paths]
    assert all(read(p)['complete'] for p in paths),record['checks'][folder]
   trials=[]
   for folder in ['static-http','wake-http','followup-http','extras-http']:
    for path in (OUT/folder).glob('*/result.json'):
     value=read(path);variant=value.get('variant','v6');expected=record['binarySha256'][variant]
     if 'binarySha256' in value:assert value['binarySha256']==expected,str(path)
     else:
      assert value.get('commands'),str(path)
      assert all(sha(pathlib.Path(row['command'][0]))==expected for row in value['commands']),str(path)
     trials.append(path.relative_to(OUT).as_posix())
   record['checks']['trialBinaries']=trials
   drains=[]
   for path in (OUT/'static-http/overload-1-v6').glob('metrics*.jsonl'):
    rows=[json.loads(line) for line in path.read_text().splitlines()]
    assert rows,str(path)
    for row in rows:
     for name in ['fileAdmission','fileWorkAdmission']:
      gate=row.get(name)
      if not gate:continue
      assert gate['peakActive']<=gate['activeLimit'] and gate['peakWaiting']<=gate['waitingLimit'],gate
    for name in ['fileAdmission','fileWorkAdmission']:
     gate=rows[-1][name]
     assert gate['active']==gate['waiting']==gate['waitingHeaderBytes']==0,gate
     assert gate['submitted']==gate['released']+gate['rejected']+gate['timedOut']+gate['cancelledWaits'],gate
    drains.append(path.relative_to(OUT).as_posix())
   assert drains
   record['checks']['staticAdmissionDrained']=drains
   assert read(OUT/'early-cancel-http/result.json')['complete']
   pages=read(OUT/'pages-admission-probe-final/result.json')
   assert pages['complete'] and pages['binarySha256']==cand['binarySha256'] and pages['exitCode']==0
   assert len(pages['replies'])==128 and int(pages['statuses'].get('503',0))>0
   assert all(status in (200,503) and (status!=503 or (retry=='1' and cache=='no-store')) for status,retry,cache in pages['replies'])
   record['checks']['pagesOverloadStatuses']=pages['statuses']
   owned=[]
   for p in psutil.process_iter(['pid','name','cmdline']):
    if p.pid==os.getpid():continue
    if p.info['name'].lower() not in ['node.exe','prnext.exe','python.exe']:continue
    command=' '.join(p.info['cmdline'] or [])
    if 'performance-v6' in command or any(s in command for s in ['soak-v6.py','campaign-v6.py matrix','resume-matrix-v6.py','matrix-http-v6.py','followup-v6.py','extras-v6.py','pressure-confirm-v6.py']):owned.append({'pid':p.pid,'command':command})
   assert not owned,owned
   record['checks']['ownedBenchmarkProcessesRemaining']=owned
   ports={*range(33100,33108),33340,33380,*range(33400,33404),33500,*range(33520,33524),*range(33560,33564),33700,*range(33720,33728),33780,33800}
   listeners=[{'pid':c.pid,'port':c.laddr.port} for c in psutil.net_connections(kind='tcp') if c.status=='LISTEN' and c.laddr.port in ports]
   assert not listeners,listeners
   record['checks']['benchmarkListenersRemaining']=listeners
  record['complete']=not args.partial
 except BaseException as error:
  record['error']=repr(error);raise
 finally:
  (OUT/audit_name).write_text(json.dumps(record,indent=2),encoding='utf-8')
 print(audit_name,record['complete'])
if __name__=='__main__':main()
