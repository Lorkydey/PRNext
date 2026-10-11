"""Sixty seconds after spawn with NO HTTP or TCP probes, for all profiles."""
import concurrent.futures,importlib.util,pathlib,json,time,hashlib
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/startup-idle';out.mkdir(exist_ok=False)
def run(index,variant,profile):
    binary=root/('artifacts/performance-v4/prnext-v4.exe' if variant=='candidate' else 'artifacts/performance-v4/reference-v3/prnext-final.exe')
    build='.prnext-v4-final' if variant=='candidate' else '.prnext-after-v3';app=root/'artifacts/performance/app';name=variant+'-'+profile
    command=[str(binary),'start',str(app),'--build-dir',build,'--node',str(root/'artifacts/performance/node24/node.exe'),'--profile',profile,'--port',str(32800+index)]
    server=r.Server(command,str(root),str(out/(name+'.log')),10)
    result={'name':name,'command':command,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'cpu':10,'httpRequests':0,'tcpProbes':0,'complete':False}
    try:
        result['observation']=r.measured(server,lambda:time.sleep(60))
        assert server.process.poll() is None
        assert 'PRNext' in (out/(name+'.log')).read_text(encoding='utf-8')
        assert not any(process['name']=='node.exe' for sample in result['observation']['samples'] for process in sample['processDetail'])
        result['complete']=True
    finally:server.close();(out/(name+'.json')).write_text(json.dumps(result,indent=2))
    print(name,'zero-traffic startup complete',flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    jobs=[pool.submit(run,index,variant,profile) for index,(variant,profile) in enumerate((v,p) for v in ['v3','candidate'] for p in ['balanced','memory','speed'])]
    for job in jobs:job.result()
