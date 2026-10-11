"""Persist commands, pinned Node, artifact hashes, exit codes and leftover children."""
import importlib.util, pathlib, sys, os, json, hashlib, time
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
node=root/'artifacts/performance/node24/node.exe';binary=root/'artifacts/performance-v4/prnext-v4.exe';out=root/'artifacts/performance-v4/tests';out.mkdir(exist_ok=True)
commands={
 'fmt':['cargo','fmt','--all','--','--check'],
 'rust':['cargo','test','-p','prnext','--lib','--','--test-threads=1'],
 'clippy':['cargo','clippy','--workspace','--all-targets','--','-D','warnings'],
 'unit':[str(node),'--test','--test-concurrency=2','packages/prnext/build/*.test.mjs','packages/prnext/runtime/*.test.mjs','packages/prnext/native/*.test.mjs','scripts/npm-metadata.test.mjs'],
 'e2e':[str(node),'--test','--test-concurrency=1','tests/*.test.mjs'],
 'types':[str(node),'node_modules/typescript/bin/tsc','-p','tests/types/tsconfig.json'],
 'types-basic':[str(node),'node_modules/typescript/bin/tsc','-p','examples/basic/tsconfig.json'],
 'types-app':[str(node),'node_modules/typescript/bin/tsc','-p','examples/app/tsconfig.json'],
}
if __name__=='__main__':
    chosen=sys.argv[1:] or list(commands)
    for name in chosen:
        command=commands[name]
        # Node 24 expands test glob arguments itself; absent explicit files are errors.
        server=r.Server(command,str(root),str(out/(name+'.log')),[10,11],{'PATH':str(node.parent)+os.pathsep+os.environ['PATH'],'PRNEXT_BINARY':str(binary)},production=False)
        start=time.time()
        try:
            code=server.process.wait(timeout=3600);accounting=server.sample()
            result={'command':command,'node':str(node),'nodeVersion':'24.19.0','exitCode':code,'elapsedSeconds':time.time()-start,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'accountingAfterRootExit':accounting}
            (out/(name+'.json')).write_text(json.dumps(result,indent=2));print(name,code,flush=True)
        finally:server.close()
