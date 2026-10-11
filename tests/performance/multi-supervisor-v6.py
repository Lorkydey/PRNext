"""Portable idle supervisor, included in the measured group; never restarts apps."""
import json, os, pathlib, subprocess, sys, time
file=pathlib.Path(sys.argv[1]);config=json.loads(file.read_text());children=[];logs=[]
try:
    for index,row in enumerate(config['commands']):
        log=(file.parent/f'app-{index}.log').open('xb');logs.append(log)
        children.append(subprocess.Popen(row['command'],cwd=row['cwd'],env={**os.environ,**row.get('environment',{})},stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT))
    previous=None
    while True:
        state=[{'pid':child.pid,'exitCode':child.poll()} for child in children]
        if state!=previous:file.with_suffix('.children.json').write_text(json.dumps(state));previous=state
        time.sleep(.2)
finally:
    for log in logs:log.close()
