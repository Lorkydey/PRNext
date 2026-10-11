"""Isolated sequential wake measurements; no other campaign may run concurrently."""
import concurrent.futures, importlib.util, json, pathlib, re, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
OUT=c.OUT/'wake-http';OUT.mkdir(exist_ok=False)
for variant in ['v5','v6']:
 for profile in ['balanced','memory','speed']:
  folder=OUT/(variant+'-'+profile);folder.mkdir();app=c.OUT/'apps/app0';port=33340;url=f'http://127.0.0.1:{port}'
  rows=c.commands(variant,profile,1,port,folder,True,1)
  rows[0]['environment']['PRNEXT_INSPECT_DIR']=str(folder/'inspect')
  if profile=='speed':rows[0]['command']+=['--keep-warm','true']
  result={'complete':False,'variant':variant,'profile':profile,'command':rows[0],'serverCpu':6,'clientCpus':[0,1],'instrumented':True,'retirementSeconds':1,'cycles':[],'binarySha256':c.sha(pathlib.Path(rows[0]['command'][0]))}
  server=c.g.r.Server(rows[0]['command'],str(app),str(folder/'server.log'),6,rows[0]['environment'])
  try:
   c.ready([url]);previous=None
   for cycle in range(5):
    first=c.g.r.get(url+'/stream');first.pop('body');time.sleep(2.3)
    before=server.sample();started=time.time();a=c.g.r.get(url+'/stream');b=c.g.r.get(url+'/stream');after=server.sample()
    assert a['status']==b['status']==200 and a['isolation'] and b['isolation'] and a['body']!=b['body']
    for value in [a,b]:value.pop('body')
    node_pids=[pid for pid,name in after['pids'] if name.lower()=='node.exe'];assert len(node_pids)==1
    if previous is not None:assert (node_pids==previous)==(profile=='speed')
    previous=node_pids
    result['cycles'].append({'cycle':cycle+1,'requestStarted':started,'first':a,'second':b,'before':before,'after':after,'wakeCpuSeconds':after['cpuSeconds']-before['cpuSeconds']})
   if profile!='speed':
    time.sleep(2.3)
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:replies=list(pool.map(lambda _:c.g.r.get(url+'/stream'),range(32)))
    assert len(set(x['body'] for x in replies))==32 and all(x['status']==200 and x['isolation'] for x in replies)
    sample=server.sample();assert len([1 for _,name in sample['pids'] if name.lower()=='node.exe'])==1
    result['simultaneousResume']={'count':32,'latenciesMs':[x['latencyMs'] for x in replies],'after':sample}
   result['complete']=True
  finally:
   server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
  print(variant,profile,'wake complete',flush=True)
