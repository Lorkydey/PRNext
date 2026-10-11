"""Same final binary, varying only the blocking ceiling for balanced SSR.

Separate controlled diagnosis, not substituted for final before/after rows.
Run on released CPU 10 after the main comparison; corrected soak may use CPU 6.
"""
import importlib.util,pathlib,json,time,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
BASE=ROOT/'artifacts/performance-v4';out=BASE/'dynamic-caps';out.mkdir(exist_ok=False)
app=ROOT/'artifacts/performance/app';node=app.parent/'node24/node.exe';binary=BASE/'prnext-v4.exe';url='http://127.0.0.1:32930'
for repeat in range(3):
    for cap in ([4,8,16,512] if repeat%2==0 else [512,16,8,4]):
        name=f'{repeat+1}-cap-{cap}';command=[str(binary),'start',str(app),'--build-dir','.prnext-v4-final','--node',str(node),'--port','32930','--profile','balanced']
        result={'command':command,'cap':cap,'repeat':repeat+1,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'serverCpu':10,'generatorCpus':[8,9],'complete':False}
        server=r.Server(command,str(ROOT),str(out/(name+'.log')),10,{'PRNEXT_BLOCKING_THREADS':str(cap)})
        try:
            for _ in range(100):
                try:r.get(url+'/robots.txt');break
                except Exception:
                    if server.process.poll() is not None:raise RuntimeError('server exited')
                    time.sleep(.1)
            else:raise TimeoutError('startup')
            result['warmup']=r.measured(server,lambda:r.load(str(node),url+'/ssr',10,64))
            result['measure']=r.measured(server,lambda:r.load(str(node),url+'/ssr',30,64));result['measure'].update(p.virtual_memory(server))
            result['measure']['cpuMsPerResponse']=1000*result['measure']['cpuSeconds']/result['measure']['value']['count']
            assert result['warmup']['value']['errors']==result['measure']['value']['errors']==0
            result['complete']=True
        finally:server.close();(out/(name+'.json')).write_text(json.dumps(result,indent=2))
        print(name,round(result['measure']['value']['rps'],1),'req/s',flush=True)
