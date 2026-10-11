"""Retain initial default-start controls; add controls matching host's V8 guard."""
import json, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/release-0.1.12-alpha'
started=time.monotonic()
while True:
 try:value=json.loads((OUT/'measurement-sequence.json').read_text())
 except (OSError,ValueError):value={}
 if any(step['exitCode'] for step in value.get('steps',[])):raise RuntimeError('Previous sequence failed')
 if value.get('complete'):break
 if time.monotonic()-started>1800:raise TimeoutError('Previous sequence did not complete')
 time.sleep(2)
command=[sys.executable,'tests/performance/release-alpha-host.py','--output','host-direct-matched','--direct-only']
record={'complete':False,'reason':'Initial direct controls used the memory profile without NODE_OPTIONS. Host applies --max-old-space-size=192 for its 256 MiB per-app reservation. Added two fresh direct controls with exactly that guard; previous runs retained, not used to isolate proxy cost. These controls follow the host trials rather than alternating with them.','command':command,'startedAt':time.time()}
file=OUT/'host-control-correction.json';assert not file.exists();file.write_text(json.dumps(record,indent=2))
with open(OUT/'host-direct-matched.log','wb') as log:result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
record.update(complete=result.returncode==0,exitCode=result.returncode,finishedAt=time.time());file.write_text(json.dumps(record,indent=2))
print('Matched direct controls',result.returncode,flush=True)
raise SystemExit(result.returncode)
