"""Verify the frozen Windows candidate before expensive campaigns."""
import importlib.util, pathlib, json, time, hashlib, subprocess
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/preflight';out.mkdir(exist_ok=True)
binary=root/'artifacts/performance-v4/prnext-v4.exe';node=root/'artifacts/performance/node24/node.exe';app=root/'artifacts/performance/app'
cmd=[str(binary),'start',str(app),'--build-dir','.prnext-v4-final','--node',str(node),'--port','32550','--profile','balanced']
result={'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'command':cmd,'complete':False}
old=list(cmd);old[old.index('--build-dir')+1]='.prnext-after-v3'
before=time.perf_counter();rejected=subprocess.run(old,capture_output=True,text=True,timeout=15)
result['actualV3Artifact']={'command':old,'exitCode':rejected.returncode,'stdout':rejected.stdout,'stderr':rejected.stderr,'seconds':time.perf_counter()-before}
assert rejected.returncode!=0 and 'prnext build' in rejected.stderr
server=r.Server(cmd,str(root),str(out/'server.log'),6,{'PRNEXT_METRICS_FILE':str(out/'metrics.jsonl')})
try:
    for _ in range(100):
        try:r.get('http://127.0.0.1:32550/robots.txt');break
        except Exception:time.sleep(.1)
    result['static']=r.measured(server,lambda:r.load(str(node),'http://127.0.0.1:32550/static',10,32))
    result['static'].update(p.virtual_memory(server))
    assert result['static']['value']['errors']==0
    metrics=[json.loads(line) for line in (out/'metrics.jsonl').read_text().splitlines()]
    assert max(m['tokioLiveThreads'] for m in metrics)<=5,metrics[-1]
    result['metricsStatic']=metrics[-1]
    for script in ['validate.mjs','cancellation-storm.mjs']:
        done=subprocess.run([str(node),str(root/'tests/performance'/script),'http://127.0.0.1:32550'],capture_output=True,text=True,timeout=120)
        result[script]={'exitCode':done.returncode,'stdout':done.stdout,'stderr':done.stderr}
        assert done.returncode==0,result[script]
    result['complete']=True
finally:
    result['final']=server.sample();server.close();(out/'result.json').write_text(json.dumps(result,indent=2))
print(json.dumps({key:value for key,value in result.items() if key not in ['static','metricsStatic']}))
