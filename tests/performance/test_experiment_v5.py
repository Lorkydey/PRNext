"""Synthetic runner branches: no server, compiler, traffic or OS accounting."""
import copy
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('experiment_v5_test', HERE / 'experiment-v5.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def put(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value) if not isinstance(value, str) else value, encoding='utf-8')


def sample(begin=1000, end=2000, a=20, b=20):
    return {'event': 'sample', 'beginUnixMs': begin, 'endUnixMs': end,
            'cpuPercent': {'8': a, '9': b}, 'logicalCpuSumPercent': a + b}


class CpuWindowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.file = pathlib.Path(self.temp.name) / 'cpu.jsonl'
        self.start = {'event': 'start', 'schema': 1, 'thresholdPercent': 85, 'pid': 123, 'cpus': [8, 9],
                      'observerSha256': runner.sha(HERE / 'generator-cpu-v5.py')}
        self.row = {'before': {'time': 1}, 'after': {'time': 2}}

    def write(self, *rows, suffix=''):
        self.file.write_text('\n'.join(json.dumps(row) for row in [self.start, *rows]) + '\n' + suffix, encoding='utf-8')

    def test_seconds_to_ms_and_complete_prefix_are_recorded(self):
        self.write(sample(), suffix='{"event":')
        value = runner.aggregate_cpu_window(self.file, self.row, lambda pid: pid == 123)
        self.assertEqual((value['beginUnixMs'], value['endUnixMs']), (1000, 2000))
        self.assertTrue(value['valid'])
        proof = value['observation']; raw = self.file.read_bytes()[:proof['prefixBytes']]
        self.assertEqual(proof['prefixSha256'], runner.hashlib.sha256(raw).hexdigest())
        self.assertEqual(proof['start'], self.start)

    def test_waits_for_last_interval_but_not_longer_than_deadline(self):
        self.write(sample(end=1500)); clock = [0]
        def sleep(seconds):
            clock[0] += seconds
            self.write(sample(end=1500), sample(begin=1500))
        value = runner.aggregate_cpu_window(self.file, self.row, lambda _: True, clock=lambda: clock[0], sleep=sleep)
        self.assertTrue(value['completeCoverage']); self.assertGreater(clock[0], 0)
        self.write(sample(end=1500)); clock[0] = 0
        with self.assertRaisesRegex(RuntimeError, 'coverage is incomplete'):
            runner.aggregate_cpu_window(self.file, self.row, lambda _: True, timeout=.2,
                                        clock=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        self.assertLessEqual(clock[0], .2)

    def test_absent_dead_invalid_and_stopped_observers_fail(self):
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            runner.read_live_observation(self.file, lambda _: True)
        self.write(sample())
        with self.assertRaisesRegex(RuntimeError, 'not alive'):
            runner.read_live_observation(self.file, lambda _: False)
        self.write(sample(), {'event': 'stop'})
        with self.assertRaisesRegex(RuntimeError, 'stopped or failed'):
            runner.read_live_observation(self.file, lambda _: True)
        self.write(sample()); self.file.write_text(self.file.read_text() + '{broken}\n')
        with self.assertRaisesRegex(RuntimeError, 'invalid JSONL'):
            runner.read_live_observation(self.file, lambda _: True)

    def test_only_measurement_contamination_requires_replay(self):
        self.write(sample(a=60, b=60))
        value = runner.aggregate_cpu_window(self.file, self.row, lambda _: True)
        self.assertTrue(value['contaminated'])
        self.assertFalse(runner.contamination({'phase': 'warmup', 'aggregateGeneratorCpu': value}))
        self.assertTrue(runner.contamination({'phase': 'measure', 'aggregateGeneratorCpu': value}))
        self.assertFalse(runner.contamination({'phase': 'measure'}))

    def test_legacy_config_is_optional_but_enforcement_requires_observer(self):
        self.assertIsNone(runner.aggregate_cpu_path({}))
        with self.assertRaisesRegex(ValueError, 'requires generatorCpuFile'):
            runner.aggregate_cpu_path({'enforceAggregateGeneratorCpu': True})
        self.assertEqual(runner.aggregate_cpu_path({'generatorCpuFile': 'cpu.jsonl'}), (runner.OUT / 'cpu.jsonl').resolve())


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name); self.out = self.root / 'evidence'; self.out.mkdir()
        self.node = self.root / 'artifacts/performance/node24/node.exe'; put(self.node, 'node')
        self.binary = self.root / 'native.exe'; put(self.binary, 'native')
        put(self.root / 'tests/performance/load.mjs', 'generator')
        for name, value in [('ROOT', self.root), ('OUT', self.out), ('NODE', self.node)]:
            patch = mock.patch.object(runner, name, value); patch.start(); self.addCleanup(patch.stop)
        self.servers = []
        outer = self
        class Server:
            def __init__(self, *args, **kwargs):
                self.process = types.SimpleNamespace(poll=lambda: None, wait=lambda **_: 1)
                self.closed = False; outer.servers.append(self)
            def sample(self): return {'time': 2, 'cpuSeconds': 1, 'rssMiB': 1, 'totalProcesses': 1}
            def close(self): self.closed = True
        runtime = types.SimpleNamespace(Server=Server, get=lambda _: None, psutil=types.SimpleNamespace(pid_exists=lambda _: True), load=lambda *_: {'count': 10, 'errors': 0, 'rps': 10, 'generatorCpuPercent': 1})
        for target, name, value in [(runner, 'r', runtime), (runner, 'p', types.SimpleNamespace(virtual_memory=lambda _: {})),
                                    (runner.quiet, 'wait', lambda *_: None), (runner.quiet, 'builds', lambda *_: []),
                                    (runner.subprocess, 'check_output', lambda *_a, **_k: 'v24.19.0\n')]:
            patch = mock.patch.object(target, name, value); patch.start(); self.addCleanup(patch.stop)

    def config(self, **extra):
        cfg = {'name': 'synthetic', 'url': 'unused', 'warmup': 1, 'seconds': 1, 'repeats': 1,
               'scenarios': [['ssr', 1]], 'variants': [{'name': 'native', 'command': [str(self.binary)], 'cwd': str(self.root)}], **extra}
        file = self.out / 'input.json'; put(file, cfg)
        return types.SimpleNamespace(config=str(file))

    @staticmethod
    def measured(_server, fn):
        return {'value': fn(), 'before': {'time': 1}, 'after': {'time': 2}, 'cpuSeconds': .1}

    def test_contaminated_attempt_is_retained_and_whole_variant_replayed(self):
        args = self.config(generatorCpuFile='cpu.jsonl', enforceAggregateGeneratorCpu=True)
        values = [{'contaminated': value} for value in [True, True, True, False]]
        with mock.patch.object(runner, 'read_live_observation', return_value=([], {})), \
             mock.patch.object(runner, 'aggregate_cpu_window', side_effect=values), \
             mock.patch.object(runner.measurement, 'measured', side_effect=self.measured) as measure:
            runner.bench(args)
        folder = self.out / 'experiments/synthetic'
        first = json.loads((folder / '01-native-attempt1.json').read_text())
        second = json.loads((folder / '01-native-attempt2.json').read_text())
        self.assertFalse(first['complete']); self.assertTrue(first['backgroundInterference'])
        self.assertTrue(second['complete']); self.assertEqual(measure.call_count, 4)
        self.assertEqual(second['cwd'], str(self.root.resolve()))
        self.assertTrue(all(server.closed for server in self.servers))

    def test_sampler_error_retains_failure_and_closes_job(self):
        with mock.patch.object(runner.measurement, 'measured', side_effect=RuntimeError('sampler failed')):
            with self.assertRaisesRegex(RuntimeError, 'sampler failed'): runner.bench(self.config())
        value = json.loads((self.out / 'experiments/synthetic/01-native-attempt1.json').read_text())
        self.assertFalse(value['complete']); self.assertIn('sampler failed', value['error']['message'])
        self.assertTrue(self.servers[0].closed)

    def test_legacy_bench_without_observer_still_completes(self):
        with mock.patch.object(runner.measurement, 'measured', side_effect=self.measured), \
             mock.patch.object(runner, 'read_live_observation', side_effect=AssertionError('observer must be optional')):
            runner.bench(self.config())
        value = json.loads((self.out / 'experiments/synthetic/01-native-attempt1.json').read_text())
        self.assertTrue(value['complete']); self.assertEqual(len(value['results']), 2)
        self.assertTrue(all('aggregateGeneratorCpu' not in row for row in value['results']))

    def test_build_timestamps_bracket_actual_process_and_failed_build_is_saved(self):
        folder = self.out / 'candidates/synthetic'; (folder / 'source').mkdir(parents=True)
        put(folder / 'source.json', {'sourceSha256': {}, 'sourceTreeDigest': 'test'})
        with mock.patch.object(runner, 'now', side_effect=['before-build', 'after-build']):
            with self.assertRaises(AssertionError): runner.build(types.SimpleNamespace(name='synthetic', mimalloc=False))
        value = json.loads((folder / 'build.json').read_text())
        self.assertEqual(value['startedAt'], 'before-build'); self.assertEqual(value['finishedAt'], 'after-build')
        self.assertEqual(value['exitCode'], 1); self.assertTrue(self.servers[0].closed)

    def test_next_preflight_uses_exact_fixture_and_rejects_wrong_cwd_or_command(self):
        project = self.root / 'app'; build = project / '.next'; package = project / 'node_modules/next/package.json'
        cli = package.parent / 'dist/bin/next'; lock = project / 'package-lock.json'
        files = {'app/page.jsx': 'page', 'pages/api/test.js': 'api', 'public/robots.txt': 'ready',
                 'package.json': {'dependencies': {'next': '16.3.5'}},
                 'package-lock.json': {'packages': {'': {'dependencies': {'next': '16.3.5'}}, 'node_modules/next': {'version': '16.3.5'}}}}
        for name, content in files.items(): put(project / name, content)
        put(package, {'name': 'next', 'version': '16.3.5', 'bin': {'next': 'dist/bin/next'}}); put(cli, 'next-cli')
        for name in ['BUILD_ID', 'routes-manifest.json', 'required-server-files.json']: put(build / name, 'build')
        proof = {'version': '16.3.5', 'packagePath': str(package), 'packageSha256': runner.sha(package),
                 'cliPath': str(cli), 'cliSha256': runner.sha(cli), 'lockPath': str(lock), 'lockSha256': runner.sha(lock),
                 'buildPath': str(build), 'buildSha256': {f.name: runner.sha(f) for f in build.iterdir()}}
        put(self.out / 'fixture-evidence.json', {'complete': True, 'projectPath': str(project), 'next': proof,
                                                'sourceSha256': {name: runner.sha(project / name) for name in files}})
        record = {'variant': 'next', 'command': [str(self.node), str(cli), 'start', '-H', '127.0.0.1', '-p', '32900'],
                  'cwd': str(project), 'nodeVersion': 'v24.19.0', 'nodeSha256': runner.sha(self.node), 'binarySha256': runner.sha(self.node)}
        runner.attach_next_provenance(record); self.assertEqual(record['next'], proof)
        for field, value in [('cwd', str(self.root)), ('command', [str(self.node), str(cli), 'start', str(project)])]:
            bad = copy.deepcopy(record); bad[field] = value
            with self.assertRaisesRegex(ValueError, 'Invalid Next provenance'): runner.attach_next_provenance(bad)
        put(cli, 'changed')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'): runner.attach_next_provenance(copy.deepcopy(record))


if __name__ == '__main__': unittest.main()
