"""Sequential multi-app comparisons with one shared CPU/commit budget per group.
Run only after all builds/tests finish. Raw unsuccessful runs remain evidence.
"""
import argparse, concurrent.futures, datetime, hashlib, importlib.util, json, pathlib, statistics, time, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/performance-v6';NODE=ROOT/'artifacts/performance/node24/node.exe'
spec=importlib.util.spec_from_file_location('group',pathlib.Path(__file__).with_name('group-windows-v6.py'));g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def commands(variant,profile,n,port,folder,instrument=False,retire=None):
    binary=OUT/('reference-v5/prnext.exe' if variant=='v5' else 'candidates/final-http/prnext.exe')
    rows=[]
    for i in range(n):
        app=OUT/f'apps/app{i}'
        command=[str(binary),'start',str(app),'--build-dir','.prnext-v5','--node',str(NODE),'--profile','balanced' if profile=='balanced-small' else profile,'--port',str(port+i)]
        if retire is not None:command+=['--worker-idle-seconds',str(retire),'--lane-idle-seconds','1']
        env={}
        if profile=='balanced-small':env['NODE_OPTIONS']='--max-semi-space-size=1'
        if instrument:env['PRNEXT_METRICS_FILE']=str(folder/f'metrics-{i}.jsonl')
        rows.append({'command':command,'cwd':str(app),'environment':env})
    return rows

def ready(urls):
    for url in urls:
        for _ in range(150):
            try:
                with urllib.request.urlopen(url+'/robots.txt',timeout=1) as response:response.read()
                break
            except Exception:time.sleep(.1)
        else:raise TimeoutError('Readiness '+url)

def targets(urls,mode):
    n=len(urls)
    return [{'url':url,'connections':(32 if mode=='one' else 128 if mode=='noisy' else max(1,32//n)) if i==0 else (0 if mode=='one' else 1 if mode=='noisy' else max(1,32//n)),
             **({'intervalMs':100} if mode=='noisy' and i>0 else {})} for i,url in enumerate(urls)]

def once(label,variant,profile,n,budget,seconds=20,cpu=10,port=33100,modes=('all','one','noisy'),instrument=False,retire=None):
    folder=OUT/'multi'/label
    rows=commands(variant,profile,n,port,folder,instrument,retire)
    result={'complete':False,'label':label,'variant':variant,'profile':profile,'apps':n,'jobCommitLimitMiB':budget,'serverCpus':[cpu],'generatorCpus':[8,9],
            'commands':rows,'binarySha256':sha(pathlib.Path(rows[0]['command'][0])),'nodeSha256':sha(NODE),'startedAt':time.time(),'results':[],
            'instrumented':instrument,'scope':'Independent project roots, shared read-only dependencies; one Job including idle Python supervisor and all descendants; Windows commit cap, not Linux RSS/PSS; OS pagefile unchanged'}
    server=g.Group(rows,folder,cpu,budget);urls=['http://127.0.0.1:'+str(port+i) for i in range(n)]
    def record(name,fn):
        value={'phase':name,**g.m.measured(server,fn,folder/'resources.jsonl')};result['results'].append(value)
        (folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');return value
    try:
        ready(urls)
        record('warmup',lambda:g.load({'seconds':5,'apps':targets(urls,'all')},folder/'warmup'))
        for mode in modes:
            row=record(mode,lambda:g.load({'seconds':40 if mode=='one' and seconds>=20 else seconds,'apps':targets(urls,mode)},folder/mode))
            if any(app['errors'] for app in row['value']['apps']):
                # Allocation failures and HTTP failures are outcomes, never
                # discarded or included in successful throughput denominators.
                result.setdefault('observedFailures',[]).append(mode)
        result['complete']=True
    except BaseException as error:result['failure']={'type':type(error).__name__,'message':str(error)}
    finally:
        result['final']=server.sample();server.close();result['finishedAt']=time.time()
        result['oomLogMatches']={p.name:[line[:300] for line in p.read_text(encoding='utf-8',errors='replace').splitlines() if any(s in line.lower() for s in ['out of memory','allocation failed','memoryerror'])] for p in folder.glob('app-*.log')}
        (folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(label,'complete',result['complete'],'limitEvents',result['final'].get('jobMemoryLimitEvents'),flush=True)
    return result

def main():
    g.r.psutil.Process().cpu_affinity([0,1])
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['smoke','matrix']);args=parser.parse_args()
    if args.mode=='smoke':
        once('smoke-v6-memory-4', 'v6','memory',4,1024,3,modes=('all',))
        return
    sequence=[]
    for repeat in [1,2]:
        for n,budget in [(1,512),(4,1024),(8,2048)]:
            for profile in ['balanced','memory','speed','balanced-small']:
                for variant in (['v5','v6'] if repeat==1 else ['v6','v5']):
                    label=f'r{repeat}-{n}apps-{budget}MiB-{profile}-{variant}'
                    sequence.append((label,variant,profile,n,budget,20,('all','one','noisy')))
        for n,budget in [(4,512),(8,1024)]:
            for profile in ['balanced','memory','speed','balanced-small']:
                for variant in (['v5','v6'] if repeat==1 else ['v6','v5']):
                    label=f'pressure-r{repeat}-{n}apps-{budget}MiB-{profile}-{variant}'
                    sequence.append((label,variant,profile,n,budget,20,('all',)))
    metadata={'complete':False,'startedAt':time.time(),'sequence':sequence,'finished':[],'scriptSha256':sha(pathlib.Path(__file__))}
    path=OUT/'multi-campaign.json';assert not path.exists()
    for label,variant,profile,n,budget,seconds,modes in sequence:
        path.write_text(json.dumps(metadata,indent=2),encoding='utf-8')
        result=once(label,variant,profile,n,budget,seconds,modes=modes)
        metadata['finished'].append({'label':label,'complete':result['complete']})
    metadata.update(complete=True,finishedAt=time.time());path.write_text(json.dumps(metadata,indent=2),encoding='utf-8')

if __name__=='__main__':main()
