"""Final mixed endurance and repeated real idle cycles. Run on separate cores.

Idle has no HTTP/TCP readiness probe for its first 60 seconds. All accounting
uses one Job Object across worker exit/restart; observer overhead is included.
"""
import argparse, hashlib, importlib.util, json, math, pathlib, re, subprocess, time
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v5'
p=r=None
spec=importlib.util.spec_from_file_location('measurement_v5',pathlib.Path(__file__).with_name('measurement-v5.py'))
measurement=importlib.util.module_from_spec(spec);spec.loader.exec_module(measurement)
NODE=ROOT/'artifacts/performance/node24/node.exe';APP=ROOT/'artifacts/performance/app'

def windows_support():
    global p,r
    if r is None:
        spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
        p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r

def validate_mixed(value,seconds):
    """Reject an undrained/error final record before spending 310s at rest."""
    integer=lambda value:isinstance(value,int) and not isinstance(value,bool) and value>=0
    assert value.get('type')=='final' and value.get('durationSeconds')==seconds, 'Mixed generator final record/duration differs'
    assert value.get('exitCode')==0 and value.get('errors')==value.get('validationErrors')==0, 'Mixed generator failed or returned request/validation errors'
    count=value.get('count')
    assert integer(count) and count>0 and value.get('started')==count, 'Mixed ordinary requests were not fully drained'
    assert value.get('statuses')=={'200':count}, 'Mixed ordinary response statuses differ'
    within=value.get('completedWithinWindow')
    assert integer(within) and within<=count, 'Mixed completion window counter is invalid'
    rps=value.get('rps')
    assert isinstance(rps,(int,float)) and not isinstance(rps,bool) and math.isfinite(rps) and math.isclose(rps,within/seconds,rel_tol=1e-9,abs_tol=1e-9), 'Mixed throughput accounting differs'
    planned=value.get('plannedDisconnects')
    assert integer(planned) and value.get('cancelStarts')==planned, 'Mixed deliberate cancellations were not fully drained'
    assert value.get('cancellationStatuses')==({'200':planned} if planned else {}), 'Mixed cancellation statuses differ'

def cleanup(server,result):
    """Try both accounting and close; retain each named failure independently."""
    errors=[]
    if server is not None:
        for name,operation in [('finalSample',lambda:result.update(final=server.sample())),('serverClose',server.close)]:
            try:operation()
            except BaseException as error:
                result['complete']=False
                result.setdefault('cleanupErrors',[]).append({'stage':name,'type':type(error).__name__,'message':str(error)})
                errors.append(error)
    return errors

def main():
    windows_support()
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['idle','soak']);parser.add_argument('--profile',choices=['balanced','memory','speed'],default='balanced');parser.add_argument('--cpu',type=int,required=True);parser.add_argument('--port',type=int,required=True);args=parser.parse_args()
    out=OUT/('soak' if args.mode=='soak' else 'idle/'+args.profile);out.mkdir(parents=True,exist_ok=False)
    binary=OUT/'prnext-v5.exe';url='http://127.0.0.1:'+str(args.port)
    command=[str(binary),'start',str(APP),'--build-dir','.prnext-v5-final','--node',str(NODE),'--profile',args.profile,'--port',str(args.port)]
    sha=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
    build=APP/'.prnext-v5-final'
    result={'complete':False,'mode':args.mode,'profile':args.profile,'command':command,'cwd':str(APP),'serverCpu':args.cpu,'generatorCpus':[8,9],'binarySha256':sha(binary),'nodeSha256':sha(NODE),'nodeVersion':subprocess.check_output([str(NODE),'--version'],text=True).strip(),'generatorSha256':{name:sha(ROOT/'tests/performance'/name) for name in ['load.mjs','mixed-load.mjs']},'buildSha256':{file.relative_to(build).as_posix():sha(file) for file in sorted(build.rglob('*')) if file.is_file() and not any(x in file.relative_to(build).parts for x in ['cache','.cache'])},'startedAt':time.time(),'instrumented':args.mode=='soak','results':[]}
    result['runnerSha256']={name:sha(ROOT/'tests/performance'/name) for name in ['sustain-v5.py','measurement-v5.py','windows-runner.py','static-probe.py']}
    server=None; failure=None
    (out/'result.json').write_text(json.dumps(result,indent=2))
    def record(label,fn):
        row={'label':label,**measurement.measured(server,fn,out/'samples.jsonl')}
        if isinstance(row['value'],dict) and row['value'].get('count'):row['cpuMsPerResponse']=1000*row['cpuSeconds']/row['value']['count']
        result['results'].append(row);(out/'result.json').write_text(json.dumps(result,indent=2));print(args.mode,args.profile,label,flush=True)
        return row
    def mixed(seconds):
        file=out/f'load-{seconds}.jsonl'
        with file.open('wb') as log:
            child=subprocess.Popen([str(NODE),str(ROOT/'tests/performance/mixed-load.mjs'),url,str(seconds),'64'],stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
            try:
                r.psutil.Process(child.pid).cpu_affinity([8,9])
                code=child.wait(timeout=seconds+90)
            except BaseException:child.kill();child.wait();raise
        rows=[json.loads(line) for line in file.read_text().splitlines() if line.startswith('{')]
        assert rows and rows[-1].get('type')=='final', 'Mixed generator did not write its drained final record'
        return {'exitCode':code,**rows[-1]}
    def load():
        child=subprocess.Popen([str(NODE),str(ROOT/'tests/performance/load.mjs'),url+'/stream','10','32'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=0x08000000)
        try:
            r.psutil.Process(child.pid).cpu_affinity([8,9])
            stdout,stderr=child.communicate(timeout=90)
        except BaseException:
            child.kill();child.wait();raise
        if child.returncode:raise RuntimeError('Generator failed: '+stderr.decode())
        value=json.loads(stdout)
        assert value['errors']==0 and value['started']==value['count'] and value['statuses']=={'200':value['count']}, 'Idle load did not drain successful requests'
        return value
    def resume():
        def request():
            begin=time.time()*1000;value=r.get(url+'/stream');value.update(startedAtUnixMs=begin,finishedAtUnixMs=time.time()*1000)
            return value
        first=request();second=request()
        nonces=[re.search(r'nonce:([0-9a-f-]{36})',value['body']) for value in [first,second]]
        assert all(nonces) and nonces[0].group(1)!=nonces[1].group(1), 'Resume returned a missing or repeated nonce'
        assert first['status']==second['status']==200 and first['freshness'] and second['freshness'] and first['isolation'] and second['isolation']
        for value in [first,second]:value.pop('body')
        return {'first':first,'second':second}
    try:
        server=r.Server(command,str(APP),str(out/'server.log'),args.cpu,{'PRNEXT_METRICS_FILE':str(out/'metrics.jsonl')} if args.mode=='soak' else {})
        result['startup']=server.sample()
        if args.mode=='idle':
            startup=record('startup-zero-http-or-tcp-60s',lambda:time.sleep(60))
            assert server.process.poll() is None
            assert all(name.lower()!='node.exe' for sample in [startup['before'],*startup['samples']] for _,name in sample['pids']), 'Unexpected Node before traffic'
            record('first-dynamic',resume)
            for cycle in range(3):
                for seconds in [60,300,900]:
                    prefix=f'cycle-{cycle+1}-rest-{seconds}'
                    record(prefix+'-load',load)
                    record(prefix+'-idle',lambda:time.sleep(seconds))
                    record(prefix+'-resume',resume)
        else:
            for _ in range(200):
                try:r.get(url+'/robots.txt');break
                except Exception:
                    if server.process.poll() is not None:raise RuntimeError('Server exited')
                    time.sleep(.1)
            else:raise TimeoutError('Server readiness')
            warmup=record('warmup',lambda:mixed(30));validate_mixed(warmup['value'],30)
            row=record('mixed-one-hour',lambda:mixed(3600));validate_mixed(row['value'],3600)
            record('idle-after-soak-310s',lambda:time.sleep(310));record('resume-after-soak',resume)
        assert server.process.poll() is None, 'Server exited before the sustained campaign finished'
        result['complete']=True
    except BaseException as error:
        failure=error
        result['error']={'type':type(error).__name__,'message':str(error)}
        raise
    finally:
        errors=cleanup(server,result)
        result['finishedAt']=time.time();(out/'result.json').write_text(json.dumps(result,indent=2))
        # Preserve an earlier workload/startup exception instead of masking it
        # with a subsequent accounting/close error. Both remain in the JSON.
        if errors and failure is None:raise errors[0]

if __name__=='__main__':main()
