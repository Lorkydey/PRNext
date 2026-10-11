"""Immutable, named Windows experiments. Never overwrites an earlier attempt.

snapshot NAME [--baseline] [--routing-only] captures source + command provenance.
build NAME [--mimalloc] compiles that snapshot, not the changing working tree.
bench CONFIG.json alternates the named variants, retaining every warmup and run.
"""
import argparse, datetime, hashlib, importlib.util, json, os, pathlib, shutil
import subprocess, sys, threading, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/performance-v5'
NODE = ROOT / 'artifacts/performance/node24/node.exe'
REF = OUT / 'reference-v4'
def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), pathlib.Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

# Pure provenance/window helpers can be tested without loading Windows APIs.
p = r = None
quiet = module('quiet-machine')
measurement = module('measurement-v5')
generator_cpu = module('generator-cpu-v5')

def windows_support():
    global p, r
    if r is None:
        p = module('static-probe'); r = p.r

def sha(file): return hashlib.sha256(file.read_bytes()).hexdigest()
def write(file, value): file.write_text(json.dumps(value, indent=2), encoding='utf-8')
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(value): return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def aggregate_cpu_path(cfg):
    name = cfg.get('generatorCpuFile')
    if name is None:
        if cfg.get('enforceAggregateGeneratorCpu'):
            raise ValueError('enforceAggregateGeneratorCpu requires generatorCpuFile')
        return None
    if not isinstance(name, str) or not name:
        raise ValueError('generatorCpuFile must name the live observer JSONL file')
    file = pathlib.Path(name)
    return (file if file.is_absolute() else OUT / file).resolve()

def read_live_observation(file, alive):
    try:
        raw = pathlib.Path(file).read_bytes()
    except OSError as error:
        raise RuntimeError('Aggregate generator CPU observer is unavailable: ' + str(file)) from error
    # A concurrent append may be partway through its final line. Preserve the
    # exact complete prefix identity and never treat that partial line as data.
    prefix = raw[:raw.rfind(b'\n') + 1]
    try:
        rows = [json.loads(line) for line in prefix.decode('utf-8').splitlines()]
    except (ValueError, UnicodeError) as error:
        raise RuntimeError('Aggregate generator CPU observer has invalid JSONL') from error
    if not rows or rows[0].get('event') != 'start':
        raise RuntimeError('Aggregate generator CPU observer start record is missing')
    start = rows[0]
    if start.get('schema') != 1 or start.get('thresholdPercent') != 85 or start.get('cpus') != [8, 9] or start.get('observerSha256') != sha(pathlib.Path(__file__).with_name('generator-cpu-v5.py')):
        raise RuntimeError('Aggregate generator CPU observer identity/CPUs differ')
    if not isinstance(start.get('pid'), int) or isinstance(start['pid'], bool) or not alive(start['pid']):
        raise RuntimeError('Aggregate generator CPU observer process is not alive')
    if any(row.get('event') in ('error', 'stop') for row in rows):
        raise RuntimeError('Aggregate generator CPU observer stopped or failed')
    return rows, {'file': str(pathlib.Path(file).resolve()), 'start': start,
                  'prefixBytes': len(prefix), 'prefixSha256': hashlib.sha256(prefix).hexdigest()}

def aggregate_cpu_window(file, row, alive, timeout=3, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + timeout
    while True:
        rows, proof = read_live_observation(file, alive)
        try:
            # Server.sample().time is Unix SECONDS, observer intervals are MS.
            result = generator_cpu.window_utilization(rows, row['before']['time'] * 1000, row['after']['time'] * 1000)
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeError('Invalid aggregate generator CPU observation: ' + str(error)) from error
        if result['completeCoverage']:
            return {**result, 'observation': proof}
        if clock() >= deadline:
            raise RuntimeError('Aggregate generator CPU coverage is incomplete after 3 seconds: ' + json.dumps(result))
        sleep(min(.1, max(0, deadline - clock())))

def attach_next_provenance(record):
    command = record['command']
    is_next = record.get('variant') == 'next' or pathlib.Path(command[0]).resolve() == NODE.resolve()
    if not is_next:
        return
    file = OUT / 'fixture-evidence.json'
    fixture = json.loads(file.read_text(encoding='utf-8-sig'))
    record['next'] = fixture.get('next')
    record['fixtureEvidenceSha256'] = sha(file)
    # Share the independently reviewed strict command/package/build validator,
    # including the pinned Node, exact cwd, CLI, lockfile and fixture sources.
    audit = module('audit-v5').Audit(ROOT, OUT)
    audit.next_provenance(record, 'Next experiment preflight')
    if audit.errors:
        raise ValueError('Invalid Next provenance: ' + '; '.join(audit.errors))

def contamination(row):
    observation = row.get('aggregateGeneratorCpu')
    return row.get('phase') == 'measure' and observation is not None and observation['contaminated']

def snapshot(args):
    dest = OUT / 'candidates' / args.name
    dest.mkdir(parents=True, exist_ok=False)
    baseline = json.loads((REF / 'reference.json').read_text())
    if args.baseline or args.routing_only:
        names = baseline['sourceSha256']; source = REF / 'source'
    else:
        names = sorted(set(subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')) - {''})
        source = ROOT
    hashes = {}
    for name in names:
        src = source / name
        if not src.is_file(): continue
        target = dest / 'source' / name; target.parent.mkdir(parents=True, exist_ok=True)
        data = src.read_bytes()
        if args.routing_only and name == 'crates/prnext/src/server.rs':
            original = data.decode(); current = (ROOT / name).read_text()
            start = 'async fn handle_routed('; end = '\nasync fn request_worker('
            a, b = original.index(start), original.index(end)
            data = (original[:a] + current[current.index(start):current.index(end)] + original[b:]).encode()
        if args.size_policy_off and name == 'packages/prnext/runtime/profiles.json':
            profiles=json.loads(data)
            for profile in ['balanced','memory']:profiles[profile]['optimizeForSize']=False
            data=(json.dumps(profiles,indent=2)+'\n').encode()
        target.write_bytes(data); hashes[name] = sha(target)
    write(dest / 'source.json', {'createdAt': now(), 'name': args.name, 'baseCommit': baseline.get('baseCommit', '63847087826f178de3a32f165231b20b6c66b92e'), 'sourceSha256': hashes, 'sourceTreeDigest': digest(hashes), 'rustSourceDigest': digest({n:h for n,h in hashes.items() if n.startswith('crates/') or n in ['Cargo.toml','Cargo.lock','packages/prnext/runtime/profiles.json']}), 'baseline': args.baseline, 'routingOnly': args.routing_only,'sizePolicyOff':args.size_policy_off})
    print('snapshot', args.name, len(hashes), flush=True)

def build(args):
    windows_support()
    dest = OUT / 'candidates' / args.name
    assert not (dest / 'build.json').exists(), 'Build evidence already exists'
    provenance = json.loads((dest / 'source.json').read_text())
    for name, expected in provenance['sourceSha256'].items(): assert sha(dest/'source'/name) == expected, name
    command = ['cargo','build','--release','--locked','--manifest-path',str(dest/'source/Cargo.toml'), '--target-dir',str(ROOT/'target')]
    if args.mimalloc: command += ['--features', 'mimalloc']
    result = {'startedAt': now(), 'command': command, 'cwd': str(dest/'source'),
              'sourceTreeDigest': provenance['sourceTreeDigest'], 'features': ['mimalloc'] if args.mimalloc else []}
    start = time.monotonic(); server = None
    try:
        server = r.Server(command, str(dest/'source'), str(dest/'build.log'), [0,1,2,3,6,7], production=False)
        code = server.process.wait(timeout=1800)
        result.update(exitCode=code, accounting=server.sample(), rustc=subprocess.check_output(['rustc','--version'], text=True).strip())
        if code == 0:
            for name, expected in provenance['sourceSha256'].items(): assert sha(dest/'source'/name) == expected, 'Build changed source: '+name
            shutil.copy2(ROOT/'target/release/prnext.exe', dest/'prnext.exe'); result['binarySha256'] = sha(dest/'prnext.exe')
    except BaseException as error:
        result['error'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        try:
            if server is not None: server.close()
        finally:
            result.update(finishedAt=now(), elapsedSeconds=time.monotonic()-start)
            write(dest/'build.json', result)
    assert code == 0, result
    print('built', args.name, result['binarySha256'], flush=True)

def bench(args):
    windows_support()
    cfgpath = pathlib.Path(args.config).resolve(); cfg = json.loads(cfgpath.read_text())
    cpu_file = aggregate_cpu_path(cfg)
    if cpu_file is not None: read_live_observation(cpu_file, r.psutil.pid_exists)
    out = OUT/'experiments'/cfg['name']; out.mkdir(parents=True, exist_ok=False)
    write(out/'config.json', cfg); events = []
    def once(variant, repeat, attempt):
        label = f'{repeat+1:02d}-{variant["name"]}-attempt{attempt}'
        file = out/(label+'.json'); command = variant['command']
        binary = pathlib.Path(command[0]); cwd = str(pathlib.Path(variant.get('cwd', str(ROOT))).resolve())
        provenance = {'command':command, 'cwd':cwd, 'binarySha256':sha(binary), 'environment':variant.get('env', {}), 'nodeVersion':subprocess.check_output([str(NODE),'--version'],text=True).strip(), 'nodeSha256':sha(NODE), 'generatorSha256':sha(ROOT/'tests/performance/load.mjs'), 'configSha256':sha(cfgpath), 'serverCpu':cfg.get('serverCpu',10), 'generatorCpus':[8,9], 'startedAt':now(), 'variant':variant['name'], 'repeat':repeat+1, 'attempt':attempt, 'complete':False, 'results':[], 'runnerSha256':{name:sha(pathlib.Path(__file__).with_name(name)) for name in ['experiment-v5.py','measurement-v5.py','generator-cpu-v5.py','audit-v5.py','summarize-v5.py','windows-runner.py','static-probe.py','quiet-machine.py']}}
        # Hash the complete build inputs before load, not the mutable ISR cache.
        if '--build-dir' in command:
            project = pathlib.Path(command[command.index('start')+1]); builddir = project/command[command.index('--build-dir')+1]
            provenance['buildSha256']={f.relative_to(builddir).as_posix():sha(f) for f in sorted(builddir.rglob('*')) if f.is_file() and not any(x in f.relative_to(builddir).parts for x in ['cache','.cache'])}
        server = None; interfered = []
        try:
            attach_next_provenance(provenance)
            if cpu_file is not None: read_live_observation(cpu_file, r.psutil.pid_exists)
            write(file, provenance)
            server = r.Server(command, cwd, str(file)+'.log', cfg.get('serverCpu',10), variant.get('env'))
            for _ in range(300):
                try:
                    if cfg.get('readinessPath'):
                        # Binary-only fixtures need a body-free readiness check.
                        request = urllib.request.Request(cfg['url']+'/'+cfg['readinessPath'].lstrip('/'), method='HEAD')
                        with urllib.request.urlopen(request, timeout=2) as response:
                            if response.status != 200: raise RuntimeError('Readiness status '+str(response.status))
                    else:
                        r.get(cfg['url']+'/robots.txt')
                    break
                except Exception:
                    if server.process.poll() is not None: raise RuntimeError('Server exited: '+str(file)+'.log')
                    time.sleep(.1)
            else: raise TimeoutError('readiness')
            provenance['startup']=server.sample()
            for route, connections in cfg['scenarios']:
                for phase, seconds in [('warmup',cfg.get('warmup',10)),('measure',cfg.get('seconds',30))]:
                    stop=threading.Event(); observation_errors=[]
                    def observe():
                        try:
                            while not stop.is_set():
                                found=quiet.builds(r.psutil)
                                if found:interfered.append({'time':now(),'processes':found})
                                stop.wait(1)
                        except BaseException as error: observation_errors.append(error)
                    thread=threading.Thread(target=observe);thread.start()
                    try: row={'route':route,'connections':connections,'phase':phase,**measurement.measured(server,lambda:r.load(str(NODE),cfg['url']+'/'+route,seconds,connections))}
                    finally:stop.set();thread.join()
                    row['cpuMsPerResponse']=1000*row['cpuSeconds']/max(row['value']['count'],1)
                    row['generatorMayLimit']=row['value']['generatorCpuPercent']>85
                    row.update(p.virtual_memory(server));provenance['results'].append(row);write(file,provenance)
                    if observation_errors: raise RuntimeError('Build observer failed: '+str(observation_errors[0])) from observation_errors[0]
                    if cpu_file is not None:
                        row['aggregateGeneratorCpu']=aggregate_cpu_window(cpu_file,row,r.psutil.pid_exists)
                        row['aggregateGeneratorMayLimit']=row['aggregateGeneratorCpu']['contaminated']
                        write(file,provenance)
                        if contamination(row):
                            interfered.append({'time':now(),'reason':'aggregate generator CPU p95 exceeds 85%',
                                               'route':route,'phase':phase,'aggregateGeneratorCpu':row['aggregateGeneratorCpu']})
                    print(label,route,phase,round(row['value']['rps'],2),flush=True)
                    assert row['value']['errors']==0, row['value']
                    assert not row['generatorMayLimit'], 'Generator may limit this measurement'
                    if contamination(row): return False
            provenance['complete']=not interfered
        except BaseException as error:
            provenance['error']={'type':type(error).__name__,'message':str(error)}
            raise
        finally:
            try:
                if server is not None:
                    try: provenance['final']=server.sample()
                    finally: server.close()
            except BaseException as error:
                provenance['complete']=False
                provenance['error']={'type':type(error).__name__,'message':str(error)}
                raise
            finally:
                provenance['backgroundInterference']=interfered
                provenance['finishedAt']=now();write(file,provenance)
        return not interfered
    for repeat in range(cfg.get('repeats',3)):
        variants=cfg['variants'] if repeat%2==0 else cfg['variants'][::-1]
        for variant in variants:
            attempt=0
            while True:
                quiet.wait(r.psutil,events);write(out/'background.json',events);attempt+=1
                if once(variant,repeat,attempt):break
    write(out/'complete.json',{'complete':True,'finishedAt':now()})

if __name__=='__main__':
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest='operation',required=True)
    s=sub.add_parser('snapshot');s.add_argument('name');s.add_argument('--baseline',action='store_true');s.add_argument('--routing-only',action='store_true');s.add_argument('--size-policy-off',action='store_true')
    b=sub.add_parser('build');b.add_argument('name');b.add_argument('--mimalloc',action='store_true')
    b=sub.add_parser('bench');b.add_argument('config')
    args=parser.parse_args();globals()[args.operation](args)
