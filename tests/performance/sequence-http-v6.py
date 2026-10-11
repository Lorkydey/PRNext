"""Validate final Pages overload propagation, then restart final measurements."""
import json,pathlib,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6'
path=OUT/'sequence-http.json';assert not path.exists()
record={'complete':False,'candidate':'final-http','startedAt':time.time(),'steps':[]}
def save():path.write_text(json.dumps(record,indent=2),encoding='utf-8')
def run(label,command):
 start=time.time()
 with (OUT/(label+'.log')).open('xb') as log:
  done=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
 record['steps'].append({'label':label,'command':command,'exitCode':done.returncode,'startedAt':start,'finishedAt':time.time()});save();print(label,done.returncode,flush=True);assert done.returncode==0,label
try:
 run('tests-http',[sys.executable,'tests/performance/verified-tests-v6.py','final-http','final-http','fmt','clippy','rust','e2e','next-oracle'])
 run('functional-http',[sys.executable,str(OUT/'functional-http.py')])
 run('wake-http',[sys.executable,'tests/performance/wake-v6.py'])
 run('static-http',[sys.executable,'tests/performance/static-campaign-v6.py'])
 children=[]
 for label,script in [('soak-http','soak-v6.py'),('matrix-http','matrix-http-v6.py')]:
  log=(OUT/(label+'.log')).open('xb');command=[sys.executable,'tests/performance/'+script];child=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000)
  children.append((label,command,child,log,time.time()));print('started',label,child.pid,flush=True)
 for label,command,child,log,start in children:
  code=child.wait();log.close();record['steps'].append({'label':label,'command':command,'exitCode':code,'startedAt':start,'finishedAt':time.time()});save();print(label,code,flush=True)
 assert all(child.returncode==0 for _,_,child,_,_ in children)
 record['complete']=True
except BaseException as error:record['error']=repr(error);raise
finally:record['finishedAt']=time.time();save()
