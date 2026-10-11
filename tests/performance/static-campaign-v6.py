"""Static throughput controls and separately instrumented bounded overload."""
import importlib.util, json, pathlib, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
OUT=c.OUT/'static-http';OUT.mkdir(exist_ok=False);app=c.OUT/'static-app';url='http://127.0.0.1:33380'
for instrument in [True,False]:
 for repeat in range(1,2 if instrument else 4):
  for variant in (['v5','v6'] if repeat%2 else ['v6','v5']):
   folder=OUT/f'{"overload" if instrument else "measure"}-{repeat}-{variant}'
   binary=c.OUT/('reference-v5/prnext.exe' if variant=='v5' else 'candidates/final-http/prnext.exe')
   command=[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port','33380']
   env={'PRNEXT_METRICS_FILE':str(folder/'metrics.jsonl')} if instrument else {}
   server=c.g.Group([{'command':command,'cwd':str(app),'environment':env}],folder,10,512)
   result={'complete':False,'variant':variant,'repeat':repeat,'instrumented':instrument,'command':command,'binarySha256':c.sha(binary),'results':[]}
   def record(label,route,connections,seconds):
    config={'seconds':seconds,'apps':[{'url':url,'connections':connections,'routes':[route],'validate':False,'encoding':'identity' if route=='large-v6.bin' else 'gzip'}]}
    row={'label':label,'route':route,'connections':connections,**c.g.m.measured(server,lambda:c.g.load(config,folder/label),folder/'resources.jsonl')}
    result['results'].append(row);(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
   try:
    c.ready([url])
    for route in ['pages-static','large-v6.bin']:
     if instrument:
      for connections in [32,128,512,2048]:record(f'{route}-c{connections}',route,connections,5)
     else:
      connections=32 if route=='pages-static' else 8
      record(route+'-warmup',route,connections,5);record(route+'-measure',route,connections,20)
    time.sleep(3);result['afterDrain']=server.sample();result['complete']=True
   except BaseException as error:result['error']=repr(error)
   finally:
    server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
   print(folder.name,result['complete'],flush=True)
