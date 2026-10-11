"""Finish validation, isolated wake/static probes, then two disjoint CPU campaigns."""
import datetime, hashlib, json, os, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
record={'complete':False,'startedAt':time.time(),'steps':[],'scriptSha256':sha(pathlib.Path(__file__))}
path=OUT/'sequence.json';assert not path.exists()
def save():path.write_text(json.dumps(record,indent=2),encoding='utf-8')
def run(label,command):
    started=time.time()
    with (OUT/(label+'.log')).open('xb') as log:
        child=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
        code=child.wait()
    record['steps'].append({'label':label,'command':command,'startedAt':started,'finishedAt':time.time(),'exitCode':code,'log':label+'.log'});save()
    print(label,code,flush=True);assert code==0,label
try:
    run('targeted-final',[sys.executable,str(ROOT/'artifacts/performance-v6/targeted-final.py')])
    run('functional-fixed',[sys.executable,str(ROOT/'artifacts/performance-v6/functional-fixed.py')])
    run('isolated-wakes',[sys.executable,'tests/performance/wake-v6.py'])
    run('static-campaign',[sys.executable,'tests/performance/static-campaign-v6.py'])
    children=[]
    for label,command in [('soak-campaign',[sys.executable,'tests/performance/soak-v6.py']),('multi-campaign',[sys.executable,'tests/performance/campaign-v6.py','matrix'])]:
        log=(OUT/(label+'.log')).open('xb');child=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
        children.append((label,command,child,log,time.time()));print('started',label,child.pid,flush=True)
    for label,command,child,log,started in children:
        code=child.wait();log.close();record['steps'].append({'label':label,'command':command,'startedAt':started,'finishedAt':time.time(),'exitCode':code});save();print(label,code,flush=True)
    assert all(child.returncode==0 for _,_,child,_,_ in children)
    record['complete']=True
except BaseException as error:record['error']=repr(error);raise
finally:record['finishedAt']=time.time();save()
