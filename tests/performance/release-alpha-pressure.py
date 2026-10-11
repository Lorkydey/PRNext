"""Bounded release follow-up; immutable V5/V6 binaries, fixtures and load driver.

Keep every run, including OOMs. No relaxed budget or admission bypass. The
instrumented diagnostic is distinct from the original uninstrumented scenario.
"""
import argparse
import importlib.util
import json
import pathlib
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('campaign', HERE / 'campaign-v6.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
REFERENCE = c.OUT
OUTPUT = c.ROOT / 'artifacts/release-0.1.12-alpha'
original_commands = c.commands


def commands(*args, **kwargs):
    c.OUT = REFERENCE
    try:
        rows = original_commands(*args, **kwargs)
    finally:
        c.OUT = OUTPUT
    if candidate and args[0] == 'candidate':
        for row in rows:
            row['command'][0] = str(candidate)
    return rows


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['reproduce', 'diagnose', 'defaults'])
    parser.add_argument('--candidate', type=pathlib.Path)
    parser.add_argument('--prefix', default='release')
    args = parser.parse_args()
    candidate = args.candidate.resolve() if args.candidate else None
    c.commands = commands
    c.OUT = OUTPUT
    OUTPUT.mkdir(parents=True, exist_ok=True)
    c.g.r.psutil.Process().cpu_affinity([0, 1])
    record = {'complete': False, 'mode': args.mode, 'startedAt': time.time(), 'runs': []}
    destination = OUTPUT / (args.prefix + '-' + args.mode + '.json')
    assert not destination.exists(), 'Never replace an earlier attempt'
    try:
        if args.mode == 'diagnose':
            for variant in ['v5', 'v6']:
                label = f'{args.prefix}-diagnostic-{variant}'
                folder = OUTPUT / 'multi' / label
                rows = commands(variant, 'balanced-small', 8, 33100, folder, True)
                server = c.g.Group(rows, folder, 10, 1024)
                result = {'commands': rows, 'binarySha256': c.sha(pathlib.Path(rows[0]['command'][0])), 'phases': []}
                def phase(name, fn):
                    value = {'phase': name, **c.g.m.measured(server, fn, folder / 'resources.jsonl', .1)}
                    result['phases'].append(value)
                    return value
                urls = [f'http://127.0.0.1:{33100+i}' for i in range(8)]
                try:
                    phase('startup-static-readiness', lambda: c.ready(urls))
                    phase('cold-dynamic-burst', lambda: c.g.load({'seconds': 5, 'apps': c.targets(urls, 'all')}, folder / 'cold'))
                    phase('load', lambda: c.g.load({'seconds': 20, 'apps': c.targets(urls, 'all')}, folder / 'all'))
                    phase('drained', lambda: time.sleep(5))
                    result['complete'] = True
                finally:
                    result['final'] = server.sample()
                    server.close()
                    (folder / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
                record['runs'].append(label)
        else:
            variants = ['v5', 'candidate' if candidate else 'v6']
            cases = [('balanced-small', 1024)] if args.mode == 'reproduce' else [('balanced', 2048), ('memory', 1024)]
            for repeat in range(1, 4):
                for profile, budget in cases:
                    for variant in variants[::1 if repeat % 2 else -1]:
                        label = f'{args.prefix}-r{repeat}-8apps-{budget}MiB-{profile}-{variant}'
                        result = c.once(label, variant, profile, 8, budget, 20, modes=('all',))
                        record['runs'].append({'label': label, 'complete': result['complete']})
                        destination.write_text(json.dumps(record, indent=2), encoding='utf-8')
        record['complete'] = True
    finally:
        record['finishedAt'] = time.time()
        destination.write_text(json.dumps(record, indent=2), encoding='utf-8')
