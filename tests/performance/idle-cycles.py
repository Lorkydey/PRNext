"""Three actual 1/5/15 minute rest cycles, with independent Windows Job accounting.
Paired versions share a fixed CPU but their traffic is staggered by 25 seconds.
Other profiles use distinct physical cores. Probe/generator CPU is excluded.
"""
import concurrent.futures, importlib.util, json, pathlib, sys, time, hashlib
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/idle';out.mkdir(parents=True,exist_ok=True)
node=str(root/'artifacts/performance/node24/node.exe');app=root/'artifacts/performance/app'
def campaign(variant,profile,cpu,port):
    if variant=='candidate':time.sleep(25)
    binary=root/('artifacts/performance-v4/prnext-v4.exe' if variant=='candidate' else 'artifacts/performance-v4/reference-v3/prnext-final.exe')
    build='.prnext-v4-final' if variant=='candidate' else '.prnext-after-v3'
    name=variant+'-'+profile;output=out/(name+'.json')
    if output.exists():raise RuntimeError('Refusing to overwrite '+str(output))
    cmd=[str(binary),'start',str(app),'--build-dir',build,'--node',node,'--port',str(port),'--profile',profile]
    url='http://127.0.0.1:'+str(port)
    result={'name':name,'command':cmd,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'cpu':cpu,'generatorCpus':[8,9],'cycles':3,'restSeconds':[60,300,900],'complete':False,'results':[]}
    server=r.Server(cmd,str(root),str(output)+'.log',cpu)
    def record(label,fn):
        row={'label':label,**r.measured(server,fn)};result['results'].append(row);output.write_text(json.dumps(result,indent=2));print(name,label,flush=True)
    try:
        for _ in range(100):
            try:r.get(url+'/robots.txt');break
            except Exception:
                if server.process.poll() is not None:raise RuntimeError('server exited')
                time.sleep(.1)
        result['startup']=server.sample()
        record('startup-no-dynamic-traffic-60s',lambda:time.sleep(60))
        for cycle in range(3):
            for rest in [60,300,900]:
                label=f'cycle-{cycle+1}-rest-{rest}'
                record(label+'-load',lambda:r.load(node,url+'/stream',10,32))
                record(label+'-idle',lambda:time.sleep(rest))
                def resume():
                    values=[r.get(url+'/stream') for _ in range(5)]
                    assert len(set(x['body'] for x in values))==5
                    assert all(x['status']==200 and x['freshness'] and x['isolation'] for x in values)
                    for value in values:value.pop('body')
                    return {'first':values[0],'following':values[1:]}
                record(label+'-resume',resume)
        result['final']=server.sample();result['complete']=True
    finally:server.close();output.write_text(json.dumps(result,indent=2))
if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        tasks=[pool.submit(campaign,variant,profile,cpu,32400+2*index+offset) for index,(profile,cpu) in enumerate([('balanced',0),('memory',2),('speed',4)]) for offset,variant in enumerate(['v3','candidate'])]
        for task in tasks:task.result()
