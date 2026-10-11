"""Manual Linux v6 campaign against the immutable v5 snapshot. No system-wide service/controller changes, no publishing.

Complete sets: alternating repeated performance; one hour mixed load on each
native version; 1/5/15 minute rests on every profile/version; two instances.
One idle cycle by default, up to three with --idle-cycles. Results remain
incomplete if any command fails. The complete workflow has a 12-hour ceiling.
"""
import argparse, concurrent.futures, copy, hashlib, json, pathlib, subprocess, sys, time
HERE=pathlib.Path(__file__).resolve().parent
def main():
    p=argparse.ArgumentParser();p.add_argument('--prepared',required=True);p.add_argument('--cgroup-root',required=True);p.add_argument('--idle-cycles',type=int,choices=[1,2,3],default=1);a=p.parse_args()
    if sys.platform!='linux':raise SystemExit('This campaign has not been executed on Windows')
    prepared=pathlib.Path(a.prepared).resolve();out=prepared/'measurements'
    configs=json.loads((prepared/'servers.json').read_text());provenance=json.loads((prepared/'provenance.json').read_text())
    if provenance.get('generation')!='v6' or provenance.get('baseline')!='final-v5' or not provenance.get('sourcesUnchangedAfterBuild'):
        raise RuntimeError('Expected verified preparation from linux-prepare-v6.py')
    for name in ['v5','candidate']:
        artifact=provenance['artifacts'][name]
        if hashlib.sha256(pathlib.Path(artifact['binary']).read_bytes()).hexdigest()!=artifact['sha256']:
            raise RuntimeError('Native artifact changed after preparation: '+name)
        dist=prepared/'app'/('.prnext-'+name)
        for relative,expected in artifact['buildFiles'].items():
            if hashlib.sha256((dist/relative).read_bytes()).hexdigest()!=expected:
                raise RuntimeError('Application build changed after preparation: '+name+'/'+relative)
    out.mkdir(exist_ok=False)
    cpus=provenance['physicalCpus'];summary={'generation':'v6','baseline':'final-v5','startedAt':time.time(),'complete':False,'runs':[],'runnerSha256':hashlib.sha256((HERE/'linux-runner.py').read_bytes()).hexdigest()}
    (out/'campaign.json').write_text(json.dumps(summary,indent=2))
    def execute(name,cfg,steps):
        cfg=copy.deepcopy(cfg);cfg['steps']=steps;path=out/(name+'.config.json');path.write_text(json.dumps(cfg,indent=2))
        subprocess.run([sys.executable,str(HERE/'linux-runner.py'),'--config',str(path),'--cgroup-root',a.cgroup_root,'--output',str(out/(name+'.json'))],check=True)
        return name
    def record(name,cfg,steps):
        summary['runs'].append(execute(name,cfg,steps));(out/'campaign.json').write_text(json.dumps(summary,indent=2))
    dynamic=['v5-balanced','candidate-balanced','v5-memory','candidate-memory','v5-speed','candidate-speed','next']
    def startup(index,label):
        cfg=copy.deepcopy(configs[label]);cfg['cpu']=[cpus[0],cpus[3],cpus[4]][index//2];port=32600+index
        cfg['url']='http://127.0.0.1:'+str(port);cfg['command'][cfg['command'].index('--port')+1]=str(port);cfg['probeReadiness']=False
        return execute('startup-zero-traffic-'+label,cfg,[{'kind':'idle','label':'no-http-or-tcp-probes','seconds':60}])
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs=[pool.submit(startup,index,label) for index,label in enumerate(dynamic[:-1])]
        for job in jobs:summary['runs'].append(job.result())
    # All three servers must serve exactly the same HTML and gzip bytes. Byte
    # validation runs separately from wrk, never relying on requested URLs alone.
    static=provenance['static']
    for label in ['v5-static','candidate-static','nginx']:
        record('bytes-'+label,configs[label],[{'kind':'static-validate','label':'identical-bytes-'+str(index),**control} for index,control in enumerate(static['controls'])])
    for label in dynamic:
        record('functional-'+label,configs[label],[{'kind':'validate','label':'freshness-streaming-cancellation'}])
    # This is acceptance, not the old-v3 runtime-contract rejection test.
    record('functional-candidate-v5-build',configs['candidate-v5-build'],[{'kind':'validate','label':'candidate-serves-v5-build'}])
    summary['runtimeCompatibility']={'configuration':'candidate-v5-build','passed':True}
    (out/'campaign.json').write_text(json.dumps(summary,indent=2))
    for repeat in range(3):
        for label in (dynamic if repeat%2==0 else dynamic[::-1]):
            steps=[]
            for route,connections in [('ssr',64),('stream',128),('api/json',64)]:
                for kind,seconds in [('warmup',10),('measure',30)]:steps.append({'kind':'load','label':route.replace('/','-')+'-'+kind,'route':route,'connections':connections,'seconds':seconds})
            record(f'dynamic-{repeat+1}-{label}',configs[label],steps)
        static_order=['v5-static','candidate-static','nginx']
        for label in (static_order if repeat%2==0 else static_order[::-1]):
            steps=[]
            for route,connections in [('pages-static',1),('pages-static',8),('pages-static',32),('pages-static',128),('payload.txt',32),(static['asset'].lstrip('/'),32)]:
                for kind,seconds in [('warmup',10),('measure',30)]:steps.append({'kind':'load','static':True,'label':route.replace('/','-')+f'-c{connections}-'+kind,'route':route,'connections':connections,'seconds':seconds,'encoding':'identity' if route=='payload.txt' else 'gzip'})
            record(f'static-{repeat+1}-{label}',configs[label],steps)
    # v5 and candidate both support counters. Both diagnostic soaks include the
    # observer thread; paired throughput above stays uninstrumented.
    for label in ['v5-balanced','candidate-balanced']:
        cfg=copy.deepcopy(configs[label]);cfg['environment']={'PRNEXT_METRICS_FILE':str(out/(label+'-metrics.jsonl'))}
        record('soak-'+label,cfg,[{'kind':'load','mixed':True,'route':'','label':'warmup','seconds':30,'connections':64},{'kind':'load','mixed':True,'route':'','label':'mixed-one-hour','seconds':3600,'connections':64},{'kind':'idle','label':'idle-after-soak','seconds':310},{'kind':'resume','label':'resume-after-soak'}])
    def idle(index,label):
        cfg=copy.deepcopy(configs[label]);cpu=[cpus[0],cpus[3],cpus[4]][index//2];port=32400+index
        cfg['cpu']=cpu;cfg['url']='http://127.0.0.1:'+str(port);cfg['command'][cfg['command'].index('--port')+1]=str(port)
        if index%2:time.sleep(25)
        steps=[{'kind':'idle','label':'startup-no-dynamic','seconds':60}]
        for cycle in range(a.idle_cycles):
            for rest in [60,300,900]:
                prefix=f'cycle-{cycle+1}-rest-{rest}'
                steps.extend([{'kind':'load','label':prefix+'-load','route':'stream','seconds':10,'connections':32},{'kind':'idle','label':prefix+'-idle','seconds':rest},{'kind':'resume','label':prefix+'-resume'}])
        return execute('idle-'+label,cfg,steps)
    # Wake latency must not share the generator with another idle campaign.
    for index,label in enumerate(dynamic[:-1]):
        summary['runs'].append(idle(index,label))
    for repeat in range(3):
        for label in (['v5-static','candidate-static'] if repeat%2==0 else ['candidate-static','v5-static']):
            jobs=[]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                for instance,cpu in enumerate([cpus[0],cpus[3]]):
                    cfg=copy.deepcopy(configs[label]);cfg['cpu']=cpu;port=32500+instance;cfg['url']='http://127.0.0.1:'+str(port);cfg['command'][cfg['command'].index('--port')+1]=str(port)
                    cfg['generatorCpus']=[cpus[1],cpus[2],cpus[4]]
                    steps=[{'kind':'load','label':'warmup','static':True,'route':'pages-static','seconds':10,'connections':32},{'kind':'load','label':'measure','static':True,'route':'pages-static','seconds':30,'connections':32}]
                    jobs.append(pool.submit(execute,f'multi-{repeat+1}-{label}-{instance}',cfg,steps))
                for job in jobs:summary['runs'].append(job.result())
    summary.update(complete=True,endedAt=time.time());(out/'campaign.json').write_text(json.dumps(summary,indent=2))
if __name__=='__main__':main()
