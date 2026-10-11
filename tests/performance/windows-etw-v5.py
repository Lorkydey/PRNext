"""Capture two local, instrumented static diagnostics after untraced v5 work.

Preparation does not launch anything: execution is only in main(). Requires WPT
already installed and an elevated session. Uses only a unique WPR instance; no
global cancellation, registry changes, service changes or symbol downloads.
Output defaults to performance-v5/etw/static-final and must not already exist.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import time
import traceback
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / 'artifacts/performance-v5'
WPR_DOC = 'https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options'


def sha(file):
    with pathlib.Path(file).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def read(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def write(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')
    temporary.replace(file)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def tree(folder):
    return {file.relative_to(folder).as_posix(): sha(file)
            for file in sorted(folder.rglob('*')) if file.is_file()
            and not any(part in ('cache', '.cache') for part in file.relative_to(folder).parts)}


def option(command, name):
    return command[command.index(name) + 1]


def plan(config_path, port):
    """Read-only preparation; tie the pair to frozen reference/final builds."""
    config = read(config_path)
    reference = read(BASE / 'reference-v4/reference.json')
    candidate = read(BASE / 'candidates/final/build.json')
    assert candidate.get('exitCode') == 0, 'Final native build has not succeeded'
    hashes = {'v4': reference['binarySha256'], 'v5': candidate['binarySha256']}
    assert hashes['v4'] != hashes['v5'], 'This diagnostic requires distinct native builds'
    variants = []
    assert len(config['variants']) == 2, 'Select a two-variant static final configuration'
    for variant in config['variants']:
        command = list(variant['command'])
        binary = pathlib.Path(command[0]).resolve()
        digest = sha(binary)
        label = next((name for name, expected in hashes.items() if expected == digest), None)
        assert label is not None, 'Configuration binary is not the frozen v4/final v5 build'
        project = pathlib.Path(command[command.index('start') + 1]).resolve()
        build = (project / option(command, '--build-dir')).resolve()
        node = pathlib.Path(option(command, '--node')).resolve()
        command[command.index('--port') + 1] = str(port)
        if '--hostname' in command:
            command[command.index('--hostname') + 1] = '127.0.0.1'
        else:
            command.extend(['--hostname', '127.0.0.1'])
        manifest = read(build / 'manifest.json')
        page = next(row for row in manifest['prerendered'] if row['path'] == '/pages-static')
        identity = (build / page['file']).resolve()
        assert identity.is_relative_to(build), 'Page path escapes build directory'
        gzip = pathlib.Path(str(identity) + '.gz')
        assert gzip.is_file(), 'The static control must have a precompressed representation'
        variants.append({'label': label, 'variant': variant['name'], 'command': command,
                         'cwd': variant['cwd'], 'environment': variant.get('env', {}),
                         'binarySha256': digest, 'nodeSha256': sha(node), 'node': str(node),
                         'build': str(build), 'buildSha256': tree(build),
                         'public': str(project / 'public'), 'publicSha256': tree(project / 'public'),
                         'identity': str(identity), 'wireRepresentation': str(gzip),
                         'identitySha256': sha(identity), 'wireSha256': sha(gzip),
                         'wireBytes': gzip.stat().st_size})
    assert {item['label'] for item in variants} == {'v4', 'v5'}, 'Missing reference/final pair'
    variants.sort(key=lambda item: item['label'])
    assert len({item['wireSha256'] for item in variants}) == 1, 'Static wire bytes differ'
    return {'config': str(config_path), 'configSha256': sha(config_path),
            'referenceManifestSha256': sha(BASE / 'reference-v4/reference.json'),
            'candidateBuildManifestSha256': sha(BASE / 'candidates/final/build.json'),
            'variants': variants}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=pathlib.Path, default=BASE / 'configs/final-static.json')
    parser.add_argument('--output-name', default='static-final')
    parser.add_argument('--port', type=int, default=32960)
    parser.add_argument('--seconds', type=int, default=10)
    parser.add_argument('--server-cpu', type=int, default=10)
    parser.add_argument('--execute', action='store_true', help='Explicitly start the local diagnostic pair')
    args = parser.parse_args()
    assert args.execute, 'Preparation only by default; use --execute during a scheduled quiet window'
    assert 1 <= args.seconds <= 30 and 1024 <= args.port <= 65535
    assert args.output_name and pathlib.PurePath(args.output_name).name == args.output_name
    assert args.output_name not in ('.', '..') and not any(c in args.output_name for c in ('/', '\\', ':'))
    assert os.name == 'nt', 'This diagnostic is Windows-only'
    wpr, xperf = shutil.which('wpr'), shutil.which('xperf')
    assert wpr and xperf, 'WPT must already be installed; this script does not install or configure it'
    prepared = plan(args.config.resolve(), args.port)
    out = BASE / 'etw' / args.output_name
    out.mkdir(parents=True, exist_ok=False)
    write(out / 'plan.json', prepared)
    spec = importlib.util.spec_from_file_location('etw_probe_v5', pathlib.Path(__file__).with_name('static-probe.py'))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    runner = probe.r
    runner.psutil.Process().cpu_affinity([0])
    url = 'http://127.0.0.1:' + str(args.port)
    overall = {'complete': False, 'generation': 'v5', 'instrumented': True, 'startedAt': now(),
               'configSha256': prepared['configSha256'], 'labels': [], 'commands': [],
               'wprDocumentation': WPR_DOC, 'wprSha256': sha(wpr), 'xperfSha256': sha(xperf),
               'scriptsSha256': {name: sha(pathlib.Path(__file__).with_name(name)) for name in
                                 ('windows-etw-v5.py', 'windows-runner.py', 'static-probe.py', 'load.mjs')}}

    def call(command, label, timeout=120):
        entry = {'command': command, 'startedAt': now()}
        overall['commands'].append(entry)
        try:
            result = subprocess.run(command, capture_output=True, timeout=timeout, creationflags=0x08000000)
            (out / (label + '.stdout')).write_bytes(result.stdout)
            (out / (label + '.stderr')).write_bytes(result.stderr)
            entry.update(exitCode=result.returncode, finishedAt=now(), stdout=label + '.stdout', stderr=label + '.stderr')
            assert result.returncode == 0, (label, result.returncode, result.stderr.decode(errors='replace'))
            return result
        finally:
            write(out / 'result.json', overall)

    def load(node, label, seconds):
        command = [node, str(pathlib.Path(__file__).with_name('load.mjs')), url + '/pages-static', str(seconds), '32']
        entry = {'command': command, 'startedAt': now(), 'cpus': [8, 9]}
        overall['commands'].append(entry)
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        try:
            runner.psutil.Process(child.pid).cpu_affinity([8, 9])
            stdout, stderr = child.communicate(timeout=seconds + 80)
        except BaseException:
            child.kill()
            child.wait()
            raise
        finally:
            entry['finishedAt'] = now()
        (out / (label + '.stdout')).write_bytes(stdout)
        (out / (label + '.stderr')).write_bytes(stderr)
        entry.update(exitCode=child.returncode, stdout=label + '.stdout', stderr=label + '.stderr')
        write(out / 'result.json', overall)
        assert child.returncode == 0, label + ': generator failed'
        value = json.loads(stdout)
        assert value['errors'] == 0 and value['count'] > 0 and value['started'] == value['count'], value
        assert value['statuses'] == {'200': value['count']} and value['generatorCpuPercent'] <= 85, value
        return value

    try:
        for variant in prepared['variants']:
            label = variant['label']
            server = runner.Server(variant['command'], variant['cwd'], str(out / (label + '.server.log')),
                                   args.server_cpu, variant['environment'])
            instance = 'PRNextV5_' + str(os.getpid()) + '_' + uuid.uuid4().hex + '_' + label
            started = False
            record = {**variant, 'complete': False, 'instrumented': True, 'route': 'pages-static', 'connections': 32,
                      'startedAt': now(), 'nativePid': server.process.pid, 'traceInstance': instance,
                      'serverCpu': args.server_cpu, 'generatorCpus': [8, 9], 'durationSeconds': args.seconds}
            try:
                for attempt in range(200):
                    try:
                        runner.get(url + '/robots.txt')
                        break
                    except Exception:
                        if server.process.poll() is not None or attempt == 199:
                            raise RuntimeError('Static server did not become ready; see server log')
                        time.sleep(.1)
                record['warmup'] = load(variant['node'], label + '-warmup', 10)
                record['processesBeforeTrace'] = server.sample()
                assert not any(name.lower() == 'node.exe' for _, name in record['processesBeforeTrace']['pids'])
                command = [wpr, '-start', 'CPU.light', '-start', 'FileIO.light', '-start', 'Network.light',
                           '-filemode', '-recordtempto', str(out), '-instancename', instance]
                started = True  # A partially successful start also requires scoped cleanup.
                call(command, label + '-start')
                record['load'] = runner.measured(server, lambda: load(variant['node'], label + '-load', args.seconds))
                record['load']['cpuMsPerResponse'] = record['load']['cpuSeconds'] * 1000 / record['load']['value']['count']
                call([wpr, '-status', 'collectors', '-details', '-instancename', instance], label + '-status')
            finally:
                try:
                    if started:
                        try:
                            call([wpr, '-stop', str(out / (label + '.etl')), 'PRNext v5 diagnostic only',
                                  '-skipPdbGen', '-instancename', instance], label + '-stop')
                        except BaseException:
                            call([wpr, '-cancel', '-instancename', instance], label + '-cancel')
                            raise
                finally:
                    try:
                        record['finalProcessSample'] = server.sample()
                    finally:
                        try:
                            server.close()
                        finally:
                            write(out / (label + '.json'), record)
            for action, extra in [('profile', ['-detail']), ('diskio', ['-summary']), ('tracestats', []), ('dumper', [])]:
                call([xperf, '-i', str(out / (label + '.etl')), '-o', str(out / (label + '-' + action + '.csv')),
                      '-a', action, *extra], label + '-export-' + action)
            assert sha(variant['command'][0]) == variant['binarySha256'], 'Binary changed during diagnostic'
            assert tree(pathlib.Path(variant['build'])) == variant['buildSha256'], 'Build changed during diagnostic'
            assert tree(pathlib.Path(variant['public'])) == variant['publicSha256'], 'Public files changed during diagnostic'
            assert record['load']['processesStarted'] == 0, 'Unexpected process start during static load'
            record.update(complete=True, finishedAt=now())
            record['exportsSha256'] = {path.name: sha(path) for path in out.glob(label + '-*.csv')}
            record['etlSha256'] = sha(out / (label + '.etl'))
            write(out / (label + '.json'), record)
            overall['labels'].append(label)
            write(out / 'result.json', overall)
            print(label, 'ETW captured and exported; attribution remains to be analysed', flush=True)
        overall['complete'] = True
    except BaseException:
        overall['error'] = traceback.format_exc()
        raise
    finally:
        overall['finishedAt'] = now()
        write(out / 'result.json', overall)


if __name__ == '__main__':
    main()
