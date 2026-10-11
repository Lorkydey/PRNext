"""Final isolated controls after the main/follow-up benchmarks, never in parallel."""
import concurrent.futures, importlib.util, json, pathlib, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
started=time.monotonic()
while not (c.OUT/'followup-http/complete.json').exists():
 if time.monotonic()-started>5*3600:raise TimeoutError('Follow-up campaign did not finish')
 time.sleep(5)
out=c.OUT/'extras-http';out.mkdir()
# Two generators give more headroom than the first small-static comparisons.
for repeat in [1,2,3]:
 for variant in (['v5','v6'] if repeat%2 else ['v6','v5']):
  folder=out/f'small-r{repeat}-{variant}';app=c.OUT/'static-app';binary=c.OUT/('reference-v5/prnext.exe' if variant=='v5' else 'candidates/final-http/prnext.exe')
  rows=[{'command':[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port','33700'],'cwd':str(app)}]
  server=c.g.Group(rows,folder,10,512);result={'complete':False,'variant':variant,'repeat':repeat,'commands':rows,'binarySha256':c.sha(binary),'generatorCpus':[[2,3],[4,5]],'results':[]}
  try:
   c.ready(['http://127.0.0.1:33700'])
   def clients(label,seconds):
    def one(i):return c.g.load({'seconds':seconds,'apps':[{'url':'http://127.0.0.1:33700','connections':16,'routes':['pages-static'],'validate':False}]},folder/f'{label}-client{i}',[2+2*i,3+2*i])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(one,range(2)))
   for label,seconds in [('warmup',5),('measure',30)]:result['results'].append({'label':label,**c.g.m.measured(server,lambda:clients(label,seconds),folder/'resources.jsonl')})
   result['complete']=True
  finally:server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
  print(folder.name,'done',flush=True)
# No readiness probe, not even TCP connect: measure 8 initially dormant apps.
for variant in ['v5','v6']:
 for profile in ['balanced','memory','speed']:
  folder=out/f'startup-idle-{variant}-{profile}';commands=c.commands(variant,profile,8,33720,folder)
  server=c.g.Group(commands,folder,10,1024);result={'complete':False,'variant':variant,'profile':profile,'apps':8,'seconds':60,'noReadinessProbes':True,'commands':commands}
  try:
   # Includes actual startup in the first 60 seconds, followed by a settled interval.
   result['startup']=c.g.m.measured(server,lambda:time.sleep(60),folder/'resources.jsonl')
   result['settled']=c.g.m.measured(server,lambda:time.sleep(10),folder/'resources.jsonl')
   assert sum(name.lower()=='node.exe' for _,name in result['settled']['after']['pids'])==0
   assert len(result['settled']['after'].get('servers',[]))==8
   assert all(r['exitCode'] is None for r in result['settled']['after']['servers'])
   result['complete']=True
  finally:server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
  print(folder.name,'done',flush=True)
(out/'complete.json').write_text(json.dumps({'complete':True,'finishedAt':time.time()}),encoding='utf-8')
