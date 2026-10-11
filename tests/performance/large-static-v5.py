"""Create an isolated large public-file fixture; opt-in byte checks precede HTTP load.

prepare writes files/config only. check starts each frozen native variant briefly;
it never benchmarks and refuses to overwrite earlier evidence.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import pathlib
import shutil
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / 'artifacts/performance-v5'
APP = BASE / 'large-static-app'
CONFIG = BASE / 'configs/large-static.json'
NODE = ROOT / 'artifacts/performance/node24/node.exe'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(path):
    return {p.relative_to(path).as_posix(): sha(p) for p in sorted(path.rglob('*')) if p.is_file()}


def write(path, data):
    with path.open('x', encoding='utf-8') as output:
        output.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def prepare():
    if APP.exists() or CONFIG.exists():
        raise FileExistsError('Fixture/config already exists; no overwrite is permitted.')
    source_app = ROOT / 'artifacts/performance-v4/static-app'
    frozen = BASE / 'reference-v4/static-build'
    frozen_hashes = tree(frozen)
    reference = json.loads((BASE / 'reference-v4/reference.json').read_text(encoding='utf-8'))
    expected = reference['staticBuild']
    if frozen_hashes != expected:
        raise ValueError('Frozen v4 static build differs from the reference manifest.')
    APP.mkdir()
    shutil.copytree(frozen, APP / '.prnext-static')
    for name in ('package.json', 'next.config.mjs'):
        shutil.copy2(source_app / name, APP / name)
    shutil.copytree(source_app / 'pages', APP / 'pages')
    public = APP / 'public'
    public.mkdir()
    # Deterministic content; no compression sidecars, caches, symlinks or aliases.
    block = b''.join(hashlib.sha256(b'PRNext large fixture v5\0' + i.to_bytes(4, 'little')).digest() for i in range(2048))
    for name, size in [('large256.bin', 256 * 1024), ('large2m.bin', 2 * 1024 * 1024)]:
        (public / name).write_bytes((block * ((size + len(block) - 1) // len(block)))[:size])
    variants = []
    for name, binary in [('v4-balanced', BASE / 'reference-v4/prnext-v4.exe'),
                         ('handles-balanced', BASE / 'candidates/handles/prnext.exe'),
                         ('native2-balanced', BASE / 'candidates/native2/prnext.exe')]:
        variants.append({'name': name, 'cwd': str(APP), 'command': [str(binary), 'start', str(APP),
                         '--build-dir', '.prnext-static', '--node', str(NODE), '--hostname', '127.0.0.1',
                         '--port', '32900', '--profile', 'balanced']})
    cfg = {'name': 'large-static', 'url': 'http://127.0.0.1:32900', 'serverCpu': 10,
           'warmup': 5, 'seconds': 15, 'repeats': 2,
           'scenarios': [['large256.bin', 8], ['large2m.bin', 8]], 'variants': variants,
           'purpose': 'Exploratory large public-file fallback; no App/ISR direct-path attribution.',
           'preflight': 'python tests/performance/large-static-v5.py check --output artifacts/performance-v5/experiments/large-static-bytecheck'}
    write(CONFIG, cfg)
    build_hashes = tree(APP / '.prnext-static')
    if build_hashes != frozen_hashes:
        raise ValueError('Copied build changed.')
    evidence = {'complete': True, 'kind': 'fixture-only-no-server-executed', 'createdAt': now(),
                'sourceApp': str(source_app), 'sourceBuild': str(frozen),
                'referenceSha256': sha(BASE / 'reference-v4/reference.json'),
                'generator': str(pathlib.Path(__file__).resolve()), 'generatorSha256': sha(pathlib.Path(__file__)),
                'app': str(APP), 'sourceSha256': {p.relative_to(APP).as_posix(): sha(p) for p in sorted(APP.rglob('*')) if p.is_file() and '.prnext-static' not in p.parts},
                'buildSha256': build_hashes, 'config': str(CONFIG), 'configSha256': sha(CONFIG),
                'publicFiles': {p.name: {'length': p.stat().st_size, 'sha256': sha(p)} for p in sorted(public.iterdir())}}
    write(APP / 'fixture.json', evidence)
    print(json.dumps({'fixture': str(APP), 'config': str(CONFIG), 'files': evidence['publicFiles']}))


def check(output):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    cfg = json.loads(CONFIG.read_text(encoding='utf-8'))
    fixture = json.loads((APP / 'fixture.json').read_text(encoding='utf-8'))
    if sha(CONFIG) != fixture['configSha256'] or tree(APP / '.prnext-static') != fixture['buildSha256']:
        raise ValueError('Fixture/config changed before byte checks.')
    spec = importlib.util.spec_from_file_location('static_probe', pathlib.Path(__file__).with_name('static-probe.py'))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    rows = []
    result = {'complete': False, 'startedAt': now(), 'checks': rows, 'fixtureSha256': sha(APP / 'fixture.json'),
              'scriptSha256': sha(pathlib.Path(__file__)), 'configSha256': sha(CONFIG), 'nodeSha256': sha(NODE)}
    try:
        for variant in cfg['variants']:
            binary = pathlib.Path(variant['command'][0])
            row = {'variant': variant['name'], 'command': variant['command'], 'cwd': variant['cwd'],
                   'binarySha256': sha(binary), 'checks': [], 'passed': False}
            rows.append(row)
            server = probe.r.Server(variant['command'], variant['cwd'], str(output / (variant['name'] + '.log')), 10)
            try:
                for attempt in range(100):
                    try:
                        with urllib.request.urlopen(urllib.request.Request(cfg['url'] + '/large256.bin', method='HEAD'), timeout=.5):
                            break
                    except (OSError, urllib.error.URLError):
                        if attempt == 99:
                            raise
                        time.sleep(.1)
                for name, expected in fixture['publicFiles'].items():
                    local = (APP / 'public' / name).read_bytes()
                    if hashlib.sha256(local).hexdigest() != expected['sha256']:
                        raise ValueError('Fixture public bytes changed: ' + name)
                    for method, extra, wanted in [('GET', {}, local), ('HEAD', {}, b''),
                                                 ('GET', {'Range': 'bytes=17-1039'}, local[17:1040])]:
                        headers = {'Accept-Encoding': 'identity', **extra}
                        with urllib.request.urlopen(urllib.request.Request(cfg['url'] + '/' + name, headers=headers, method=method), timeout=10) as response:
                            body = response.read(expected['length'] + 1)
                            status = 206 if extra else 200
                            if response.status != status or body != wanted:
                                raise ValueError('HTTP status/body mismatch: ' + variant['name'] + '/' + name)
                            if int(response.headers['Content-Length']) != (expected['length'] if method == 'HEAD' else len(wanted)):
                                raise ValueError('Content-Length mismatch.')
                            row['checks'].append({'file': name, 'method': method, 'requestHeaders': headers,
                                                  'status': response.status, 'bytes': len(body),
                                                  'bodySha256': hashlib.sha256(body).hexdigest(), 'passed': True})
                row['finalSample'] = server.sample()
                row['passed'] = True
            finally:
                server.close()
        result['complete'] = True
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        result['finishedAt'] = now()
        write(output / 'result.json', result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'check'])
    parser.add_argument('--output', type=pathlib.Path, default=BASE / 'experiments/large-static-bytecheck')
    args = parser.parse_args()
    prepare() if args.mode == 'prepare' else check(args.output)
