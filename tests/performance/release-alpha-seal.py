"""Freeze the final source/binary and hash release evidence without old changes."""
import ast, datetime, hashlib, json, os, pathlib, shutil, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/release-0.1.12-alpha'
sys.path.insert(0,str(ROOT/'artifacts/performance/python'));import psutil
def sha(file):
 h=hashlib.sha256()
 with open(file,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def read(file):return json.loads(file.read_text(encoding='utf-8-sig'))
v6=ROOT/'artifacts/performance-v6';old=read(v6/'delivery-manifest.json')
for name,item in old['files'].items():assert sha(v6/name)==item['sha256'],('V6 evidence changed',name)
assert sha(ROOT/'artifacts/performance/report.html')=='67ad2a4f4db048b1e3363b2f31748f91b426e1ece6bd7aff29d692d8176312f1'
assert sha(ROOT/'artifacts/performance/report-v5-before-v6.html')=='f22cef47464b200e02136bf4a59fd66941696a2e14b8897533b8ba8c8ef6c427'
binary=sha(ROOT/'target/release/prnext.exe');assert binary==read(OUT/'archive-coherence.json')['binarySha256']
for stage,names in [('final-v2',['host','release','fmt','clippy','rust','unit','types','types-basic','types-app','e2e','next-oracle']),('packages-final',['package','package-nested','artifacts'])]:
 for name in names:
  result=read(OUT/f'tests/{stage}/{name}.json');assert result['exitCode']==0 and result['binarySha256']==binary
assert read(OUT/'measurement-sequence.json')['complete'] and read(OUT/'host-control-correction.json')['complete']
candidate=OUT/'candidate-final';candidate.mkdir(exist_ok=False)
paths=set(p for p in subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=ROOT).decode().split('\0') if p)
source={}
for name in sorted(paths):
 file=ROOT/name
 if file.is_file():
  dest=candidate/'source'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest);source[name]=sha(file)
shutil.copy2(ROOT/'target/release/prnext.exe',candidate/'prnext.exe')
previous=read(v6/'candidate-provenance-http.json')['productionSha256']
differences=[name for name,h in previous.items() if sha(ROOT/name)!=h]
assert set(differences)=={'Cargo.lock','crates/prnext/Cargo.toml','crates/prnext/src/proxy.rs','package-lock.json','package.json','packages/prnext/package.json','packages/prnext/release/verify.mjs'},differences
(candidate/'source.json').write_text(json.dumps({'binarySha256':binary,'sourceSha256':source,'productionDifferencesFromV6':differences,'gitHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'note':'Working tree source, including pre-existing V4/V5/V6 changes; HEAD alone is not the tested source.'},indent=2),encoding='utf-8')
for file in pathlib.Path(__file__).parent.glob('release-alpha-*.py'):ast.parse(file.read_text(encoding='utf-8'),str(file))
remaining=[]
def owned_argument(argument):
 if '\n' in argument or '\r' in argument:return False
 file=pathlib.Path(argument)
 if not file.is_absolute():return False
 if file.resolve().is_relative_to(ROOT):return True
 # Isolated test workers run in task-specific temporary project roots.
 text=file.as_posix().lower()
 return any('/temp/'+prefix in text for prefix in ['prnext-independent-','prnext-host-release-','prnext-npm-isolated-'])
assert owned_argument(str(ROOT/'target/release/prnext.exe'))
assert not owned_argument(str(ROOT.parent/'prnext web/vendor/prnext.exe'))
for process in psutil.process_iter(['pid','name','cmdline']):
 try:
  if process.info['name'].lower() not in ['prnext.exe','node.exe']:continue
  arguments=process.info['cmdline'] or []
  if any(owned_argument(argument) for argument in arguments):remaining.append({'pid':process.pid,'name':process.info['name'],'command':' '.join(arguments)})
 except (psutil.NoSuchProcess,psutil.AccessDenied):pass
assert not remaining,remaining
audit={'complete':True,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'binarySha256':binary,'sourceFiles':len(source),'v6EvidenceFilesVerifiedUnchanged':len(old['files']),'activeV6ReportUnchanged':True,'remainingOwnedServers':remaining,'buildEnvironment':{key:os.environ.get(key) for key in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','NODE_OPTIONS','TOKIO_WORKER_THREADS']},'python':sys.version,'windows':sys.getwindowsversion().build,'cpuCount':psutil.cpu_count(),'physicalCpuCount':psutil.cpu_count(logical=False),'memory':dict(psutil.virtual_memory()._asdict()),'swap':dict(psutil.swap_memory()._asdict()),'swapNote':'Windows psutil swap sin/sout are not paging I/O measurements; no pagefile setting changed.'}
(OUT/'final-audit.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
files={}
for file in sorted(OUT.rglob('*')):
 # Exclude installed dependencies and duplicated app builds, not measurements.
 relative=file.relative_to(OUT)
 if any(part in ['node_modules','.prnext','.prnext-cache','__pycache__'] for part in relative.parts):continue
 if file.is_file() and file.name!='delivery-manifest.json':files[relative.as_posix()]={'bytes':file.stat().st_size,'sha256':sha(file)}
manifest={'complete':True,'recordedAt':audit['recordedAt'],'candidate':binary,'candidateDirectory':'candidate-final','finalPackages':'npm-final','files':files,'externalSourceFiles':{name:sha(ROOT/name) for name in ['RELEASE.md','CHANGELOG.md','README.md','packages/prnext/README.md']}}
(OUT/'delivery-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
for name,item in files.items():assert sha(OUT/name)==item['sha256'],name
print(json.dumps({'complete':True,'sourceFiles':len(source),'evidenceFiles':len(files),'v6EvidenceFilesUnchanged':len(old['files']),'binarySha256':binary,'remainingOwnedServers':remaining}))
