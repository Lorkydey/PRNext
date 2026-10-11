import importlib.util, pathlib, json, subprocess, time, hashlib
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
out=root/'artifacts/performance-v4/soak';out.mkdir(exist_ok=True)
binary=root/'artifacts/performance-v4/prnext-v4.exe';node=root/'artifacts/performance/node24/node.exe';app=root/'artifacts/performance/app'
cmd=[str(binary),'start',str(app),'--build-dir','.prnext-v4-final','--node',str(node),'--port','32500','--profile','balanced']
url='http://127.0.0.1:32500'
def mixed(seconds):
    with open(out/(f'load-{seconds}.jsonl'),'wb') as log:
        child=subprocess.Popen([str(node),str(root/'tests/performance/mixed-load.mjs'),url,str(seconds),'64'],stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
        r.psutil.Process(child.pid).cpu_affinity([8,9])
        try:code=child.wait(timeout=seconds+90)
        except BaseException:child.kill();child.wait();raise
    rows=[json.loads(line) for line in (out/f'load-{seconds}.jsonl').read_text().splitlines() if line.startswith('{')]
    return {'exitCode':code,**rows[-1]}
def main():
    if (out/'result.json').exists():raise RuntimeError('Soak result already exists')
    result={'command':cmd,'serverCpu':6,'generatorCpus':[8,9],'seconds':3600,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'mixedLoadSha256':hashlib.sha256((root/'tests/performance/mixed-load.mjs').read_bytes()).hexdigest(),'freshnessValidation':'previous nonce per user and route, bounded to 192 identifiers; cookies on every response','instrumented':True,'complete':False}
    server=r.Server(cmd,str(root),str(out/'server.log'),6,{'PRNEXT_METRICS_FILE':str(out/'metrics.jsonl')})
    try:
        for _ in range(100):
            try:r.get(url+'/robots.txt');break
            except Exception:time.sleep(.1)
        result['warmup']=r.measured(server,lambda:mixed(30))
        (out/'result.json').write_text(json.dumps(result,indent=2))
        result['load']=r.measured(server,lambda:mixed(3600),out/'samples.jsonl')
        result['idleAfter']=r.measured(server,lambda:time.sleep(310),out/'idle-samples.jsonl')
        result['resume']=r.measured(server,lambda:r.get(url+'/stream'));result['resume']['value'].pop('body')
        result['complete']=result['load']['value']['exitCode']==0 and result['warmup']['value']['exitCode']==0
    finally:server.close();(out/'result.json').write_text(json.dumps(result,indent=2))
if __name__=='__main__':main()
