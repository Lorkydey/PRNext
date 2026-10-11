"""Opt-in Windows GC diagnostics. Run only in a reserved, otherwise quiet window.

Collects instrumented SSR on v4/no-size/final, balanced and memory. Refuses to
reuse an output directory. Full CPU/RSS comes from windows-runner's Job Object;
GC elapsed durations stay per-isolate and are never treated as CPU fractions.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import statistics
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / 'artifacts/performance-v5'
NODE = ROOT / 'artifacts/performance/node24/node.exe'
APP = ROOT / 'artifacts/performance/app'
OBSERVER = pathlib.Path(__file__).with_name('gc-observer-v5.cjs')
GENERATOR = pathlib.Path(__file__).with_name('load.mjs')
DEFAULTS = {
    'v4': (BASE / 'reference-v4/prnext-v4.exe', '.prnext-v4-final'),
    'no-size': (BASE / 'candidates/no-size/prnext.exe', '.prnext-v5-no-size'),
    'final': (BASE / 'prnext-v5.exe', '.prnext-v5-final'),
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def save(file, value):
    # Only the result of this newly-created run is updated; prior runs are immutable.
    file.write_text(json.dumps(value, indent=2), encoding='utf-8')


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def input_hashes(build):
    return {file.relative_to(build).as_posix(): sha(file) for file in sorted(build.rglob('*'))
            if file.is_file() and not any(part in ['cache', '.cache'] for part in file.relative_to(build).parts)}


def summarize(directory, start_ms, end_ms):
    """Use cumulative-counter deltas wholly inside the diagnostic wall window.

    Observer delivery is asynchronous, so the exact selected sample boundaries
    and coverage are exposed. Durations and heaps are NEVER summed over threads.
    """
    isolates = []
    for file in sorted(directory.glob('*.jsonl')):
        lines = file.read_text(encoding='utf-8').splitlines()
        rows = [json.loads(line) for line in lines]
        starts = [row for row in rows if row['event'] == 'start']
        if len(starts) != 1:
            raise ValueError('Missing/duplicate observer identity: ' + str(file))
        first = starts[0]
        previous = None
        previous_time = None
        for entry in rows:
            if any(entry.get(key) != first.get(key) for key in ['schema', 'runId', 'pid', 'threadId', 'isMainThread']):
                raise ValueError('Observer identity changed: ' + str(file))
            stamp = entry.get('unixMs')
            if not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or previous_time is not None and stamp < previous_time:
                raise ValueError('Invalid/non-monotonic observer timestamp: ' + str(file))
            previous_time = stamp
            if entry.get('event') not in ['sample', 'stop']:
                continue
            if entry.get('invalidEntries') != 0:
                raise ValueError('Invalid GC entries were observed: ' + str(file))
            counters = entry.get('gc')
            if not isinstance(counters, dict) or not counters or previous is not None and counters.keys() != previous.keys():
                raise ValueError('Missing/changing GC counters: ' + str(file))
            for kind, values in counters.items():
                count = values.get('count')
                if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                    raise ValueError('Invalid GC count: ' + str(file))
                for name in ['durationMs', 'maxDurationMs']:
                    value = values.get(name)
                    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                        raise ValueError('Invalid GC duration: ' + str(file))
                if values['maxDurationMs'] > values['durationMs'] + 1e-9:
                    raise ValueError('GC maximum exceeds cumulative duration: ' + str(file))
                if previous is not None and any(values[name] < previous[kind][name] for name in ['count', 'durationMs', 'maxDurationMs']):
                    raise ValueError('GC cumulative counter regressed: ' + str(file))
            previous = counters
        samples = [row for row in rows if row['event'] == 'sample' and start_ms <= row['unixMs'] <= end_ms]
        item = {key: first[key] for key in ['pid', 'threadId', 'isMainThread', 'node', 'v8', 'execArgv', 'environment', 'resourceLimits', 'v8CachedDataVersionTag', 'heapSizeLimit']}
        item.update(file=file.name, sha256=sha(file), bytes=file.stat().st_size, records=len(rows),
                    allSamples=sum(row['event'] == 'sample' for row in rows), windowSamples=len(samples),
                    stopReasons=[row['reason'] for row in rows if row['event'] == 'stop'],
                    limits=first['limits'], completeCoverage=False)
        if file.stat().st_size > first['limits']['maxBytes'] or len(rows) > first['limits']['maxRecords']:
            raise ValueError('Observer trace bounds exceeded: ' + str(file))
        if len(samples) >= 2:
            a, b = samples[0], samples[-1]
            coverage = (b['unixMs'] - a['unixMs']) / 1000
            item.update(sampleBeginUnixMs=a['unixMs'], sampleEndUnixMs=b['unixMs'], counterCoverageSeconds=coverage,
                        completeCoverage=coverage >= max(0, (end_ms - start_ms) / 1000 - 3),
                        gcDelta={name: {'count': b['gc'][name]['count'] - values['count'],
                                       'elapsedDurationMs': b['gc'][name]['durationMs'] - values['durationMs']}
                                 for name, values in a['gc'].items()},
                        heap={name: {'medianBytes': statistics.median(row['heap'][name] for row in samples),
                                     'maxBytes': max(row['heap'][name] for row in samples),
                                     'firstBytes': a['heap'][name], 'lastBytes': b['heap'][name]}
                              for name in ['heapUsed', 'heapTotal', 'external', 'arrayBuffers']})
        isolates.append(item)
    return {'isolates': isolates, 'hasHost': any(row['isMainThread'] for row in isolates),
            'hasWorker': any(not row['isMainThread'] for row in isolates),
            'limitations': ['GC duration is elapsed event duration, not CPU time; isolates/events may overlap.',
                            'Per-isolate heaps are not process RSS and are not summed in this summary.',
                            'Counters use the displayed sample boundaries; asynchronous observer delivery may lag GC events.',
                            'Forced Job shutdown need not run JS exit hooks; periodic records are the durable evidence.',
                            'All HTTP timing and resource measurements in this run include observer overhead.']}


def collect(args):
    if os.name != 'nt':
        raise RuntimeError('This runner requires Windows Job Objects')
    if args.cpu in args.generator_cpus:
        raise ValueError('Server and generator CPU sets must be disjoint')
    # Check every input before reserving output or starting any server.
    variants = []
    for name in args.variants:
        binary, build_name = DEFAULTS[name]
        if name == 'final' and args.final_binary:
            binary = pathlib.Path(args.final_binary).resolve()
        build = APP / build_name
        if not binary.is_file() or not (build / 'manifest.json').is_file():
            raise FileNotFoundError(f'{name}: binary/build not ready: {binary}, {build}')
        variants.append((name, binary, build_name, input_hashes(build)))
    for file in [NODE, OBSERVER, GENERATOR]:
        if not file.is_file():
            raise FileNotFoundError(file)
    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / 'scripts').mkdir()
    script_hashes = {}
    for file in [pathlib.Path(__file__), OBSERVER, GENERATOR,
                 pathlib.Path(__file__).with_name('windows-runner.py'), pathlib.Path(__file__).with_name('quiet-machine.py'),
                 pathlib.Path(__file__).with_name('measurement-v5.py')]:
        data = file.read_bytes()
        (out / 'scripts' / file.name).write_bytes(data)
        script_hashes[file.name] = hashlib.sha256(data).hexdigest()
    observer = out / 'scripts' / OBSERVER.name
    if '"' in str(observer):
        raise ValueError('Observer path contains a quote that NODE_OPTIONS cannot safely encode')
    sys.path.insert(0, str(ROOT / 'artifacts/performance/python'))
    runner = load_module('gc_windows_runner', 'windows-runner.py')
    measurement = load_module('gc_measurement_v5', 'measurement-v5.py')
    quiet = load_module('gc_quiet', 'quiet-machine.py')
    competing = quiet.builds(runner.psutil)
    if competing:
        save(out / 'refused.json', {'reason': 'Concurrent build', 'processes': competing})
        raise RuntimeError('Concurrent build detected; output preserved, choose a new run directory later')
    node_version = subprocess.check_output([str(NODE), '--version'], text=True).strip()
    if node_version != 'v24.19.0':
        raise RuntimeError('Exact Node v24.19.0 required, got ' + node_version)
    result = {'schema': 1, 'complete': False, 'diagnosticOnly': True, 'startedAt': now(),
              'invocation': sys.argv, 'scriptSha256': script_hashes, 'nodeSha256': sha(NODE), 'nodeVersion': node_version,
              'serverCpu': args.cpu, 'generatorCpus': args.generator_cpus, 'runs': [],
              'interpretation': 'Instrumented diagnostic only. No end-to-end gain may be inferred from these traces.'}
    save(out / 'result.json', result)
    url = f'http://127.0.0.1:{args.port}'
    try:
        for profile_index, profile in enumerate(args.profiles):
            # Reverse variant order for the second profile; do not combine profiles statistically.
            for name, binary, build_name, hashes in (variants if profile_index % 2 == 0 else variants[::-1]):
                label = f'{profile}-{name}'
                directory = out / label
                directory.mkdir(exist_ok=False)
                traces = directory / 'isolates'
                traces.mkdir()
                environment = {'NODE_OPTIONS': '--require "' + observer.as_posix() + '"',
                               'PRNEXT_GC_OBSERVER_DIR': str(traces), 'PRNEXT_GC_RUN_ID': label,
                               'PRNEXT_GC_MAX_FILES': '64', 'PRNEXT_GC_MAX_MILLIS': str(max(120000, (args.warmup + args.seconds + 60) * 1000))}
                command = [str(binary), 'start', str(APP), '--build-dir', build_name, '--node', str(NODE),
                           '--profile', profile, '--port', str(args.port)]
                row = {'label': label, 'profile': profile, 'variant': name, 'command': command,
                       'environment': environment, 'binarySha256': sha(binary), 'buildSha256': hashes,
                       'startedAt': now(), 'complete': False, 'phases': [], 'backgroundInterference': []}
                result['runs'].append(row)
                save(directory / 'result.json', row)
                server = runner.Server(command, str(APP), str(directory / 'server.log'), args.cpu, environment)
                try:
                    for _ in range(300):
                        try:
                            runner.get(url + '/robots.txt')
                            break
                        except Exception:
                            if server.process.poll() is not None:
                                raise RuntimeError('Server exited; see ' + str(directory / 'server.log'))
                            time.sleep(.1)
                    else:
                        raise TimeoutError('Server readiness')
                    for phase, seconds in [('warmup', args.warmup), ('diagnostic', args.seconds)]:
                        load_command = [str(NODE), str(GENERATOR), url + '/ssr', str(seconds), str(args.connections)]
                        stop = threading.Event()
                        def watch_builds():
                            while not stop.wait(1):
                                found = quiet.builds(runner.psutil)
                                if found:
                                    row['backgroundInterference'].append({'time': now(), 'processes': found})
                        def load():
                            env = {**os.environ}
                            env.pop('NODE_OPTIONS', None)
                            env.pop('PRNEXT_GC_OBSERVER_DIR', None)
                            with (directory / (phase + '.load.stdout.log')).open('xb') as stdout, (directory / (phase + '.load.stderr.log')).open('xb') as stderr:
                                child = subprocess.Popen(load_command, stdout=stdout, stderr=stderr, creationflags=0x08000000, env=env)
                                runner.psutil.Process(child.pid).cpu_affinity(args.generator_cpus)
                                try:
                                    code = child.wait(timeout=seconds + 80)
                                except BaseException:
                                    child.kill(); child.wait()
                                    raise
                            if code:
                                raise RuntimeError(f'Generator exited {code}; see {phase}.load.stderr.log')
                            return json.loads((directory / (phase + '.load.stdout.log')).read_text(encoding='utf-8'))
                        monitor = threading.Thread(target=watch_builds)
                        monitor.start()
                        begin = time.time() * 1000
                        try:
                            measured = measurement.measured(server, load, directory / 'job-samples.jsonl')
                        finally:
                            end = time.time() * 1000
                            stop.set(); monitor.join()
                        measured.update(phase=phase, command=load_command, beginUnixMs=begin, endUnixMs=end,
                                        cpuMsPerResponse=1000 * measured['cpuSeconds'] / max(measured['value']['count'], 1))
                        row['phases'].append(measured)
                        save(directory / 'result.json', row)
                        if measured['value']['errors']:
                            raise RuntimeError('Instrumented load returned errors')
                        if measured['value']['generatorCpuPercent'] > 85:
                            raise RuntimeError('Generator may limit diagnostic load')
                    # Let async observer callbacks produce their next bounded sample.
                    time.sleep(1.2)
                    row['finalJobAccounting'] = server.sample()
                finally:
                    try:
                        row['beforeJobTermination'] = server.sample()
                    finally:
                        server.close()
                    row['finishedAt'] = now()
                    diagnostics = [phase for phase in row['phases'] if phase['phase'] == 'diagnostic']
                    if diagnostics:
                        row['gc'] = summarize(traces, diagnostics[0]['beginUnixMs'], diagnostics[0]['endUnixMs'])
                    row['traceSha256'] = {file.name: sha(file) for file in sorted(traces.iterdir()) if file.is_file()}
                    row['buildUnchanged'] = input_hashes(APP / build_name) == hashes
                    save(directory / 'result.json', row)
                    save(out / 'result.json', result)
                if not row['gc']['hasHost'] or not row['gc']['hasWorker']:
                    raise RuntimeError('Missing host or RSC Worker observer: NODE_OPTIONS preload coverage failed')
                if any(not item['completeCoverage'] or any(reason != 'isolate-exit' for reason in item['stopReasons']) for item in row['gc']['isolates']):
                    raise RuntimeError('GC sample coverage incomplete; inspect retained traces')
                if row['backgroundInterference'] or not row['buildUnchanged']:
                    raise RuntimeError('Concurrent build or changed application build invalidates diagnostic')
                row['complete'] = True
                save(directory / 'result.json', row)
                save(out / 'result.json', result)
                print('GC diagnostic complete:', label, flush=True)
        result['complete'] = True
    except BaseException as error:
        result['error'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        result['finishedAt'] = now()
        save(out / 'result.json', result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='Explicitly start the instrumented HTTP campaign')
    parser.add_argument('--output', required=True)
    parser.add_argument('--variants', nargs='+', choices=list(DEFAULTS), default=list(DEFAULTS))
    parser.add_argument('--profiles', nargs='+', choices=['balanced', 'memory'], default=['balanced', 'memory'])
    parser.add_argument('--final-binary')
    parser.add_argument('--warmup', type=int, default=10)
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--connections', type=int, default=64)
    parser.add_argument('--cpu', type=int, default=10)
    parser.add_argument('--generator-cpus', type=int, nargs='+', default=[8, 9])
    parser.add_argument('--port', type=int, default=32960)
    args = parser.parse_args()
    if not args.execute:
        parser.error('Preparation only unless --execute is supplied in a reserved measurement window')
    if args.warmup < 1 or args.seconds < 5 or args.connections < 1:
        parser.error('warmup >= 1, seconds >= 5, connections >= 1 are required')
    collect(args)


if __name__ == '__main__':
    main()
