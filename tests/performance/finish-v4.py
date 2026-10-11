"""Finish this local campaign in order; never runs against external services."""
import importlib.util,pathlib,json,sys,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
BASE=ROOT/'artifacts/performance-v4'
comparison=r.psutil.Process(int(sys.argv[1]));soak=r.psutil.Process(int(sys.argv[2]))
assert 'tests/performance/windows-compare-v4.py' in comparison.cmdline()
assert 'tests/performance/windows-soak.py' in soak.cmdline()
status={'complete':False,'steps':[],'comparisonPid':comparison.pid,'soakPid':soak.pid}
def save():(BASE/'finish.json').write_text(json.dumps(status,indent=2))
def run(script,*args):
    command=[sys.executable,str(ROOT/'tests/performance'/script),*args]
    start=time.time();done=subprocess.run(command,cwd=ROOT)
    status['steps'].append({'command':command,'exitCode':done.returncode,'start':start,'end':time.time()});save()
    if done.returncode:raise RuntimeError('Campaign stage failed: '+script)
try:
    comparison.wait()
    files=list((BASE/'comparison').glob('*.json'))
    assert len(files)==33 and all(json.loads(f.read_text()).get('complete') is True for f in files),'Comparison incomplete'
    run('windows-functional-v4.py')
    run('static-idle-v4.py')
    run('dynamic-caps-v4.py')
    soak.wait()
    assert json.loads((BASE/'soak/result.json').read_text()).get('complete') is True,'Endurance incomplete'
    run('windows-compare-v4.py','multi')
    run('windows-etw-v4.py')
    status['complete']=True
finally:save()
