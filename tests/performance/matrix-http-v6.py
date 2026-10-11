"""Final corrected candidate; reuse only completed uncontaminated V5 controls."""
import importlib.util,json,pathlib,time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
path=c.OUT/'multi-campaign-http.json';assert not path.exists()
diagnostics=[json.loads(p.read_text()) for p in c.OUT.glob('pages-admission-probe*/result.json')]
record={'complete':False,'startedAt':time.time(),'candidate':'final-http','binarySha256':c.sha(c.OUT/'candidates/final-http/prnext.exe'),
        'scriptSha256':c.sha(pathlib.Path(__file__)),'campaignScriptSha256':c.sha(HERE/'campaign-v6.py'),'finished':[],
        'reuse':'Only completed V5 reference runs, excluding overlap with diagnostic probes. All candidate runs use the corrected final binary.'}
def save():path.write_text(json.dumps(record,indent=2),encoding='utf-8')
try:
 for repeat in [1,2]:
  for n,budget in [(1,512),(4,1024),(8,2048),(4,512),(8,1024)]:
   for profile in ['balanced','memory','speed','balanced-small']:
    for variant in (['v5','v6'] if repeat==1 else ['v6','v5']):
     pressure=(n,budget) in [(4,512),(8,1024)]
     original=('pressure-' if pressure else '')+f'r{repeat}-{n}apps-{budget}MiB-{profile}-{variant}'
     existing=c.OUT/'multi'/original/'result.json';old=json.loads(existing.read_text()) if existing.exists() else None
     if variant=='v5' and old and old.get('complete') and not any(p['startedAt']<old['finishedAt'] and p['finishedAt']>old['startedAt'] for p in diagnostics):
      record['finished'].append({'label':original,'complete':True,'reused':True});save();continue
     label='http-'+original
     result=c.once(label,variant,profile,n,budget,20,modes=('all',) if pressure else ('all','one','noisy'))
     record['finished'].append({'label':label,'complete':result['complete'],'reused':False});save()
 record.update(complete=True,finishedAt=time.time());save()
except BaseException as error:record['error']=repr(error);save();raise
