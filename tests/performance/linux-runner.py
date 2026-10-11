"""Linux cgroup v2 accounting. This script never enables controllers or changes services.

Run in a delegated, empty cgroup whose cpu/memory controllers are already enabled.
CPU includes exited workers; sampled PSS/RSS/FDs can miss short-lived processes.
"""
import argparse, hashlib, json, os, pathlib, re, subprocess, sys, threading, time, urllib.request, statistics

HERE=pathlib.Path(__file__).resolve().parent
DIRECT_HTTP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def fields(text):
    return {parts[0].rstrip(':'):int(parts[1]) for line in text.splitlines() if len(parts:=line.split())>=2 and parts[1].isdigit()}
def digest(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def request(url):
    start=time.perf_counter()
    with DIRECT_HTTP.open(urllib.request.Request(url,headers={'Cookie':'user=probe','Accept-Encoding':'identity'}),timeout=35) as response:
        body=response.read().decode();status=response.status
    return {'latencyMs':1000*(time.perf_counter()-start),'status':status,'body':body}
class Server:
    def __init__(self,cfg,parent,log):
        self.cfg=cfg;self.seen=set();self.group=pathlib.Path(parent)/('prnext-'+str(os.getpid())+'-'+str(time.monotonic_ns()))
        self.group.mkdir()
        try:
            for name in ['cpu.stat','cpu.max','memory.current','memory.max','cgroup.kill']:
                if not (self.group/name).exists():raise RuntimeError('Need delegated cgroup v2 cpu/memory controllers: '+name)
            (self.group/'cpu.max').write_text('100000 100000')
            (self.group/'memory.max').write_text(str(cfg.get('memoryBytes',2*1024**3)))
            if (self.group/'memory.swap.max').exists():(self.group/'memory.swap.max').write_text('0')
        except BaseException:
            self.group.rmdir();raise
        self.log=open(log,'wb');env={**os.environ,'NODE_ENV':'production','NEXT_TELEMETRY_DISABLED':'1','TOKIO_WORKER_THREADS':'1',**cfg.get('environment',{})}
        try:self.child=subprocess.Popen([sys.executable,str(HERE/'linux-runner.py'),'--child',str(self.group),str(cfg['cpu']),cfg['cwd'],*cfg['command']],stdout=self.log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,env=env)
        except BaseException:
            self.log.close();self.group.rmdir();raise
    def sample(self):
        cpu=fields((self.group/'cpu.stat').read_text());pids=set((self.group/'cgroup.procs').read_text().split());rows=[]
        for pid in pids:
            proc=pathlib.Path('/proc')/pid
            try:
                status=fields((proc/'status').read_text());stat=(proc/'stat').read_text().rsplit(')',1)[1].split()
                self.seen.add((pid,stat[19]))
                smaps=fields((proc/'smaps_rollup').read_text())
                rows.append({'pid':int(pid),'name':(proc/'comm').read_text().strip(),'rssKiB':status.get('VmRSS',0),'virtualKiB':status.get('VmSize',0),'pssKiB':smaps.get('Pss',0),'threads':status.get('Threads',0),'fds':len(list((proc/'fd').iterdir()))})
            except (FileNotFoundError,ProcessLookupError):pass
        return {'time':time.time(),'cpuSeconds':cpu['usage_usec']/1e6,'cpuStat':cpu,'cgroupMemoryMiB':int((self.group/'memory.current').read_text())/1048576,'memoryEvents':fields((self.group/'memory.events').read_text()),'rssMiB':sum(p['rssKiB'] for p in rows)/1024,'pssMiB':sum(p['pssKiB'] for p in rows)/1024,'virtualMiB':sum(p['virtualKiB'] for p in rows)/1024,'threads':sum(p['threads'] for p in rows),'fds':sum(p['fds'] for p in rows),'processes':len(rows),'sampledProcessStarts':len(self.seen),'processDetail':rows}
    def close(self):
        (self.group/'cgroup.kill').write_text('1');self.child.wait(timeout=15);self.log.close()
        for _ in range(100):
            if fields((self.group/'cgroup.events').read_text()).get('populated')==0:break
            time.sleep(.05)
        last=self.sample();self.group.rmdir();return last
def measured(server,fn,raw):
    before=server.sample();stop=threading.Event();samples=[];failures=[]
    def monitor():
        try:
            with open(raw,'a',encoding='utf8') as output:
                while not stop.wait(1):
                    row=server.sample();samples.append(row);output.write(json.dumps(row)+'\n');output.flush()
        except BaseException as error:failures.append(error)
    thread=threading.Thread(target=monitor);thread.start();start=time.perf_counter()
    try:value=fn()
    finally:stop.set();thread.join()
    if failures:raise failures[0]
    after=server.sample();samples.append(after)
    return {'value':value,'elapsedSeconds':time.perf_counter()-start,'cpuSeconds':after['cpuSeconds']-before['cpuSeconds'],'rssMedianMiB':statistics.median(s['rssMiB'] for s in samples),'pssMedianMiB':statistics.median(s['pssMiB'] for s in samples),'before':before,'after':after}
def load(cfg,route,connections,seconds,out,static=False,mixed=False,encoding='gzip'):
    if static:
        command=['wrk','--latency','-t'+str(min(connections,len(cfg['generatorCpus']))),'-c'+str(connections),'-d'+str(seconds)+'s','-H','Accept-Encoding: '+encoding,'-s',str(HERE/'wrk-json.lua'),cfg['url']+'/'+route]
    else:command=[cfg['node'],str(HERE/('mixed-load.mjs' if mixed else 'load.mjs')),cfg['url']+('' if mixed else '/'+route),str(seconds),str(connections)]
    command=['taskset','-c',','.join(map(str,cfg['generatorCpus'])),*command]
    with open(str(out)+'.generator.log','wb') as stdout:
        child=subprocess.Popen(command,stdout=stdout,stderr=subprocess.STDOUT)
        # Per-thread utilisation reveals a single saturated generator thread even
        # when its process is assigned multiple CPUs. CPU gaps at exit are marked.
        previous={};peaks={};started=time.monotonic()
        while child.poll() is None:
            now=time.monotonic()
            for file in pathlib.Path('/proc',str(child.pid),'task').glob('*/stat'):
                try:
                    values=file.read_text().rsplit(')',1)[1].split();cpu=(int(values[11])+int(values[12]))/os.sysconf('SC_CLK_TCK');tid=file.parent.name
                    if tid in previous:
                        elapsed=now-previous[tid][0]
                        if elapsed:peaks[tid]=max(peaks.get(tid,0),100*(cpu-previous[tid][1])/elapsed)
                    previous[tid]=(now,cpu)
                except FileNotFoundError:pass
            if now-started>seconds+90:child.kill();child.wait();raise TimeoutError('load generator did not drain')
            time.sleep(.5)
    text=pathlib.Path(str(out)+'.generator.log').read_text()
    if child.returncode:raise RuntimeError(text[-8000:])
    candidates=[line.removeprefix('PRNEXT_RESULT ') for line in text.splitlines() if line.startswith('{') or line.startswith('PRNEXT_RESULT ')]
    result=json.loads(candidates[-1]);result['command']=command;result['generatorThreadPeakCpuPercent']=peaks
    result['generatorMayLimit']=max(peaks.values(),default=100)>85
    result['generatorCpuSamplingCaveat']='500 ms samples; final partial interval is not counted'
    result['boundaryPolicy']='wrk closes remaining requests at end; static only, boundary cancellations uncounted' if static else 'every started request drained; steady window and drain reported separately'
    return result
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--cgroup-root',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    if sys.platform!='linux':raise SystemExit('Linux execution required; no substitute accounting is used')
    cfg=json.loads(pathlib.Path(args.config).read_text());out=pathlib.Path(args.output).resolve();out.parent.mkdir(parents=True,exist_ok=True)
    allowed=os.sched_getaffinity(0)
    if cfg['cpu'] not in allowed or set(cfg['generatorCpus'])-allowed or cfg['cpu'] in cfg['generatorCpus']:raise ValueError('Server and generator need disjoint available CPUs')
    # Keep proc/PSS sampling and the coordinator off the measured server CPU.
    # The suspended-before-exec helper sets its own server affinity explicitly.
    os.sched_setaffinity(0,set(cfg['generatorCpus']))
    result={'config':cfg,'platform':dict(zip(['sysname','nodename','release','version','machine'],os.uname())),'configSha256':digest(args.config),'commandSha256':digest(cfg['command'][0]),'results':[],'complete':False}
    server=Server(cfg,args.cgroup_root,str(out)+'.server.log')
    def record(label,fn):
        row={'label':label,**measured(server,fn,str(out)+'.samples.jsonl')}
        if isinstance(row['value'],dict) and row['value'].get('count'):row['cpuMsPerResponse']=row['cpuSeconds']*1000/row['value']['count']
        result['results'].append(row);out.write_text(json.dumps(result,indent=2));print(label,flush=True)
        if isinstance(row['value'],dict) and (row['value'].get('errors',0) or row['value'].get('validationErrors',0)):
            raise RuntimeError('Load errors retained in '+label+'; refusing to mark this run complete')
    try:
        if cfg.get('probeReadiness',True):
            for _ in range(300):
                try:request(cfg['url']+'/robots.txt');break
                except Exception:
                    if server.child.poll() is not None:raise RuntimeError('Server exited; inspect log')
                    time.sleep(.1)
            else:raise TimeoutError('server startup')
        else:
            if any(step['kind']!='idle' for step in cfg['steps']):raise ValueError('No-probe startup case permits idle observation only')
            result['startupProbeRequests']=0
        result['startup']=server.sample()
        for step in cfg['steps']:
            name=step['label'];kind=step['kind']
            if kind=='load':record(name,lambda:load(cfg,step['route'],step['connections'],step['seconds'],str(out)+'.'+name,step.get('static',False),step.get('mixed',False),step.get('encoding','gzip')))
            elif kind=='idle':
                def idle():
                    time.sleep(step['seconds'])
                    if server.child.poll() is not None:raise RuntimeError('Server exited during idle')
                    if not cfg.get('probeReadiness',True) and any(p['name']=='node' for p in server.sample()['processDetail']):
                        raise RuntimeError('Node started without traffic')
                record(name,idle)
            elif kind=='resume':
                def resume():
                    responses=[request(cfg['url']+'/stream') for _ in range(5)]
                    assert len(set(r['body'] for r in responses))==5 and all('user:probe' in r['body'] for r in responses)
                    for response in responses:response.pop('body')
                    return responses
                record(name,resume)
            elif kind=='validate':
                def validate():
                    values=[]
                    for script in ['validate.mjs','cancellation-storm.mjs']:
                        done=subprocess.run([cfg['node'],str(HERE/script),cfg['url']],capture_output=True,text=True,timeout=120,check=True);values.append({'script':script,'stdout':done.stdout,'stderr':done.stderr})
                    return values
                record(name,validate)
            elif kind=='static-validate':
                def validate_static():
                    done=subprocess.run([cfg['node'],str(HERE/'validate-static.mjs'),cfg['url'],step['html'],step['gzip'] or '-',step.get('route','pages-static')],capture_output=True,text=True,timeout=30,check=True)
                    return {'stdout':done.stdout,'stderr':done.stderr}
                record(name,validate_static)
            else:raise ValueError('Unknown step '+kind)
        result['complete']=True
    finally:
        result['shutdown']=server.close();out.write_text(json.dumps(result,indent=2))
if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--child':
        group,cpu,cwd,*command=sys.argv[2:];(pathlib.Path(group)/'cgroup.procs').write_text(str(os.getpid()));os.sched_setaffinity(0,{int(cpu)});os.chdir(cwd);os.execvpe(command[0],command,os.environ)
    main()
