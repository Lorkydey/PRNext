"""Wait for the exact candidate checks, then run isolated release measurements."""
import hashlib, json, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/release-0.1.12-alpha'
begin=time.monotonic()
while True:
 files=list((OUT/'tests/final-v2').glob('*.json'))
 for file in files:
  value=json.loads(file.read_text(encoding='utf-8'))
  if value.get('exitCode',0)!=0:raise RuntimeError('Final check failed: '+str(file))
 final=OUT/'tests/final-v2/next-oracle.json'
 if final.exists():
  digest=hashlib.sha256((ROOT/'target/release/prnext.exe').read_bytes()).hexdigest()
  assert json.loads(final.read_text())['binarySha256']==digest
  break
 if time.monotonic()-begin>3600:raise TimeoutError('Final check sequence did not complete')
 time.sleep(3)
record={'complete':False,'binarySha256':digest,'startedAt':time.time(),'steps':[]};path=OUT/'measurement-sequence.json';assert not path.exists()
try:
 for name,command in [
  ('default-profiles',[sys.executable,'tests/performance/release-alpha-pressure.py','defaults','--candidate','target/release/prnext.exe','--prefix','final']),
  ('host',[sys.executable,'tests/performance/release-alpha-host.py']),
 ]:
  with open(OUT/(name+'-campaign.log'),'wb') as log:result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
  record['steps'].append({'name':name,'command':command,'exitCode':result.returncode});path.write_text(json.dumps(record,indent=2))
  print(name,result.returncode,flush=True)
  if result.returncode:raise RuntimeError(name+' failed; see log')
 record['complete']=True
finally:
 record['finishedAt']=time.time();path.write_text(json.dumps(record,indent=2))
