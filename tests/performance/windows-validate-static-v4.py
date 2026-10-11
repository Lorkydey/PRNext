"""Final exact-wire controls for both binaries and three routing paths."""
import importlib.util,json,pathlib,time,hashlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);r=p.r
BASE=ROOT/'artifacts/performance-v4';out=BASE/'static-controls';out.mkdir(exist_ok=False)
app=BASE/'static-app';dist=app/'.prnext-static';node=ROOT/'artifacts/performance/node24/node.exe'
manifest=json.loads((dist/'manifest.json').read_text());page=next(row for row in manifest['prerendered'] if row['path']=='/pages-static')
html=dist/page['file'];controls=[('pages-static',html,str(html)+'.gz'),('payload.txt',app/'public/payload.txt','-'),('_prnext/assets/control.html',dist/'assets/control.html',str(dist/'assets/control.html.gz'))]
result={'complete':False,'controls':[]}
try:
    for variant in ['v3','candidate']:
        binary=BASE/('reference-v3/prnext-final.exe' if variant=='v3' else 'prnext-v4.exe');url='http://127.0.0.1:32750'
        command=[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(node),'--port','32750']
        server=r.Server(command,str(ROOT),str(out/(variant+'.log')),6)
        try:
            for _ in range(100):
                try:r.get(url+'/robots.txt');break
                except Exception:
                    if server.process.poll() is not None:raise RuntimeError('Server exited')
                    time.sleep(.1)
            else:raise TimeoutError('server readiness')
            for index,(route,identity,gzip) in enumerate(controls):
                args=[str(node),str(ROOT/'tests/performance/validate-static.mjs'),url,str(identity),gzip,route]
                done=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=0x08000000)
                r.psutil.Process(done.pid).cpu_affinity([8,9]);stdout,stderr=done.communicate(timeout=30)
                row={'variant':variant,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'serverCommand':command,'validationCommand':args,'exitCode':done.returncode,'stdout':stdout.decode(),'stderr':stderr.decode()}
                result['controls'].append(row)
                assert done.returncode==0,row
        finally:server.close()
    result['complete']=True
finally:(out/'result.json').write_text(json.dumps(result,indent=2))
print('Both binaries pass all three exact-wire controls')
