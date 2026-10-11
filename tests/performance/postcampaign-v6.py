"""Wait for isolated loads, then run finite controls and final evidence checks."""
import datetime, hashlib, json, pathlib, subprocess, sys, time

ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6'
sys.path.insert(0,str(ROOT/'artifacts/performance/python'))
import psutil
psutil.Process().cpu_affinity([0,1])
started=time.monotonic()
while True:
    try:state=json.loads((OUT/'pressure-confirm-http.json').read_text())
    except (OSError,ValueError):state={}
    if state.get('complete'):break
    if time.monotonic()-started>3*3600:raise TimeoutError('Pressure confirmation did not complete')
    time.sleep(5)

result={'complete':False,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'steps':[]}
destination=OUT/'postcampaign-http.json';assert not destination.exists()
def save():destination.write_text(json.dumps(result,indent=2),encoding='utf-8')
def run(label,command):
    script=pathlib.Path(command[1]);meta={'command':command,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if script.is_file():meta['scriptSha256']=hashlib.sha256(script.read_bytes()).hexdigest()
    with (OUT/(label+'.log')).open('xb') as log:
        done=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
    meta.update(exitCode=done.returncode,finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat());result['steps'].append(meta);save()
    print(label,done.returncode,flush=True);assert done.returncode==0,label
try:
    run('early-cancel-http',[sys.executable,'tests/performance/early-cancel-v6.py'])
    run('pages-admission-probe-final',[sys.executable,'tests/performance/probe-pages-admission-v6.py','pages-admission-probe-final','final-http'])
    run('analyzer-final-tests',[sys.executable,'tests/performance/test_analyze_v6.py'])
    run('analysis-final',[sys.executable,'tests/performance/analyze-v6.py'])
    run('audit-final',[sys.executable,'tests/performance/audit-v6.py'])
    result['complete']=True
except BaseException as error:
    result['error']=repr(error);raise
finally:
    result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
