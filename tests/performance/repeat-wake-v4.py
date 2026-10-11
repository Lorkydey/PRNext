"""Use CPU 0 only during the long, traffic-free middle rest window."""
import pathlib,time,json,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
while True:
    try:
        files=list((root/'artifacts/performance-v4/idle').glob('*.json'))
        values=[json.loads(file.read_text()) for file in files]
        if len(values)==6 and all(value['results'][-1]['label']=='cycle-2-rest-900-load' for value in values):break
    except (OSError,ValueError):pass
    time.sleep(2)
subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('wake-probe-v4.py')),'0'],cwd=root,check=True)
