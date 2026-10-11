"""Three extra alternating pairs for the marginal balanced-small 8-app budget.

These are explicitly a follow-up, not replacements for the original 80 runs.
"""
import importlib.util,json,pathlib,time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
started=time.monotonic()
while True:
 try:state=json.loads((c.OUT/'extras-http/complete.json').read_text())
 except (OSError,ValueError):state={}
 if state.get('complete'):break
 if time.monotonic()-started>3*3600:raise TimeoutError('Extras did not finish')
 time.sleep(5)
path=c.OUT/'pressure-confirm-http.json';assert not path.exists()
record={'complete':False,'startedAt':time.time(),'reason':'Original V6 balanced-small 8/1024 had an allocation-limit event in one of two runs; V5 passed both. Additional pairs retain those original results.','finished':[]}
def save():path.write_text(json.dumps(record,indent=2),encoding='utf-8')
try:
 for repeat in [1,2,3]:
  for variant in (['v5','v6'] if repeat%2 else ['v6','v5']):
   label=f'confirm-r{repeat}-8apps-1024MiB-balanced-small-{variant}'
   result=c.once(label,variant,'balanced-small',8,1024,20,modes=('all',))
   record['finished'].append({'label':label,'complete':result['complete']});save()
 record['complete']=True
finally:
 record['finishedAt']=time.time();save()
