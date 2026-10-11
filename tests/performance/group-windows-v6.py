"""One Windows Job for independent apps: shared CPU and enforced COMMIT limit.
The budget is not a Linux RSS/cgroup limit. The idle Python supervisor is counted.
"""
import ctypes as C, importlib.util, json, os, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'artifacts/performance/python'))
def module(name):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
r=module('windows-runner')
m=module('measurement-v5')
class CompletionPort(C.Structure):
    _fields_=[('key',C.c_void_p),('port',C.c_void_p)]
r.k.CreateIoCompletionPort.argtypes=[C.c_void_p,C.c_void_p,C.c_size_t,C.c_ulong];r.k.CreateIoCompletionPort.restype=C.c_void_p
r.k.GetQueuedCompletionStatus.argtypes=[C.c_void_p,C.POINTER(C.c_ulong),C.POINTER(C.c_size_t),C.POINTER(C.c_void_p),C.c_ulong]
r.k.GetQueuedCompletionStatus.restype=C.c_int

def supervisor(path):
    path=pathlib.Path(path);config=json.loads(path.read_text(encoding='utf-8'));children=[];logs=[]
    while not path.with_suffix('.go').exists():time.sleep(.02)
    try:
        for index, row in enumerate(config['commands']):
            log=open(path.parent/f'app-{index}.log','wb');logs.append(log)
            env={**os.environ,**row.get('environment',{})}
            children.append(subprocess.Popen(row['command'],cwd=row['cwd'],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000))
        previous=None
        while True:
            state=[{'pid':p.pid,'exitCode':p.poll()} for p in children]
            if state!=previous:
                path.with_suffix('.children.json').write_text(json.dumps(state),encoding='utf-8');previous=state
            time.sleep(.2)
    finally:
        for log in logs:log.close()

class Group(r.Server):
    def __init__(self,commands,out,cpu=10,memory_mib=1024):
        self.out=pathlib.Path(out);self.out.mkdir(parents=True,exist_ok=False)
        self.config=self.out/'group.json';self.config.write_text(json.dumps({'commands':commands,'cpu':cpu,'jobCommitLimitMiB':memory_mib},indent=2),encoding='utf-8')
        super().__init__([sys.executable,str(pathlib.Path(__file__).resolve()),'--supervisor',str(self.config)],str(ROOT),str(self.out/'supervisor.log'),cpu)
        self.port=None;self.memory_limit_events=0
        try:
            self.port=r.check(r.k.CreateIoCompletionPort(C.c_void_p(-1),None,0,1))
            port=CompletionPort(1,self.port)
            r.check(r.k.SetInformationJobObject(self.job,7,C.byref(port),C.sizeof(port)))
            limits=r.Limits();r.check(r.k.QueryInformationJobObject(self.job,9,C.byref(limits),C.sizeof(limits),None))
            limits.basic.flags|=0x200;limits.job_memory=memory_mib*1048576
            r.check(r.k.SetInformationJobObject(self.job,9,C.byref(limits),C.sizeof(limits)))
            verify=r.Limits();r.check(r.k.QueryInformationJobObject(self.job,9,C.byref(verify),C.sizeof(verify),None))
            assert verify.job_memory==memory_mib*1048576 and verify.basic.flags&0x200
            self.config.with_suffix('.go').write_text('start',encoding='ascii')
        except BaseException:self.close();raise
    def sample(self):
        value=super().sample();limits=r.Limits();r.check(r.k.QueryInformationJobObject(self.job,9,C.byref(limits),C.sizeof(limits),None))
        while self.port:
            message=C.c_ulong();key=C.c_size_t();pid=C.c_void_p()
            if not r.k.GetQueuedCompletionStatus(self.port,C.byref(message),C.byref(key),C.byref(pid),0):break
            if message.value==10:self.memory_limit_events+=1
        value.update(jobCommitLimitMiB=limits.job_memory/1048576,peakJobCommitMiB=limits.peak_job/1048576,jobMemoryLimitEvents=self.memory_limit_events,
                     hostCpuTimes=[{'user':v.user,'system':v.system,'idle':v.idle} for v in r.psutil.cpu_times(percpu=True)])
        p=self.config.with_suffix('.children.json')
        if p.exists():
            try:value['servers']=json.loads(p.read_text(encoding='utf-8'))
            except ValueError:pass
        return value
    def close(self):
        try:super().close()
        finally:
            if getattr(self,'port',None):r.k.CloseHandle(self.port);self.port=None

def load(config,out,cpus=(8,9)):
    out=pathlib.Path(out);out.with_suffix('.config.json').write_text(json.dumps(config,indent=2),encoding='utf-8')
    command=[str(ROOT/'artifacts/performance/node24/node.exe'),str(ROOT/'tests/performance/multi-load-v6.mjs'),str(out.with_suffix('.config.json'))]
    generator=r.Server(command,str(ROOT),str(out.with_suffix('.jsonl')),list(cpus),production=False)
    try:
        code=generator.process.wait(timeout=config['seconds']+60);sample=generator.sample()
    finally:generator.close()
    rows=[json.loads(line) for line in out.with_suffix('.jsonl').read_text(encoding='utf-8').splitlines() if line.startswith('{')]
    assert rows and rows[-1]['type']=='final','Generator did not drain'
    return {'exitCode':code,'command':command,'generatorJob':sample,**rows[-1]}

if __name__=='__main__' and sys.argv[1]=='--supervisor':supervisor(sys.argv[2])
