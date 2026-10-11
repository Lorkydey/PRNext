"""Compile/run the std-only public-file probe during an explicitly scheduled gap.

No import-time execution. Preserves source, compiler command, JSONL counters and
Job CPU including terminated processes. Does not edit production or fixtures.
"""
import argparse
import collections
import datetime
import hashlib
import importlib.util
import json
import pathlib
import shutil
import statistics
import subprocess
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / 'artifacts/performance-v5/experiments/public-probe'


def sha(file):
    with pathlib.Path(file).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')
    temporary.replace(file)


def fixture_hashes(root):
    return {file.relative_to(root).as_posix(): sha(file) for file in sorted(root.rglob('*')) if file.is_file()}


def summarize(rows, rounds, iterations):
    assert rows[0]['type'] == 'environment' and rows[-1].get('complete') is True
    trials = [row for row in rows if row.get('type') == 'trial']
    assert len(trials) == rows[-1]['trials'] == 3 * 4 * rounds
    assert len({(row['round'], row['case'], row['variant']) for row in trials}) == len(trials)
    groups = collections.defaultdict(list)
    for row in trials:
        counts = row['counters']
        assert row['iterations'] == iterations and counts['permissionDenied'] == counts['otherErrors'] == 0
        assert counts['found'] == (iterations if row['present'] else 0)
        assert counts['notFound'] + counts['notDirectory'] == (0 if row['present'] else iterations)
        assert abs(row['nsPerOperation'] - row['elapsedNs'] / iterations) < .000001
        variant = row['variant']
        assert counts['pathMetadataCalls'] == (iterations if variant in ('metadata', 'metadata_then_open_handle_metadata') else 0)
        assert counts['openCalls'] == (0 if variant == 'metadata' or variant == 'metadata_then_open_handle_metadata' and not row['present'] else iterations)
        assert counts['handleMetadataCalls'] == (iterations if row['present'] and variant in ('open_handle_metadata', 'metadata_then_open_handle_metadata') else 0)
        groups[(row['case'], variant)].append(row['nsPerOperation'])
    assert len(groups) == 12 and all(len(values) == rounds for values in groups.values())
    return [{'case': case, 'variant': variant, 'rounds': len(values), 'iterationsPerRound': iterations,
             'wallNsPerOperation': {'median': statistics.median(values), 'min': min(values), 'max': max(values), 'values': values}}
            for (case, variant), values in sorted(groups.items())]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-root', type=pathlib.Path, default=ROOT / 'artifacts/performance/app/public')
    parser.add_argument('--output-name', default='first')
    parser.add_argument('--iterations', type=int, default=10_000)
    parser.add_argument('--rounds', type=int, default=8)
    parser.add_argument('--cpu', type=int, default=10)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    assert args.execute, 'Use --execute only in an authorized quiet interval'
    assert args.output_name not in ('', '.', '..') and not any(c in args.output_name for c in '/\\:')
    assert 1_000 <= args.iterations <= 1_000_000 and 4 <= args.rounds <= 32 and args.rounds % 4 == 0
    out = BASE / args.output_name
    out.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('public_probe_windows', pathlib.Path(__file__).with_name('static-probe.py'))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    runner = probe.r
    runner.psutil.Process().cpu_affinity([0])
    source = pathlib.Path(__file__).with_suffix('.rs')
    shutil.copyfile(source, out / source.name)
    source = out / source.name
    binary = out / 'public-probe-v5.exe'
    fixture = args.public_root.resolve()
    result = {'complete': False, 'startedAt': now(), 'sourceSha256': sha(source),
              'runnerSha256': sha(pathlib.Path(__file__)), 'publicRoot': str(fixture),
              'fixtureBeforeSha256': fixture_hashes(fixture), 'cpu': args.cpu,
              'rustcVersion': subprocess.check_output(['rustc', '--version'], text=True).strip(),
              'compileCommand': ['rustc', '--edition=2021', '-C', 'opt-level=3', '-C', 'debuginfo=0', str(source), '-o', str(binary)],
              'method': 'Mechanism microbenchmark, not HTTP throughput. Wall time per filesystem probe; Job CPU covers all trials, warmup and process startup/exit, not individual trial CPU.'}
    try:
        start = time.perf_counter()
        built = subprocess.run(result['compileCommand'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, creationflags=0x08000000)
        (out / 'compile.stdout').write_bytes(built.stdout)
        (out / 'compile.stderr').write_bytes(built.stderr)
        result.update(compileExitCode=built.returncode, compileSeconds=time.perf_counter() - start)
        write(out / 'result.json', result)
        assert built.returncode == 0, 'Standalone probe compilation failed'
        result['binarySha256'] = sha(binary)
        command = [str(binary), str(fixture), str(out / 'raw.jsonl'), str(args.iterations), str(args.rounds)]
        result['command'] = command
        process = runner.Server(command, str(ROOT), str(out / 'process.log'), args.cpu, production=False)
        try:
            result['initialJobSample'] = process.sample()
            start = time.perf_counter()
            result['exitCode'] = process.process.wait(timeout=240)
            result['wallSeconds'] = time.perf_counter() - start
            result['finalJobSample'] = process.sample()
        finally:
            process.close()
        assert result['exitCode'] == 0, 'Probe failed; partial raw JSONL and logs retained'
        result['rawSha256'] = sha(out / 'raw.jsonl')
        rows = [json.loads(line) for line in (out / 'raw.jsonl').read_text(encoding='utf-8').splitlines()]
        result['groups'] = summarize(rows, args.rounds, args.iterations)
        result['fixtureAfterSha256'] = fixture_hashes(fixture)
        assert result['fixtureAfterSha256'] == result['fixtureBeforeSha256'], 'Public fixture changed'
        assert sha(binary) == result['binarySha256'] and sha(source) == result['sourceSha256'], 'Probe changed'
        result['complete'] = True
    except BaseException:
        result['error'] = traceback.format_exc()
        raise
    finally:
        result['finishedAt'] = now()
        write(out / 'result.json', result)
    print(json.dumps({'output': str(out), 'complete': True, 'groups': len(result['groups'])}))


if __name__ == '__main__':
    main()
