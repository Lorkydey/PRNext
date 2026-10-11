"""Opt-in exploratory probe. Exact release benchmarks run without diagnostic tracing."""
import importlib.util, json, pathlib, sys, time, ctypes as C
root=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'artifacts/performance/python'))
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).with_name('windows-runner.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class Region(C.Structure):
    _fields_=[('base',C.c_void_p),('allocation',C.c_void_p),('protection',C.c_ulong),('partition',C.c_ushort),('size',C.c_size_t),('state',C.c_ulong),('protect',C.c_ulong),('kind',C.c_ulong)]
r.k.VirtualQueryEx.argtypes=[C.c_void_p,C.c_void_p,C.c_void_p,C.c_size_t];r.k.VirtualQueryEx.restype=C.c_size_t
def virtual_memory(server):
    address=reserved=committed=0;region=Region()
    while r.k.VirtualQueryEx(C.c_void_p(int(server.process._handle)),C.c_void_p(address),C.byref(region),C.sizeof(region)):
        if region.state in [0x1000,0x2000]:reserved+=region.size
        if region.state==0x1000:committed+=region.size
        next_address=(region.base or 0)+region.size
        if next_address<=address:break
        address=next_address
    return {'rustVirtualAllocatedMiB':reserved/1048576,'rustVirtualCommittedMiB':committed/1048576}
def main():
    out=root/'artifacts/performance-v4/exploratory';out.mkdir(parents=True,exist_ok=True)
    binary=pathlib.Path(sys.argv[1]).resolve();label=sys.argv[2];trace='--trace' in sys.argv
    results=[]
    for concurrency in [1,8,32,128]:
        name=f'{label}-{concurrency}';env={'PRNEXT_BLOCKING_TRACE':str(out/(name+'.jsonl'))} if trace else {}
        cmd=[str(binary),'start',str(root/'artifacts/performance/app'),'--build-dir','.prnext-after-v3','--node',str(root/'artifacts/performance/node24/node.exe'),'--port','32130','--profile','balanced']
        server=r.Server(cmd,str(root),str(out/(name+'.log')),2,env)
        try:
            for _ in range(200):
                try:r.get('http://127.0.0.1:32130/robots.txt');break
                except Exception:time.sleep(.1)
            r.load(str(root/'artifacts/performance/node24/node.exe'),'http://127.0.0.1:32130/static',5,concurrency)
            row=r.measured(server,lambda:r.load(str(root/'artifacts/performance/node24/node.exe'),'http://127.0.0.1:32130/static',15,concurrency))
            row.update(virtual_memory(server));row['connections']=concurrency;row['label']=label
            row['threadCpu']= [{'id':t.id,'user':t.user_time,'kernel':t.system_time} for t in r.psutil.Process(server.process.pid).threads()]
            row['idle']=r.measured(server,lambda:time.sleep(15));row['resume']=r.get('http://127.0.0.1:32130/static');row['resume'].pop('body')
            results.append(row);(out/(label+'.json')).write_text(json.dumps({'command':cmd,'trace':trace,'results':results},indent=2))
            print(json.dumps({'label':name,'rps':row['value']['rps'],'threads':row['after']['threads'],**virtual_memory(server)}),flush=True)
        finally:server.close()
if __name__=='__main__':main()
