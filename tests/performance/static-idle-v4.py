"""Untraced repeated static load / 30s idle / five-response resumption.

Run only after the throughput comparison has released CPU 10. This observes
thread-pool retirement with a warm filesystem cache, never flushes OS caches.
"""
import importlib.util,pathlib,json,time,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
BASE=ROOT/'artifacts/performance-v4';out=BASE/'static-idle';out.mkdir(exist_ok=False)
app=BASE/'static-app';node=ROOT/'artifacts/performance/node24/node.exe';url='http://127.0.0.1:32910'
for repeat in range(3):
    for variant in (['v3','candidate'] if repeat%2==0 else ['candidate','v3']):
        name=f'{repeat+1}-{variant}';binary=BASE/('reference-v3/prnext-final.exe' if variant=='v3' else 'prnext-v4.exe')
        command=[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(node),'--port','32910']
        result={'variant':variant,'repeat':repeat+1,'command':command,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'serverCpu':10,'generatorCpus':[8,9],'complete':False}
        server=r.Server(command,str(ROOT),str(out/(name+'.log')),10)
        try:
            for _ in range(100):
                try:r.get(url+'/robots.txt');break
                except Exception:
                    if server.process.poll() is not None:raise RuntimeError('server exited')
                    time.sleep(.1)
            else:raise TimeoutError('startup')
            result['load']=r.measured(server,lambda:r.load(str(node),url+'/pages-static',10,32));result['load'].update(p.virtual_memory(server))
            result['idle']=r.measured(server,lambda:time.sleep(30));result['idle'].update(p.virtual_memory(server))
            def resume():
                values=[r.get(url+'/pages-static') for _ in range(5)]
                assert all(v['status']==200 for v in values)
                assert len(set(v['body'] for v in values))==1
                for value in values:value.pop('body')
                return values
            result['resume']=r.measured(server,resume)
            assert result['load']['value']['errors']==0
            assert not any(d['name']=='node.exe' for phase in ['load','idle','resume'] for s in result[phase]['samples'] for d in s['processDetail'])
            result['complete']=True
        finally:server.close();(out/(name+'.json')).write_text(json.dumps(result,indent=2))
        print(name,'static retirement complete',flush=True)
