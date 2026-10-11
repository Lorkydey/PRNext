"""Alternating exact v3/candidate comparison; run after verified-tests completes.

CPU 10 is dedicated to the server; generator 8/9. Parallel idle/soak campaigns
use other physical cores and are explicitly recorded as background context.
No traces during throughput; identical candidate build bytes for static.
"""
import importlib.util, pathlib, json, time, hashlib, sys, statistics, concurrent.futures, threading
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
guard_spec=importlib.util.spec_from_file_location('guard',pathlib.Path(__file__).with_name('quiet-machine.py'));guard=importlib.util.module_from_spec(guard_spec);guard_spec.loader.exec_module(guard)
out=root/'artifacts/performance-v4/comparison';out.mkdir(exist_ok=True)
(out/'metadata').mkdir(exist_ok=True);BACKGROUND_EVENTS=[]
node=str(root/'artifacts/performance/node24/node.exe');app=root/'artifacts/performance/app';static=root/'artifacts/performance-v4/static-app'
binaries={'v3':root/'artifacts/performance-v4/reference-v3/prnext-final.exe','candidate':root/'artifacts/performance-v4/prnext-v4.exe'}
class Interference(RuntimeError):pass
def run(label,variant,profile,kind,scenarios,cpu=10,port=32600):
    file=out/(label+'.json')
    if file.exists():raise RuntimeError('Refusing to overwrite '+str(file))
    directory=static if kind=='static' else app
    if variant=='next':cmd=[node,str(app/'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',str(port)]
    else:
        build='.prnext-static' if kind=='static' else ('.prnext-v4-final' if variant=='candidate' or kind=='app-static' else '.prnext-after-v3')
        cmd=[str(binaries[variant]),'start',str(directory),'--build-dir',build,'--node',node,'--port',str(port),'--profile',profile]
    url='http://127.0.0.1:'+str(port)
    result={'label':label,'variant':variant,'profile':profile,'kind':kind,'command':cmd,'sha256':hashlib.sha256(pathlib.Path(cmd[0]).read_bytes()).hexdigest(),'serverCpu':cpu,'generatorCpus':[8,9],'background':'Idle profiles on 0/2/4 and mixed soak on 6; no builds/tests on server core. See timestamps in other campaigns.','complete':False,'results':[]}
    server=r.Server(cmd,str(directory),str(file)+'.log',cpu)
    def record(route,connections,phase,seconds):
        interference=[];stop=threading.Event()
        def watch():
            while not stop.is_set():
                current=guard.builds(r.psutil)
                if current:interference.append({'time':time.time(),'builds':current})
                stop.wait(1)
        observer=threading.Thread(target=watch);observer.start()
        try:row={'route':route,'connections':connections,'phase':phase,**r.measured(server,lambda:r.load(node,url+'/'+route,seconds,connections))}
        finally:stop.set();observer.join()
        row['backgroundInterference']=interference
        row['cpuMsPerResponse']=1000*row['cpuSeconds']/row['value']['count'];row['generatorMayLimit']=row['value']['generatorCpuPercent']>85
        if variant!='next':row.update(p.virtual_memory(server))
        result['results'].append(row);file.write_text(json.dumps(result,indent=2));print(label,route,phase,round(row['value']['rps'],1),flush=True)
        assert row['value']['errors']==0,row['value']
        if interference:raise Interference(label+' overlapped a build; preserve and repeat')
    try:
        for _ in range(300):
            try:r.get(url+'/robots.txt');break
            except Exception:
                if server.process.poll() is not None:raise RuntimeError('server exited')
                time.sleep(.1)
        else:raise TimeoutError('server startup')
        result['startup']=server.sample()
        for route,connections in scenarios:
            record(route,connections,'warmup',10);record(route,connections,'measure',30)
        result['complete']=True
    finally:
        result['final']=server.sample();server.close();file.write_text(json.dumps(result,indent=2))
    return label
def quiet_run(*args,**kwargs):
    while True:
        guard.wait(r.psutil,BACKGROUND_EVENTS)
        (out/'metadata/background-observations.json').write_text(json.dumps(BACKGROUND_EVENTS,indent=2))
        try:return run(*args,**kwargs)
        except Interference:
            label=args[0];archive=out/'intermediate';archive.mkdir(exist_ok=True);stamp=str(time.time_ns())
            # Only files produced by this invocation, inside this output directory.
            for suffix in ['.json','.json.log']:
                file=out/(label+suffix)
                destination=archive/(label+'-'+stamp+suffix)
                assert file.resolve().parent==out.resolve() and destination.resolve().parent==archive.resolve()
                if file.exists():file.rename(destination)
def main():
    groups=sys.argv[1:] or ['static','dynamic']
    guard.wait(r.psutil,BACKGROUND_EVENTS,force=True)
    if 'static' in groups:
        for repeat in range(3):
            for variant in (['v3','candidate'] if repeat%2==0 else ['candidate','v3']):
                quiet_run(f'static-{repeat+1}-{variant}',variant,'balanced','static',[('pages-static',1),('pages-static',8),('pages-static',32),('pages-static',128),('payload.txt',32),('_prnext/assets/control.html',32)])
                quiet_run(f'app-static-{repeat+1}-{variant}',variant,'balanced','app-static',[('static',32)])
    if 'dynamic' in groups:
        order=[('v3','balanced'),('candidate','balanced'),('v3','memory'),('candidate','memory'),('v3','speed'),('candidate','speed'),('next','next')]
        for repeat in range(3):
            for variant,profile in (order if repeat%2==0 else order[::-1]):
                quiet_run(f'dynamic-{repeat+1}-{variant}-{profile}',variant,profile,'dynamic',[('ssr',64),('stream',128),('api/json',64)])
    if 'multi' in groups:
        # Run this group after the long campaigns free CPU 6.
        for repeat in range(3):
            for variant in (['v3','candidate'] if repeat%2==0 else ['candidate','v3']):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    jobs=[pool.submit(run,f'multi-{repeat+1}-{variant}-{index}',variant,'balanced','static',[('pages-static',32)],cpu,32610+index) for index,cpu in enumerate([6,10])]
                    for job in jobs:job.result()
if __name__=='__main__':main()
