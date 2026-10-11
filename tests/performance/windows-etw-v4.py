"""Short, separately labelled ETW diagnoses, AFTER all untraced measurements.

Requires an elevated Windows session and WPT already installed. Starts/stops
only uniquely named temporary WPR sessions. Does not change tracing registry
settings or system services. ETL contains system metadata and stays local.
"""
import importlib.util,pathlib,json,time,subprocess,os,hashlib
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/etw';out.mkdir(exist_ok=False)
node=str(root/'artifacts/performance/node24/node.exe');url='http://127.0.0.1:32900'
def call(args,label,timeout=120):
    result=subprocess.run(args,capture_output=True,timeout=timeout)
    (out/(label+'.stdout')).write_bytes(result.stdout);(out/(label+'.stderr')).write_bytes(result.stderr)
    if result.returncode:raise RuntimeError((args,result.returncode,result.stderr.decode(errors='replace')))
    return result
for route,connections,variant in [('pages-static',32,'v3'),('pages-static',32,'candidate'),('ssr',64,'v3'),('ssr',64,'candidate')]:
    label=variant if route=='pages-static' else 'ssr-'+variant
    app=root/('artifacts/performance-v4/static-app' if route=='pages-static' else 'artifacts/performance/app')
    build='.prnext-static' if route=='pages-static' else ('.prnext-after-v3' if variant=='v3' else '.prnext-v4-final')
    binary=root/('artifacts/performance-v4/reference-v3/prnext-final.exe' if variant=='v3' else 'artifacts/performance-v4/prnext-v4.exe')
    command=[str(binary),'start',str(app),'--build-dir',build,'--node',node,'--port','32900']
    server=r.Server(command,str(root),str(out/(label+'.server.log')),10);instance='PRNextV4_'+str(os.getpid())+'_'+label;tracing=False
    result={'command':command,'route':route,'connections':connections,'nativePid':server.process.pid,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'traceInstance':instance,'instrumented':True,'complete':False}
    try:
        for _ in range(100):
            try:r.get(url+'/robots.txt');break
            except Exception:time.sleep(.1)
        r.load(node,url+'/'+route,10,connections)
        result['processesBeforeTrace']=server.sample()
        start=['wpr','-start','CPU.light','-start','FileIO.light','-start','Network.light','-filemode','-recordtempto',str(out),'-instancename',instance]
        result['traceStartCommand']=start;call(start,label+'-start');tracing=True
        result['load']=r.measured(server,lambda:r.load(node,url+'/'+route,10,connections))
        call(['wpr','-status','collectors','-details','-instancename',instance],label+'-status')
    finally:
        try:
            if tracing:
                try:call(['wpr','-stop',str(out/(label+'.etl')),'PRNext diagnostic only','-skipPdbGen','-instancename',instance],label+'-stop')
                except BaseException:
                    call(['wpr','-cancel','-instancename',instance],label+'-cancel');raise
        finally:
            server.close();(out/(label+'.json')).write_text(json.dumps(result,indent=2))
    for action,args in [('profile',['-detail']),('diskio',['-summary']),('tracestats',[]),('dumper',[])]:
        call(['xperf','-i',str(out/(label+'.etl')),'-o',str(out/(label+'-'+action+'.csv')),'-a',action,*args],label+'-export-'+action)
    result['complete']=True;(out/(label+'.json')).write_text(json.dumps(result,indent=2));print(label,'ETW complete',flush=True)
