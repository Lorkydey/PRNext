"""Post-campaign diagnostics; wait until the measured campaigns fully finish."""
import concurrent.futures, importlib.util, json, pathlib, statistics, subprocess, sys, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
start=time.monotonic()
while True:
    p=c.OUT/'sequence-http.json'
    try:state=json.loads(p.read_text())
    except (OSError,ValueError):state={}
    if state.get('complete'):break
    if state.get('error') or time.monotonic()-start>4*3600:raise RuntimeError('Preceding sequence did not complete')
    time.sleep(5)
out=c.OUT/'followup-http';out.mkdir()

# Repeat large-file controls with four generators on four distinct physical cores.
for repeat in [1,2,3]:
 for variant in (['v5','v6'] if repeat%2 else ['v6','v5']):
    folder=out/f'large-r{repeat}-{variant}';binary=c.OUT/('reference-v5/prnext.exe' if variant=='v5' else 'candidates/final-http/prnext.exe');app=c.OUT/'static-app'
    commands=[{'command':[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port','33500'],'cwd':str(app)}]
    server=c.g.Group(commands,folder,10,512);url='http://127.0.0.1:33500';result={'complete':False,'variant':variant,'repeat':repeat,'binarySha256':c.sha(binary),'commands':commands,'results':[]}
    try:
      c.ready([url])
      def clients(label,seconds):
        def one(i):return c.g.load({'seconds':seconds,'apps':[{'url':url,'connections':2,'routes':['large-v6.bin'],'validate':False,'encoding':'identity'}]},folder/f'{label}-generator{i}',[2*i+2,2*i+3])
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:return list(pool.map(one,range(4)))
      for label,seconds in [('warmup',5),('measure',20)]:
        result['results'].append({'label':label,**c.g.m.measured(server,lambda:clients(label,seconds),folder/'resources.jsonl')})
      result['complete']=True
    finally:server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(folder.name,'done',flush=True)

# Existing configuration knobs: inspect throughput cost before recommending them.
for repeat in [1,2]:
 for limit in ([4,16,32,64] if repeat==1 else [64,32,16,4]):
    folder=out/f'work-limit-r{repeat}-{limit}';app=c.OUT/'static-app';binary=c.OUT/'candidates/final-http/prnext.exe'
    command=[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port','33500']
    server=c.g.Group([{'command':command,'cwd':str(app),'environment':{'PRNEXT_FILE_WORK_CONCURRENCY':str(limit)}}],folder,10,512)
    result={'complete':False,'limit':limit,'repeat':repeat,'binarySha256':c.sha(binary),'results':[]}
    try:
      c.ready(['http://127.0.0.1:33500'])
      for label,seconds in [('warmup',5),('measure',15)]:
        cfg={'seconds':seconds,'apps':[{'url':'http://127.0.0.1:33500','connections':32,'routes':['pages-static'],'validate':False}]}
        result['results'].append({'label':label,**c.g.m.measured(server,lambda:c.g.load(cfg,folder/label),folder/'resources.jsonl')})
      result['complete']=True
    finally:server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(folder.name,'done',flush=True)

# Repeated intermittent traffic and simultaneous cold resumes on four apps.
for variant in ['v5','v6']:
 for profile in ['balanced','memory','speed']:
    folder=out/f'intermittent-{variant}-{profile}';rows=c.commands(variant,profile,4,33520,folder,True,1)
    if profile=='speed':
      for row in rows:row['command']+=['--keep-warm','true']
    server=c.g.Group(rows,folder,10,1024);urls=[f'http://127.0.0.1:{33520+i}' for i in range(4)]
    result={'complete':False,'variant':variant,'profile':profile,'commands':rows,'retirementSeconds':1,'results':[]}
    def record(label,fn):
      row={'label':label,**c.g.m.measured(server,fn,folder/'resources.jsonl')};result['results'].append(row);return row
    def batch():
      with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:replies=list(pool.map(lambda i:c.g.r.get(urls[i%4]+'/stream'),range(32)))
      assert all(x['status']==200 and x['isolation'] for x in replies);assert len({x['body'] for x in replies})==32
      for x in replies:x.pop('body')
      return replies
    try:
      c.ready(urls);record('initial-simultaneous',batch)
      for cycle in range(3):
        idle=record(f'idle-{cycle}',lambda:time.sleep(2.4))
        nodes=sum(name.lower()=='node.exe' for _,name in idle['after']['pids']);assert nodes==(4 if profile=='speed' else 0),nodes
        record(f'resume-{cycle}',batch)
      record('intermittent-30s',lambda:c.g.load({'seconds':30,'apps':[{'url':url,'connections':1,'intervalMs':1500,'routes':['stream']} for url in urls]},folder/'intermittent'))
      result['complete']=True
    except BaseException as error:result['error']=repr(error)
    finally:result['final']=server.sample();server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(folder.name,result['complete'],flush=True)

for variant in ['v5','v6']:
 for n in [1,4]:
    folder=out/f'burst-{variant}-{n}apps';app=c.OUT/'static-app';binary=c.OUT/('reference-v5/prnext.exe' if variant=='v5' else 'candidates/final-http/prnext.exe')
    commands=[{'command':[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port',str(33560+i)],'cwd':str(app),'environment':{'PRNEXT_METRICS_FILE':str(folder/f'metrics-{i}.jsonl')}} for i in range(n)]
    server=c.g.Group(commands,folder,10,1024 if n==4 else 512);urls=[f'http://127.0.0.1:{33560+i}' for i in range(n)]
    result={'complete':False,'variant':variant,'apps':n,'commands':commands}
    try:
      c.ready(urls)
      def burst():
        command=[str(c.NODE),str(HERE/'static-burst-v6.mjs'),','.join(urls),'512']
        client=c.g.r.Server(command,str(c.ROOT),str(folder/'client.jsonl'),[8,9],production=False)
        try:code=client.process.wait(timeout=30)
        finally:client.close()
        return {'exitCode':code,**json.loads((folder/'client.jsonl').read_text())}
      result['burst']=c.g.m.measured(server,burst,folder/'resources.jsonl');result['recovery']=[c.g.r.get(url+'/payload.txt')['status'] for url in urls]
      time.sleep(2);result['afterRecovery']=server.sample();result['complete']=True
    except BaseException as error:result['error']=repr(error)
    finally:server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(folder.name,result['complete'],flush=True)
(out/'complete.json').write_text(json.dumps({'complete':True,'finishedAt':time.time()}),encoding='utf-8')
