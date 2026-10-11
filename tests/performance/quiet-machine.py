"""Read-only detection of competing build commands; never stop external work."""
import time
def builds(psutil):
    result=[]
    for process in psutil.process_iter(['pid','name','create_time']):
        name=(process.info['name'] or '').lower()
        if name not in ['cargo.exe','rustc.exe','cl.exe','link.exe','msbuild.exe','node.exe']:continue
        try:
            command=process.cmdline()
            if name=='node.exe' and 'build' not in command:continue
            result.append({'pid':process.pid,'name':name,'started':process.info['create_time'],'cwd':process.cwd(),'command':command})
        except (psutil.NoSuchProcess,psutil.AccessDenied):pass
    return result
def wait(psutil,events,cooldown=60,force=False):
    busy=force;quiet_since=None
    while True:
        current=builds(psutil)
        if current:
            if not busy:print('Waiting for external builds; no external process is changed',flush=True)
            events.append({'time':time.time(),'builds':current});busy=True;quiet_since=None
        elif not busy:return
        elif quiet_since is None:quiet_since=time.monotonic()
        elif time.monotonic()-quiet_since>=cooldown:return
        time.sleep(5)
