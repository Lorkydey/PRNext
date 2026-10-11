"""Resume V6 after rejecting an invalid experimental NODE_OPTIONS configuration.
Never overwrite raw runs. Existing complete runs for real profiles remain valid.
"""
import importlib.util, json, pathlib, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
path=c.OUT/'multi-campaign-recovered.json';assert not path.exists()
record={'complete':False,'startedAt':time.time(),'scriptSha256':c.sha(pathlib.Path(__file__)),'finished':[],
        'rejectedConfiguration':'balanced-size used a Node-forbidden flag in NODE_OPTIONS; those failures remain raw evidence, excluded from profile comparisons',
        'replacement':'balanced-small: supported --max-semi-space-size=1 override only; not the complete old optimize-for-size policy'}
def save():path.write_text(json.dumps(record,indent=2),encoding='utf-8')
try:
 for repeat in [1,2]:
  for n,budget in [(1,512),(4,1024),(8,2048),(4,512),(8,1024)]:
   for profile in ['balanced','memory','speed','balanced-small']:
    for variant in (['v5','v6'] if repeat==1 else ['v6','v5']):
     pressure=(n,budget) in [(4,512),(8,1024)]
     label=('pressure-' if pressure else '')+f'r{repeat}-{n}apps-{budget}MiB-{profile}-{variant}'
     existing=c.OUT/'multi'/label/'result.json'
     old=json.loads(existing.read_text()) if existing.exists() else None
     if old and old.get('complete'):
      record['finished'].append({'label':label,'complete':True,'reused':True});save();continue
     if existing.parent.exists():label+='-resume'
     result=c.once(label,variant,profile,n,budget,20,modes=('all',) if pressure else ('all','one','noisy'))
     record['finished'].append({'label':label,'complete':result['complete'],'reused':False});save()
 record.update(complete=True,finishedAt=time.time());save()
 # The original orchestrator owns the uninterrupted final-candidate soak.
 while True:
  original=json.loads((c.OUT/'sequence.json').read_text())
  if 'finishedAt' in original:break
  time.sleep(5)
 soak=json.loads((c.OUT/'soak/result.json').read_text());assert soak.get('complete'),soak.get('error')
 recovered={'complete':True,'originalSequence':'sequence.json','originalMatrix':'multi-campaign.json',
            'interruption':'matrix-interruption.json','matrix':'multi-campaign-recovered.json','soak':'soak/result.json',
            'reason':'Original matrix intentionally stopped after invalid experimental configuration; valid completed runs reused; partial runs and supported replacement measured separately.',
            'finishedAt':time.time()}
 (c.OUT/'sequence-recovered.json').write_text(json.dumps(recovered,indent=2),encoding='utf-8')
except BaseException as error:
 record['error']=repr(error);save()
 (c.OUT/'sequence-recovered.json').write_text(json.dumps({'complete':False,'error':repr(error)}),encoding='utf-8');raise
