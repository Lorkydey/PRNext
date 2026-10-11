import importlib.util, pathlib, json
root=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('static-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
rows=[]
for mode in ['empty','metadata']:
    log=root/'artifacts/performance-v4'/('blocking-repro-'+mode+'.jsonl')
    server=p.r.Server([str(root/'artifacts/performance-v4/blocking-repro.exe'),mode],str(root),str(log),2)
    try:
        server.process.wait(timeout=40);rows.append({'mode':mode,**server.sample(),'exitCode':server.process.returncode})
    finally:server.close()
(root/'artifacts/performance-v4/blocking-repro-accounting.json').write_text(json.dumps(rows,indent=2))
