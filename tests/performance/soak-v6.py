"""One hour of four independent apps under one 1 GiB commit / one CPU Job."""
import concurrent.futures, importlib.util, json, pathlib, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
out=c.OUT/'soak-http';rows=c.commands('v6','memory',4,33400,out,True)
server=c.g.Group(rows,out,2,1024);urls=[f'http://127.0.0.1:{33400+i}' for i in range(4)]
result={'complete':False,'binarySha256':c.sha(pathlib.Path(rows[0]['command'][0])),'commands':rows,'serverCpu':2,'generatorCpus':[4,5],'jobCommitLimitMiB':1024,'profile':'memory','apps':4,'startedAt':time.time(),'instrumented':True,'results':[]}
def record(label,fn):
    row={'label':label,**c.g.m.measured(server,fn,out/'resources.jsonl')};result['results'].append(row)
    (out/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(label,flush=True);return row
def load(seconds):
    apps=c.targets(urls,'all')
    for i,app in enumerate(apps):
        file=c.OUT/f'apps/app{i}/public/payload.txt'
        app.update(routes=['ssr','stream','api/json','payload.txt'],staticExpected={'payload.txt':{'bytes':file.stat().st_size,'sha256':c.sha(file)}})
    return c.g.load({'seconds':seconds,'apps':apps,'cancellations':True},out/f'load-{seconds}',[4,5])
def validate(row):
    value=row['value'];assert value['exitCode']==0 and value['cancelErrors']==0 and value['cancelStarts']==value['plannedDisconnects']
    assert all(a['started']==a['completed']==a['useful'] and a['errors']==a['rejected']==a['validationErrors']==0 for a in value['apps'])
    assert row['after']['jobMemoryLimitEvents']==0
try:
    c.ready(urls);validate(record('warmup-20s',lambda:load(20)))
    validate(record('mixed-static-dynamic-one-hour',lambda:load(3600)))
    record('idle-40s',lambda:time.sleep(40))
    def resume():
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:replies=list(pool.map(lambda url:c.g.r.get(url+'/stream'),urls))
        assert all(r['status']==200 and r['freshness'] and r['isolation'] for r in replies)
        for r in replies:r.pop('body')
        return replies
    record('simultaneous-resume',resume);result['complete']=True
except BaseException as error:result['error']={'type':type(error).__name__,'message':str(error)};raise
finally:
    result['final']=server.sample();server.close();result['finishedAt']=time.time();(out/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
