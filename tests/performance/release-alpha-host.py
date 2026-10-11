"""Real host/direct comparison on one CPU, with the V6 application bytes.

This measures the gateway plus all children in the same Windows Job. Per-app
RSS reservations are host policy, the outer 1 GiB commit cap is enforced by OS.
"""
import argparse, concurrent.futures, hashlib, importlib.util, json, pathlib, shutil, subprocess, time, urllib.request, urllib.error
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
parser=argparse.ArgumentParser();parser.add_argument('--output',default='host');parser.add_argument('--direct-only',action='store_true');args=parser.parse_args()
ROOT=c.ROOT;OUT=ROOT/'artifacts/release-0.1.12-alpha'/args.output;BINARY=ROOT/'target/release/prnext.exe'
OUT.mkdir(parents=True,exist_ok=False);c.g.r.psutil.Process().cpu_affinity([0,1])
apps=[]
for i in range(4):
 source=c.OUT/f'apps/app{i}';dest=OUT/f'app{i}';dest.mkdir()
 shutil.copytree(source/'.prnext-v5',dest/'.prnext');shutil.copytree(source/'public',dest/'public')
 for name in ['package.json','next.config.mjs']:shutil.copy2(source/name,dest/name)
 subprocess.run([str(c.NODE),'-e','require("fs").symlinkSync(process.argv[1],process.argv[2],"junction")',str(source/'node_modules'),str(dest/'node_modules')],check=True)
 apps.append(dest)
# Preserve the historical generator. Only add an explicit HTTP Host header;
# validation, routing mix, freshness checks, drains and latency buckets match.
original=(HERE/'multi-load-v6.mjs').read_text(encoding='utf-8')
needle="headers:{'accept-encoding':app.encoding||'gzip',cookie:'user='+user}"
assert original.count(needle)==1
generator=OUT/'host-load.mjs';generator.write_text(original.replace(needle,"headers:{'accept-encoding':app.encoding||'gzip',cookie:'user='+user,...(app.host?{host:app.host}:{})}"),encoding='utf-8')

def load(config,out):
 configfile=out.with_suffix('.config.json');configfile.write_text(json.dumps(config),encoding='utf-8')
 command=[str(c.NODE),str(generator),str(configfile)]
 client=c.g.r.Server(command,str(ROOT),str(out.with_suffix('.jsonl')),[8,9],production=False)
 try:
  code=client.process.wait(timeout=config['seconds']+60);sample=client.sample()
 finally:client.close()
 rows=[json.loads(line) for line in out.with_suffix('.jsonl').read_text(encoding='utf-8').splitlines() if line.startswith('{')]
 assert rows[-1]['type']=='final'
 return {'exitCode':code,'generatorJob':sample,**rows[-1]}

def request(i, route='/ssr', hosted=True):
 start=time.perf_counter();user=f'probe{i}'
 req=urllib.request.Request(f'http://127.0.0.1:{33160 if hosted else 33160+i%4}{route}',headers={'Host':f'app{i%4}.localhost','Cookie':'user='+user,'Accept-Encoding':'identity'})
 with urllib.request.urlopen(req,timeout=25) as response:
  body=response.read().decode();assert response.status==200;assert 'user:'+user+'<' in body
 return {'app':i%4,'ms':(time.perf_counter()-start)*1000}

for repeat in [1,2]:
 for mode in (['direct'] if args.direct_only else ['direct','host'] if repeat==1 else ['host','direct']):
  folder=OUT/f'r{repeat}-{mode}'
  config=OUT/f'r{repeat}-{mode}.json'
  config.write_text(json.dumps({'port':33160,'memoryMb':1024,'apps':[{'name':f'app{i}','root':str(app),'hosts':[f'app{i}.localhost'],'memoryMb':256,'idleSeconds':3,'env':{'TOKIO_WORKER_THREADS':'1'}} for i,app in enumerate(apps)]}),encoding='utf-8')
  rows=([{'command':[str(BINARY),'host',str(config),'--node',str(c.NODE)],'cwd':str(ROOT)}] if mode=='host' else [{'command':[str(BINARY),'start',str(app),'--profile','memory','--node',str(c.NODE),'--port',str(33160+i)],'cwd':str(app),'environment':{'NODE_OPTIONS':'--max-old-space-size=192'}} for i,app in enumerate(apps)])
  server=c.g.Group(rows,folder,10,1024);result={'complete':False,'mode':mode,'repeat':repeat,'commands':rows,'binarySha256':c.sha(BINARY),'generatorSha256':c.sha(generator),'phases':[]}
  def record(label,fn):
   value={'phase':label,**c.g.m.measured(server,fn,folder/'resources.jsonl')};result['phases'].append(value);return value
  try:
   if mode=='host':
    for _ in range(150):
     if (folder/'app-0.log').exists() and 'http://127.0.0.1:33160' in (folder/'app-0.log').read_text(encoding='utf-8',errors='replace'):break
     time.sleep(.1)
    else:raise TimeoutError('host readiness')
   else:c.ready([f'http://127.0.0.1:{33160+i}' for i in range(4)])
   if mode=='host':record('startup-without-http',lambda:time.sleep(5))
   targets=[{'url':f'http://127.0.0.1:{33160 if mode=="host" else 33160+i}','connections':8,**({'host':f'app{i}.localhost'} if mode=='host' else {})} for i in range(4)]
   for label,seconds in [('warmup',5),('mixed',30)]:
    record(label,lambda:load({'seconds':seconds,'apps':targets},folder/label))
   if mode=='host':
    for cycle in range(3):
     record(f'idle-{cycle}',lambda:time.sleep(6))
     state=json.loads(config.with_suffix('.status.json').read_text());assert all(app['pid'] is None for app in state['apps'])
     result.setdefault('beforeWakes',[]).append(state)
     def burst():
      with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:return list(pool.map(request,range(32)))
     record(f'wake-{cycle}',burst)
     time.sleep(1.1)
     after=json.loads(config.with_suffix('.status.json').read_text())
     assert all(app['starts']==state['apps'][i]['starts']+1 for i,app in enumerate(after['apps']))
     result.setdefault('afterWakes',[]).append(after)
    record('retire-to-idle',lambda:time.sleep(6))
    sleeping=json.loads(config.with_suffix('.status.json').read_text());assert all(a['pid'] is None for a in sleeping['apps'])
    record('settled-idle',lambda:time.sleep(10))
    result['finalHostState']=json.loads(config.with_suffix('.status.json').read_text())
   result['complete']=True
  except BaseException as error:
   result['failure']={'type':type(error).__name__,'message':str(error)}
   raise
  finally:
   result['final']=server.sample();server.close()
   (folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
  print(folder.name,'complete',flush=True)
