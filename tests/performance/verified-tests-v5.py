"""Verified final-state checks on a named native candidate; preserve all logs."""
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
NODE=ROOT/'artifacts/performance/node24/node.exe'
COMMANDS={
 'fmt':['cargo','fmt','--all','--','--check'],
 'clippy':['cargo','clippy','--workspace','--all-targets','--','-D','warnings'],
 'rust':['cargo','test','-p','prnext','--lib','--','--test-threads=1'],
 'unit':[str(NODE),'--test','--test-concurrency=2','packages/prnext/build/*.test.mjs','packages/prnext/runtime/*.test.mjs','packages/prnext/native/*.test.mjs','scripts/npm-metadata.test.mjs'],
 'e2e':[str(NODE),'--test','--test-concurrency=1','tests/*.test.mjs'],
 'next-oracle':[str(NODE),'--test','--test-concurrency=1','tests/next-conformance.mjs'],
 'types':[str(NODE),'node_modules/typescript/bin/tsc','-p','tests/types/tsconfig.json'],
 'types-basic':[str(NODE),'node_modules/typescript/bin/tsc','-p','examples/basic/tsconfig.json'],
 'types-app':[str(NODE),'node_modules/typescript/bin/tsc','-p','examples/app/tsconfig.json'],
}
def main():
 name,stage,*selected=sys.argv[1:];out=ROOT/'artifacts/performance-v5/tests'/stage;out.mkdir(parents=True,exist_ok=False)
 binary=ROOT/'artifacts/performance-v5/candidates'/name/'prnext.exe'
 for key in selected or COMMANDS:
  command=COMMANDS[key];started=time.time()
  env={'PATH':str(NODE.parent)+os.pathsep+os.environ['PATH'],'PRNEXT_BINARY':str(binary),'PRNEXT_NEXT_REFERENCE':str(ROOT/'artifacts/performance/app/node_modules/next')}
  cpus=[int(value) for value in os.environ.get('PRNEXT_TEST_CPUS','0,1,2,3,4,5,6,7').split(',')]
  server=r.Server(command,str(ROOT),str(out/(key+'.log')),cpus,env,production=False)
  try:
   code=server.process.wait(timeout=3600);sample=server.sample()
  finally:server.close()
  result={'command':command,'cpus':cpus,'environment':{k:v for k,v in env.items() if k!='PATH'},'nodeVersion':subprocess.check_output([str(NODE),'--version'],text=True).strip(),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'exitCode':code,'elapsedSeconds':time.time()-started,'afterRootExit':sample}
  (out/(key+'.json')).write_text(json.dumps(result,indent=2))
  print(key,code,flush=True)
  if code:raise SystemExit(code)
if __name__=='__main__':main()
