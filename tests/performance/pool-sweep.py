"""Exploratory sizing, never mixed with final before/after evidence."""
import importlib.util, json, pathlib, sys, time, statistics
root=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'artifacts/performance/python'))
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/exploratory';out.mkdir(parents=True,exist_ok=True)
node=str(root/'artifacts/performance/node24/node.exe');app=root/'artifacts/performance/app'
def main():
    binary=str(pathlib.Path(sys.argv[1]).resolve());rows=[]
    # Reverse the cap order in the second round to avoid monotonic thermal bias.
    for iteration in range(2):
        for cap in ([1,4,8,16,32,64,512] if iteration==0 else [512,64,32,16,8,4,1]):
            name=f'cap-{cap}-round-{iteration}'
            cmd=[binary,'start',str(app),'--build-dir','.prnext-v4','--node',node,'--port','32130']
            server=r.Server(cmd,str(root),str(out/(name+'.log')),2,{'PRNEXT_BLOCKING_THREADS':str(cap)})
            try:
                for _ in range(100):
                    try:r.get('http://127.0.0.1:32130/robots.txt');break
                    except Exception:
                        if server.process.poll() is not None:raise RuntimeError('server exited')
                        time.sleep(.1)
                for route,connections in [('static',8),('static',32),('payload.txt',32),('static',128)]:
                    url='http://127.0.0.1:32130/'+route
                    r.load(node,url,3,connections)
                    row=r.measured(server,lambda:r.load(node,url,10,connections))
                    row.update(p.virtual_memory(server));row.update(cap=cap,iteration=iteration,route=route,connections=connections)
                    row['cpuMsPerResponse']=row['cpuSeconds']*1000/row['value']['count']
                    rows.append(row);(out/'pool-sweep.json').write_text(json.dumps({'binary':binary,'results':rows},indent=2))
                    print(json.dumps({k:row[k] for k in ['cap','iteration','route','connections','cpuMsPerResponse','rssMedianMiB','rustVirtualAllocatedMiB']}|{'rps':row['value']['rps'],'p99':row['value']['p99'],'threads':row['after']['threads']}),flush=True)
            finally:server.close()
if __name__=='__main__':main()
