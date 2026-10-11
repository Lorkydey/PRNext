"""Diagnostic wake phases and repeated requests on both sides of a 1s deadline.
Run on a free CPU 10 after verification, before throughput comparison.
"""
import importlib.util,pathlib,json,time,subprocess,hashlib,urllib.request,sys
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/wake';out.mkdir(exist_ok=False)
node=root/'artifacts/performance/node24/node.exe';binary=root/'artifacts/performance-v4/prnext-v4.exe';app=root/'artifacts/performance/app';url='http://127.0.0.1:32700'
cpu=int(sys.argv[1]) if len(sys.argv)>1 else 10
def pid():
    with urllib.request.urlopen(url+'/api/json') as response:response.read();return response.headers['x-worker-pid']
for profile in ['balanced','memory','speed']:
    for warm in [False,True]:
        label=profile+('-warm' if warm else '-retire');logs=out/label;logs.mkdir()
        cmd=[str(binary),'start',str(app),'--build-dir','.prnext-v4-final','--node',str(node),'--port','32700','--profile',profile,'--worker-idle-seconds','1','--lane-idle-seconds','1','--keep-warm',str(warm).lower()]
        result={'command':cmd,'cpu':cpu,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'instrumented':True,'complete':False,'results':[]}
        server=r.Server(cmd,str(root),str(logs/'server.log'),cpu,{'PRNEXT_INSPECT_DIR':str(logs/'inspect'),'PRNEXT_METRICS_FILE':str(logs/'metrics.jsonl')})
        try:
            for _ in range(100):
                try:r.get(url+'/robots.txt');break
                except Exception:time.sleep(.1)
            for cycle in range(3):
                for rest in [.9,1.1,2.3]:
                    def probe():
                        previous=r.get(url+'/stream');before_pid=pid()
                        # No foreground process enumeration between the last
                        # response and the next request. It costs tens of ms on
                        # Windows and used to turn a .9s test into a >1s test.
                        quiet_start=time.perf_counter();quiet_wall=time.time();time.sleep(rest)
                        request_wall=time.time();actual_idle=time.perf_counter()-quiet_start
                        values=[r.get(url+'/stream') for _ in range(4)]
                        assert len(set(value['body'] for value in values+[previous]))==5
                        assert all(value['isolation'] and value['freshness'] and value['status']==200 for value in values)
                        for value in values:value.pop('body')
                        return {'beforePid':before_pid,'afterPid':pid(),'quietStarted':quiet_wall,'requestStarted':request_wall,'actualIdleBeforeRequestSeconds':actual_idle,'responses':values}
                    measurement=r.measured(server,probe);observed=measurement.pop('value');before_pid=observed['beforePid'];after_pid=observed['afterPid']
                    if warm:assert before_pid==after_pid,'keepWarm must preserve the host'
                    if not warm and rest==2.3:assert before_pid!=after_pid,'idle host must retire after the deadline and activity heartbeat'
                    if rest==.9 and observed['actualIdleBeforeRequestSeconds']<.95:assert before_pid==after_pid,'a request before the host deadline must retain its host'
                    idle_samples=[s for s in measurement['samples'] if observed['quietStarted']<=s['time']<observed['requestStarted']]
                    result['results'].append({'cycle':cycle+1,'restSeconds':rest,**{key:value for key,value in observed.items() if key!='responses'},'idle':{'after':idle_samples[-1] if idle_samples else measurement['before'],'sampleDuringIdle':bool(idle_samples)},'wake':{'value':observed['responses']},'accountingIncludingPreparationIdleAndAllResponses':measurement})
                    (logs/'result.json').write_text(json.dumps(result,indent=2))
            time.sleep(.2);result['complete']=True
        finally:server.close();(logs/'result.json').write_text(json.dumps(result,indent=2))
        print(label,'complete',flush=True)
