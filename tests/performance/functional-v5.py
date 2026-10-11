"""Exact-wire static controls and dynamic freshness/cookies/stream/cancellation.

Usage: functional-v5.py BINARY BUILD_DIRECTORY OUTPUT_LABEL
All server and client commands, hashes, exit codes and logs are retained.
"""
import hashlib, importlib.util, json, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parents[2];BASE=ROOT/'artifacts/performance-v5'
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
NODE=ROOT/'artifacts/performance/node24/node.exe';APP=ROOT/'artifacts/performance/app'
def sha(file):return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()
def build_hashes(command):
    project=pathlib.Path(command[command.index('start')+1]);build=project/command[command.index('--build-dir')+1]
    return {file.relative_to(build).as_posix():sha(file) for file in sorted(build.rglob('*')) if file.is_file() and not any(x in file.relative_to(build).parts for x in ['cache','.cache'])}
def main():
    binary=pathlib.Path(sys.argv[1]).resolve();build=sys.argv[2];out=BASE/sys.argv[3];out.mkdir(parents=True,exist_ok=False)
    result={'complete':False,'binarySha256':sha(binary),'nodeSha256':sha(NODE),'nodeVersion':subprocess.check_output([str(NODE),'--version'],text=True).strip(),'checks':[]};url='http://127.0.0.1:32940'
    def client(name,arguments,server_command):
        script=ROOT/'tests/performance'/name;command=[str(NODE),str(script),*map(str,arguments)]
        script_hash=sha(script);inputs=build_hashes(server_command)
        child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=0x08000000)
        try:
            r.psutil.Process(child.pid).cpu_affinity([8,9])
            stdout,stderr=child.communicate(timeout=120)
        except BaseException:child.kill();child.wait();raise
        row={'script':name,'scriptSha256':script_hash,'command':command,'serverCommand':server_command,'buildSha256':inputs,'inputsUnchanged':script_hash==sha(script) and inputs==build_hashes(server_command) and result['binarySha256']==sha(binary),'exitCode':child.returncode,'stdout':stdout.decode(),'stderr':stderr.decode()};result['checks'].append(row)
        (out/'result.json').write_text(json.dumps(result,indent=2));assert child.returncode==0 and row['inputsUnchanged'],row
    def start(project,build,profile,label):
        command=[str(binary),'start',str(project),'--build-dir',build,'--node',str(NODE),'--profile',profile,'--port','32940']
        server=r.Server(command,str(project),str(out/(label+'.log')),4)
        try:
            for _ in range(200):
                try:r.get(url+'/robots.txt');return server,command
                except Exception:
                    if server.process.poll() is not None:raise RuntimeError('Server exited')
                    time.sleep(.1)
            raise TimeoutError('readiness')
        except BaseException:server.close();raise
    try:
        for profile in ['balanced','memory','speed']:
            server,command=start(APP,build,profile,'dynamic-'+profile)
            try:
                for name in ['validate.mjs','cancellation-storm.mjs']:client(name,[url],command)
                assert server.process.poll() is None, 'Dynamic server exited unexpectedly'
                result.setdefault('serverFinal',[]).append(server.sample())
            finally:server.close()
        project=ROOT/'artifacts/performance-v4/static-app';dist=project/'.prnext-static'
        manifest=json.loads((dist/'manifest.json').read_text());page=next(x for x in manifest['prerendered'] if x['path']=='/pages-static');html=dist/page['file']
        controls=[('pages-static',html,str(html)+'.gz'),('payload.txt',project/'public/payload.txt','-'),('_prnext/assets/control.html',dist/'assets/control.html',dist/'assets/control.html.gz')]
        server,command=start(project,'.prnext-static','balanced','static')
        try:
            for route,identity,gzip in controls:client('validate-static.mjs',[url,identity,gzip,route],command)
            assert server.process.poll() is None, 'Static server exited unexpectedly'
            result.setdefault('serverFinal',[]).append(server.sample())
        finally:server.close()
        result['complete']=True
    finally:(out/'result.json').write_text(json.dumps(result,indent=2))
    print('Functional controls passed:',out,flush=True)
if __name__=='__main__':main()
