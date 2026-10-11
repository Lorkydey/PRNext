"""Aggregate verified complete attempts; retain every exclusion and raw hash."""
import collections, hashlib, importlib.util, json, math, pathlib, statistics, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'artifacts/performance-v5/experiments'
_cpu_spec=importlib.util.spec_from_file_location('summary_generator_cpu_v5',pathlib.Path(__file__).with_name('generator-cpu-v5.py'))
generator_cpu=importlib.util.module_from_spec(_cpu_spec)
_cpu_spec.loader.exec_module(generator_cpu)
def read(file): return json.loads(file.read_text(encoding='utf-8-sig'))
def sha(file): return hashlib.sha256(file.read_bytes()).hexdigest()
def close(a,b): return isinstance(a,(int,float)) and not isinstance(a,bool) and math.isfinite(a) and math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-8)

def validate_config(config):
    if not config.get('variants') or not config.get('scenarios'): raise ValueError('configuration needs variants and scenarios')
    names=[v['name'] for v in config['variants']]
    if len(set(names))!=len(names): raise ValueError('duplicate configured variant')
    if len({tuple(s) for s in config['scenarios']})!=len(config['scenarios']): raise ValueError('duplicate configured scenario')
    if not isinstance(config.get('repeats',3),int) or isinstance(config.get('repeats',3),bool) or config.get('repeats',3)<1: raise ValueError('invalid configured repetition count')
    for name,default in [('warmup',10),('seconds',30)]:
        value=config.get(name,default)
        if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or value<=0: raise ValueError('invalid configured duration')

def aggregate_reasons(row,config,base):
    """Recompute the phase join from its immutable JSONL prefix, never trust p95."""
    configured=config.get('generatorCpuFile')
    joined=row.get('aggregateGeneratorCpu')
    if not configured and not config.get('enforceAggregateGeneratorCpu') and joined is None:
        return []
    if not configured:return ['aggregate generator observation is not configured']
    if not isinstance(joined,dict):return ['aggregate generator observation is missing']
    try:
        proof=joined['observation'];file=pathlib.Path(proof['file'])
        expected=pathlib.Path(configured)
        if not expected.is_absolute():expected=pathlib.Path(base)/expected
        if not file.is_absolute() or file.resolve()!=expected.resolve():return ['aggregate generator observation path differs from configuration']
        length=proof['prefixBytes']
        if not isinstance(length,int) or isinstance(length,bool) or length<=0 or length>file.stat().st_size:return ['aggregate generator prefix length is invalid']
        with file.open('rb') as stream:prefix=stream.read(length)
        if not prefix.endswith(b'\n') or hashlib.sha256(prefix).hexdigest()!=proof['prefixSha256']:return ['aggregate generator prefix is incomplete or its hash differs']
        rows=[json.loads(line) for line in prefix.decode('utf-8').splitlines()]
        if not rows or rows[0]!=proof['start'] or rows[0].get('event')!='start':return ['aggregate generator start record differs']
        start=rows[0]
        if start.get('schema')!=1 or start.get('cpus')!=[8,9] or start.get('thresholdPercent')!=85:return ['aggregate generator policy or processors differ']
        if start.get('observerSha256')!=sha(pathlib.Path(__file__).with_name('generator-cpu-v5.py')):return ['aggregate generator observer source hash differs']
        if any(item.get('event')=='error' for item in rows):return ['aggregate generator observer reported an error']
        actual=generator_cpu.window_utilization(rows,row['before']['time']*1000,row['after']['time']*1000)
        reported={key:value for key,value in joined.items() if key!='observation'}
        if actual!=reported:return ['aggregate generator window differs from raw observation']
        if row.get('aggregateGeneratorMayLimit') is not actual['contaminated']:return ['aggregate generator contamination flag differs']
        if not actual['completeCoverage']:return ['aggregate generator observation lacks complete coverage']
        if row.get('phase')=='measure' and actual['contaminated']:return ['aggregate generator CPU p95 exceeds 85%']
        return []
    except (OSError,ValueError,TypeError,KeyError,AttributeError,OverflowError) as error:
        return ['invalid aggregate generator observation: '+str(error)]

def attempt_reasons(result, config, base=None):
    reasons=[]
    if result.get('complete') is not True: reasons.append('attempt incomplete')
    if result.get('backgroundInterference'): reasons.append('background interference')
    variant=next((v for v in config['variants'] if v['name']==result.get('variant')),None)
    if variant is None: return reasons+['unknown variant']
    if result.get('command')!=variant['command']: reasons.append('command differs from configuration')
    if result.get('environment',{})!=variant.get('env',{}): reasons.append('environment differs from configuration')
    # Preserve older native attempts without cwd, but every newly recorded cwd
    # and every Next attempt must agree with the actual configured project.
    if 'cwd' in result or 'next' in result:
        cwd=result.get('cwd')
        if not isinstance(cwd,str) or pathlib.Path(cwd).resolve()!=pathlib.Path(variant.get('cwd',str(ROOT))).resolve(): reasons.append('working directory differs from configuration')
    repeat=result.get('repeat')
    if not isinstance(repeat,int) or isinstance(repeat,bool) or not 1<=repeat<=config.get('repeats',3): reasons.append('repeat outside configuration')
    if result.get('serverCpu')!=config.get('serverCpu',10) or result.get('generatorCpus')!=[8,9]: reasons.append('CPU configuration mismatch')
    expected=[(route,connections,phase,seconds) for route,connections in config['scenarios'] for phase,seconds in [('warmup',config.get('warmup',10)),('measure',config.get('seconds',30))]]
    rows=result.get('results',[])
    if len(rows)!=len(expected): reasons.append('missing or extra phases')
    for index,(row,want) in enumerate(zip(rows,expected)):
        where=f'phase {index+1}';value=row.get('value',{})
        reasons.extend(where+' '+reason for reason in aggregate_reasons(row,config,base or BASE.parent))
        if (row.get('route'),row.get('connections'),row.get('phase'),value.get('durationSeconds'))!=want: reasons.append(where+' does not match configuration')
        if value.get('errors')!=0 or value.get('validationErrors',0)!=0: reasons.append(where+' has errors')
        count=value.get('count');within=value.get('completedWithinWindow');duration=value.get('durationSeconds')
        if not isinstance(count,int) or isinstance(count,bool) or count<=0: reasons.append(where+' invalid response count');continue
        if value.get('started')!=count: reasons.append(where+' requests were not fully drained')
        if not isinstance(within,int) or isinstance(within,bool) or not 0<=within<=count: reasons.append(where+' invalid window count')
        elif not isinstance(duration,(int,float)) or duration<=0 or not close(value.get('rps'),within/duration): reasons.append(where+' invalid throughput arithmetic')
        if value.get('statuses')!={'200':count}: reasons.append(where+' status counts differ from successful responses')
        if value.get('connections')!=row.get('connections'): reasons.append(where+' connection count mismatch')
        if not close(row.get('cpuMsPerResponse'),1000*row.get('cpuSeconds',float('nan'))/count): reasons.append(where+' invalid CPU per response')
        before,after=row.get('before',{}),row.get('after',{})
        if row.get('cpuSeconds',-1)<0 or not close(row.get('cpuSeconds'),after.get('cpuSeconds',float('nan'))-before.get('cpuSeconds',float('nan'))): reasons.append(where+' invalid cumulative CPU delta')
        if row.get('processesStarted')!=after.get('totalProcesses',0)-before.get('totalProcesses',0): reasons.append(where+' invalid process-start delta')
        cpu=value.get('generatorCpuPercent')
        if not isinstance(cpu,(int,float)) or not math.isfinite(cpu) or cpu<0 or cpu>85 or row.get('generatorMayLimit') is not False: reasons.append(where+' generator may limit or lacks valid accounting')
        for name in ['rps','p50','p95','p99','bytes']:
            number=value.get(name)
            if not isinstance(number,(int,float)) or isinstance(number,bool) or not math.isfinite(number) or number<0: reasons.append(where+' invalid '+name)
        samples=row.get('samples',[])
        if not samples or samples[-1]!=after: reasons.append(where+' missing final accounting sample')
        elif not close(row.get('rssMedianMiB'),statistics.median(s['rssMiB'] for s in samples)): reasons.append(where+' invalid RSS median')
        for sample in [before,*samples]:
            for name in ['cpuSeconds','rssMiB','threads','totalProcesses']:
                number=sample.get(name)
                if not isinstance(number,(int,float)) or isinstance(number,bool) or not math.isfinite(number) or number<0: reasons.append(where+' invalid accounting '+name)
    return reasons

def summarize_folder(folder, write=False):
    folder=pathlib.Path(folder);config_file=folder/'config.json';config=read(config_file)
    validate_config(config)
    config_source=folder.parent.parent/'configs'/(config['name']+'.json')
    source_hash=sha(config_source) if config_source.is_file() else None;verification=[]
    if source_hash is None: verification.append('original configuration is missing')
    if config_source.is_file() and read(config_source)!=config: verification.append('source config differs from preserved config')
    groups=collections.defaultdict(list);excluded=[];inputs=[];rejected=[];hashes={};accepted=[]
    for file in sorted(folder.glob('*-attempt*.json')):
        hashes[file.name]=sha(file)
        try:
            result=read(file);reasons=attempt_reasons(result,config,folder.parent.parent)
            if source_hash and result.get('configSha256')!=source_hash: reasons.append('source config hash mismatch')
            if source_hash is None: reasons.append('original configuration unavailable for verification')
        except (ValueError,TypeError,KeyError,OverflowError,AttributeError) as error:
            result={};reasons=['invalid attempt: '+str(error)]
        if reasons: rejected.append({'file':file.name,'reasons':reasons});excluded.append(file.name)
        else: accepted.append((file,result))
    pairs=collections.Counter((r['variant'],r['repeat']) for _,r in accepted)
    for file,result in accepted:
        if pairs[(result['variant'],result['repeat'])]!=1:
            rejected.append({'file':file.name,'reasons':['duplicate successful variant/repeat']});excluded.append(file.name);continue
        inputs.append(file.name)
        for row in result['results']:
            if row['phase']=='measure':groups[(result['variant'],row['route'],row['connections'])].append(row)
    output=[]
    for (variant,route,connections),rows in groups.items():
        metrics={'rps':[x['value']['rps'] for x in rows], 'cpuMsPerResponse':[x['cpuMsPerResponse'] for x in rows],
            'rssMiB':[x['rssMedianMiB'] for x in rows], 'p50':[x['value']['p50'] for x in rows],
            'p95':[x['value']['p95'] for x in rows], 'p99':[x['value']['p99'] for x in rows],
            'threadsPeak':[max(s['threads'] for s in [x['before'],*x['samples']]) for x in rows],
            'generatorCpuPercent':[x['value']['generatorCpuPercent'] for x in rows],
            'bytesPerResponse':[x['value']['bytes']/x['value']['count'] for x in rows]}
        output.append({'variant':variant,'route':route,'connections':connections,'repeats':len(rows),
            'responses':sum(x['value']['count'] for x in rows),'errors':sum(x['value']['errors'] for x in rows),
            'processesStarted':sum(x['processesStarted'] for x in rows),
            'metrics':{k:{'median':statistics.median(v),'min':min(v),'max':max(v),'values':v} for k,v in metrics.items()}})
    marker=False
    if (folder/'complete.json').exists():
        try: marker=read(folder/'complete.json').get('complete') is True
        except (ValueError,AttributeError): verification.append('invalid completion marker')
    expected_count=config.get('repeats',3)*len(config['variants'])
    if marker and len(inputs)!=expected_count:verification.append('completion marker contradicts accepted attempt count')
    if any(len(rows)!=config.get('repeats',3) for rows in groups.values()) and marker:verification.append('completion marker contradicts group repetitions')
    result={'name':config['name'],'complete':marker and len(inputs)==expected_count and not verification,
            'inputs':inputs,'excluded':sorted(excluded),'groups':output,'inputSha256':hashes,
            'configSha256':{'preserved':sha(config_file),'source':source_hash},'rejected':rejected,
            'verificationErrors':verification,'expectedAttempts':expected_count}
    if write:(folder/'summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result

def summarize(name):
    result=summarize_folder(BASE/name,write=True)
    for row in result['groups']:
        m=row['metrics'];print(name,row['variant'],row['route'],row['connections'],'rps',round(m['rps']['median'],2),'cpu',round(m['cpuMsPerResponse']['median'],4),'rss',round(m['rssMiB']['median'],1),'p99',m['p99']['median'],'errors',row['errors'])
    for row in result['rejected']:print('excluded',row['file'],', '.join(row['reasons']))
    return result
if __name__=='__main__':
    for name in sys.argv[1:]:summarize(name)
