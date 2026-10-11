"""Run final release checks with captured commands, hashes, logs and process cleanup."""
import argparse, hashlib, importlib.util, json, os, pathlib, subprocess, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('checks',pathlib.Path(__file__).with_name('verified-tests-v6.py'))
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
NODE=v.NODE
COMMANDS={**v.COMMANDS,
 'host':[str(NODE),'--test','tests/hosting-release.test.mjs'],
 'release':[str(NODE),'packages/prnext/release/verify.mjs','--local'],
 'build':[str(NODE),'scripts/cargo.mjs','build','--release','--locked'],
 'package':[str(NODE),'scripts/test-package.mjs','--out',str(ROOT/'artifacts/release-0.1.12-alpha/npm')],
 'package-nested':[str(NODE),'scripts/test-package.mjs','--out',str(ROOT/'artifacts/release-0.1.12-alpha/npm'),'--nested'],
 'artifacts':[str(NODE),'scripts/verify-npm-artifacts.mjs','--host','--directory',str(ROOT/'artifacts/release-0.1.12-alpha/npm')],
}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--stage',required=True);p.add_argument('--binary',type=pathlib.Path,default=ROOT/'target/release/prnext.exe');p.add_argument('--package-out',type=pathlib.Path,default=ROOT/'artifacts/release-0.1.12-alpha/npm');p.add_argument('checks',nargs='+',choices=COMMANDS);a=p.parse_args()
 out=ROOT/'artifacts/release-0.1.12-alpha/tests'/a.stage;out.mkdir(parents=True,exist_ok=False)
 binary=a.binary.resolve()
 for name in a.checks:
  command=list(COMMANDS[name]);started=time.time()
  if name in ('package','package-nested'):command[command.index('--out')+1]=str(a.package_out.resolve())
  if name=='artifacts':command[command.index('--directory')+1]=str(a.package_out.resolve())
  env={'PATH':str(NODE.parent)+os.pathsep+os.environ['PATH'],'PRNEXT_BINARY':str(binary),'PRNEXT_NEXT_REFERENCE':str(ROOT/'artifacts/performance/app/node_modules/next'), 'PRNEXT_HOST_RELEASE_REPORT':str(out/(name+'-host-functional.json'))}
  server=v.r.Server(command,str(ROOT),str(out/(name+'.log')),[0,1,2,3,4,5,6,7],env,production=False)
  try:
   code=server.process.wait(timeout=3600);sample=server.sample()
  finally:server.close()
  result={'command':command,'environment':{k:value for k,value in env.items() if k!='PATH'},'node':subprocess.check_output([str(NODE),'--version'],text=True).strip(),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'exitCode':code,'elapsedSeconds':time.time()-started,'afterRootExit':sample}
  (out/(name+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
  print(name,code,flush=True)
  if code:raise SystemExit(code)
