"""Windows-only benchmark accounting: Job Object retains CPU of exited children.

Install psutil into an isolated directory and put it on PYTHONPATH. The target
starts suspended, is assigned to a one-CPU job, and only then resumes. Generator
is outside that job, on another physical core. No production services involved.
"""
import argparse, ctypes as C, ctypes.wintypes as W, json, os, pathlib, statistics, subprocess, threading, time, urllib.request
import psutil

k=C.WinDLL('kernel32',use_last_error=True)
class Accounting(C.Structure):
    _fields_=[('user',C.c_longlong),('kernel',C.c_longlong),('period_user',C.c_longlong),('period_kernel',C.c_longlong),('faults',W.DWORD),('total',W.DWORD),('active',W.DWORD),('terminated',W.DWORD)]
class BasicLimits(C.Structure):
    _fields_=[('process_time',C.c_longlong),('job_time',C.c_longlong),('flags',W.DWORD),('min_ws',C.c_size_t),('max_ws',C.c_size_t),('active_limit',W.DWORD),('affinity',C.c_size_t),('priority',W.DWORD),('scheduling',W.DWORD)]
class Io(C.Structure):
    _fields_=[(x,C.c_ulonglong) for x in ['ro','wo','oo','rb','wb','ob']]
class Limits(C.Structure):
    _fields_=[('basic',BasicLimits),('io',Io),('process_memory',C.c_size_t),('job_memory',C.c_size_t),('peak_process',C.c_size_t),('peak_job',C.c_size_t)]
k.CreateJobObjectW.restype=W.HANDLE
k.CreateJobObjectW.argtypes=[C.c_void_p,W.LPCWSTR]
for name,args in [('SetInformationJobObject',[W.HANDLE,C.c_int,C.c_void_p,W.DWORD]),('QueryInformationJobObject',[W.HANDLE,C.c_int,C.c_void_p,W.DWORD,C.c_void_p]),('AssignProcessToJobObject',[W.HANDLE,W.HANDLE]),('TerminateJobObject',[W.HANDLE,W.UINT]),('CloseHandle',[W.HANDLE])]:
    getattr(k,name).argtypes=args;getattr(k,name).restype=W.BOOL
k.OpenThread.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenThread.restype=W.HANDLE
k.ResumeThread.argtypes=[W.HANDLE];k.ResumeThread.restype=W.DWORD
def check(v):
    if not v: raise C.WinError(C.get_last_error())
    return v
class Server:
    def __init__(self,command,cwd,log,cpu=2,environment=None,production=True):
        self.job=check(k.CreateJobObjectW(None,None));limits=Limits();limits.basic.flags=0x2000|0x10;limits.basic.affinity=sum(1<<core for core in cpu) if isinstance(cpu,list) else 1<<cpu
        check(k.SetInformationJobObject(self.job,9,C.byref(limits),C.sizeof(limits)))
        self.log=open(log,'wb');env={**os.environ,'NEXT_TELEMETRY_DISABLED':'1'}
        if production:env.update(NODE_ENV='production',TOKIO_WORKER_THREADS='1')
        env.pop('NODE_OPTIONS',None);env.pop('PRNEXT_PROFILE',None)
        env.update(environment or {})
        self.process=subprocess.Popen(command,cwd=cwd,stdout=self.log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,creationflags=4|0x08000000,env=env)
        try:
            check(k.AssignProcessToJobObject(self.job,W.HANDLE(int(self.process._handle))))
            for t in psutil.Process(self.process.pid).threads():
                h=check(k.OpenThread(2,False,t.id));result=k.ResumeThread(h);k.CloseHandle(h)
                if result==0xffffffff:raise C.WinError(C.get_last_error())
        except BaseException:self.close();raise
    def sample(self):
        a=Accounting();check(k.QueryInformationJobObject(self.job,1,C.byref(a),C.sizeof(a),None))
        buf=C.create_string_buffer(8+8*2048);check(k.QueryInformationJobObject(self.job,3,buf,C.sizeof(buf),None))
        count=C.c_uint32.from_buffer(buf,4).value;pids=(C.c_size_t*count).from_buffer(buf,8)
        rss=threads=private=handles=0;names=[];detail=[]
        for pid in pids:
            try:
                p=psutil.Process(pid);mem=p.memory_info();rss+=mem.rss;private+=mem.vms;threads+=p.num_threads();handles+=p.num_handles();names.append([pid,p.name()])
                detail.append({'pid':pid,'name':p.name(),'rssMiB':mem.rss/1048576,'privateCommitMiB':mem.vms/1048576,'threads':p.num_threads()})
            except (psutil.NoSuchProcess,psutil.AccessDenied):pass
        return {'time':time.time(),'cpuSeconds':(a.user+a.kernel)/1e7,'rssMiB':rss/1048576,'privateCommitMiB':private/1048576,'handles':handles,'processes':len(names),'threads':threads,'totalProcesses':a.total,'pids':names,'processDetail':detail}
    def close(self):
        k.TerminateJobObject(self.job,0);self.process.wait(timeout=10);self.log.close();k.CloseHandle(self.job)
def get(url):
    t=time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept-Encoding':'identity','Cookie':'user=probe'}),timeout=35) as r:body=r.read().decode();status=r.status
    return {'latencyMs':(time.perf_counter()-t)*1000,'status':status,'freshness': 'nonce:' in body or '"nonce"' in body,'isolation':'user:probe' in body or '"user":"probe"' in body,'body':body}
def load(node,url,seconds,connections):
    p=subprocess.Popen([node,str(pathlib.Path(__file__).with_name('load.mjs')),url,str(seconds),str(connections)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=0x08000000)
    psutil.Process(p.pid).cpu_affinity([8,9])
    out,err=p.communicate(timeout=seconds+80)
    if p.returncode:raise RuntimeError(err.decode())
    return json.loads(out)
def measured(server,fn,raw=None):
    samples=[];stop=threading.Event();before=server.sample()
    def monitor():
        while not stop.wait(.5):
            sample=server.sample();samples.append(sample)
            if raw:
                with open(raw,'a',encoding='utf8') as output:output.write(json.dumps(sample)+'\n')
    t=threading.Thread(target=monitor);t.start();start=time.perf_counter()
    try:value=fn()
    finally:stop.set();t.join()
    elapsed=time.perf_counter()-start;after=server.sample();samples.append(after)
    return {'value':value,'elapsedSeconds':elapsed,'cpuSeconds':after['cpuSeconds']-before['cpuSeconds'],'cpuPercent':100*(after['cpuSeconds']-before['cpuSeconds'])/elapsed,'rssMedianMiB':statistics.median(x['rssMiB'] for x in samples),'rssMaxMiB':max(x['rssMiB'] for x in samples),'processesStarted':after['totalProcesses']-before['totalProcesses'],'before':before,'after':after,'samples':samples}
def main():
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--mode',choices=['throughput','idle','endurance'],default='throughput');p.add_argument('--seconds',type=int,default=30);p.add_argument('--repeats',type=int,default=3);p.add_argument('--output',required=True);a=p.parse_args();cfg=json.load(open(a.config));out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
    cpu=cfg.get('idleCpu',0) if a.mode=='idle' else cfg.get('cpu',2)
    server=Server(cfg['command'],cfg['cwd'],str(out)+'.server.log',cpu);result={'config':cfg,'serverCpu':cpu,'mode':a.mode,'results':[]}
    def record(label,fn):
        row={'label':label,**measured(server,fn)}
        if isinstance(row['value'],dict) and row['value'].get('count'):row['cpuMsPerResponse']=row['cpuSeconds']*1000/row['value']['count']
        result['results'].append(row);out.write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in row.items() if k not in ['samples','before','after']}),flush=True)
    try:
        for _ in range(200):
            try:get(cfg['url']+'/robots.txt');break
            except Exception:
                if server.process.poll() is not None:raise RuntimeError('server exited; see log')
                time.sleep(.1)
        else:raise RuntimeError('server did not start')
        result['startup']=server.sample()
        if a.mode=='idle':
            record('startup-no-dynamic-traffic-60s',lambda:time.sleep(60))
            for seconds in [60,300,900]:
                record('load-before-idle-'+str(seconds),lambda:load(cfg['node'],cfg['url']+'/stream',10,32))
                record('idle-'+str(seconds),lambda:time.sleep(seconds))
                def resume():
                    first=get(cfg['url']+'/stream');second=get(cfg['url']+'/stream');assert first['body']!=second['body'];assert first['isolation'] and second['isolation'];first.pop('body');second.pop('body');return {'first':first,'second':second}
                record('resume-after-'+str(seconds),resume)
        else:
            scenarios=cfg.get('scenarios',[['ssr',64],['stream',128],['api/json',64],['static',32],['payload.txt',32]])
            if a.mode=='endurance':scenarios=[['stream',128]]
            for route,connections in scenarios:
                record('warmup-'+route,lambda:load(cfg['node'],cfg['url']+'/'+route,5,connections))
                for n in range(a.repeats):record(route+'-'+str(n+1),lambda:load(cfg['node'],cfg['url']+'/'+route,a.seconds,connections))
        result['final']=server.sample();out.write_text(json.dumps(result,indent=2))
    finally:server.close()
if __name__=='__main__':main()
