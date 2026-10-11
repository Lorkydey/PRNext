"""npm ci in an empty source checkout, including unpublished optional natives."""
import hashlib, json, os, pathlib, shutil, subprocess, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/release-0.1.12-alpha/clean-install'
OUT.mkdir(parents=True,exist_ok=False)
for name in ['package.json','package-lock.json','packages/prnext/package.json','examples/basic/package.json','examples/app/package.json']:
 target=OUT/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
node=ROOT/'artifacts/performance/node24/node.exe'
npm=pathlib.Path(shutil.which('npm.cmd')).parent/'node_modules/npm/bin/npm-cli.js'
command=[str(node),str(npm),'ci','--no-audit','--no-fund']
started=time.time()
with open(OUT/'npm-ci.log','wb') as log:
 result=subprocess.run(command,cwd=OUT,env={**os.environ,'PATH':str(node.parent)+os.pathsep+os.environ['PATH']},stdout=log,stderr=subprocess.STDOUT)
record={'command':command,'exitCode':result.returncode,'seconds':time.time()-started,'node':subprocess.check_output([str(node),'--version'],text=True).strip(),'npm':subprocess.check_output([str(node),str(npm),'--version'],text=True).strip(),'lockSha256':hashlib.sha256((OUT/'package-lock.json').read_bytes()).hexdigest(),'nativeOptionalAbsentExpectedBeforePublication':not (OUT/'node_modules/@thomas.f/prnext-win32-x64-msvc').exists()}
(OUT/'result.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
print(json.dumps(record),flush=True)
raise SystemExit(result.returncode)
