"""Freshness repeated for the same users/routes, streaming and cancellations."""
import importlib.util,pathlib,json,time,hashlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
BASE=ROOT/'artifacts/performance-v4';out=BASE/'functional-final';out.mkdir(exist_ok=False)
app=ROOT/'artifacts/performance/app';node=app.parent/'node24/node.exe';url='http://127.0.0.1:32920'
for variant,profile in [(v,p) for v in ['v3','candidate'] for p in ['balanced','memory','speed']]+[('next','next')]:
    label=variant+'-'+profile
    if variant=='next':command=[str(node),str(app/'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p','32920']
    else:
        binary=BASE/('reference-v3/prnext-final.exe' if variant=='v3' else 'prnext-v4.exe');build='.prnext-after-v3' if variant=='v3' else '.prnext-v4-final'
        command=[str(binary),'start',str(app),'--build-dir',build,'--node',str(node),'--profile',profile,'--port','32920']
    result={'variant':variant,'profile':profile,'command':command,'binarySha256':hashlib.sha256(pathlib.Path(command[0]).read_bytes()).hexdigest(),'serverCpu':0,'complete':False,'checks':[]}
    server=r.Server(command,str(app),str(out/(label+'.log')),0)
    try:
        for _ in range(200):
            try:r.get(url+'/robots.txt');break
            except Exception:
                if server.process.poll() is not None:raise RuntimeError('server exited')
                time.sleep(.1)
        else:raise TimeoutError('readiness')
        for name in ['validate.mjs','cancellation-storm.mjs']:
            script=ROOT/'tests/performance'/name
            child=subprocess.Popen([str(node),str(script),url],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=0x08000000);r.psutil.Process(child.pid).cpu_affinity([8,9])
            try:stdout,stderr=child.communicate(timeout=120)
            except BaseException:child.kill();child.wait();raise
            row={'script':name,'sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'exitCode':child.returncode,'stdout':stdout.decode(),'stderr':stderr.decode()};result['checks'].append(row)
            assert child.returncode==0,row
        result['complete']=True
    finally:server.close();(out/(label+'.json')).write_text(json.dumps(result,indent=2))
    print(label,'freshness/streaming/cancellation complete',flush=True)
