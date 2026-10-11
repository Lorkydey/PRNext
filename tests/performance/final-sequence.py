"""Wait for final test completion, then use its now-free server core."""
import importlib.util,pathlib,time,subprocess,sys,json
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
p.r.psutil.Process().cpu_affinity([8,9])
pid=int(sys.argv[1]);process=p.r.psutil.Process(pid)
while process.is_running():time.sleep(5)
tests=root/'artifacts/performance-v4/tests'
for name in ['rust','clippy','unit','e2e','types','types-basic','types-app']:
    result=json.loads((tests/(name+'.json')).read_text());assert result['exitCode']==0,(name,result)
for script,args in [('startup-idle-v4.py',[]),('wake-probe-v4.py',[]),('windows-compare-v4.py',['static','dynamic'])]:
    subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name(script)),*args],cwd=root,check=True)
