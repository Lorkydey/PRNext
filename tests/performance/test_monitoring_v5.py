"""Small synthetic sampler/GC/CPU-window regressions; no HTTP or native build."""
import copy
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


measurement = module('measurement-v5')
cpu = module('generator-cpu-v5')
gc = module('windows-gc-v5')


class SamplingTests(unittest.TestCase):
    def test_sampler_exception_invalidates_measurement_and_thread_stops(self):
        sampled = threading.Event()

        class Server:
            count = 0

            def sample(self):
                self.count += 1
                if self.count == 2:
                    sampled.set()
                    raise RuntimeError('synthetic sampling failure')
                return {'cpuSeconds': 1, 'rssMiB': 1, 'totalProcesses': 1}

        with self.assertRaisesRegex(RuntimeError, 'sampling failed'):
            measurement.measured(Server(), lambda: sampled.wait(2), sample_interval=.001)
        self.assertFalse(any(t.name == 'prnext-v5-accounting' for t in threading.enumerate()))

    def test_callback_exception_still_joins_sampler(self):
        class Server:
            def sample(self):
                return {'cpuSeconds': 1, 'rssMiB': 1, 'totalProcesses': 1}

        def fail():
            raise ValueError('workload failure')

        with self.assertRaisesRegex(ValueError, 'workload failure'):
            measurement.measured(Server(), fail, sample_interval=.001)
        self.assertFalse(any(t.name == 'prnext-v5-accounting' for t in threading.enumerate()))

    def test_cpu_keeps_work_from_exited_processes(self):
        class Server:
            count = 0

            def sample(self):
                self.count += 1
                return {'cpuSeconds': 1 if self.count == 1 else 3, 'rssMiB': 1, 'totalProcesses': 1 if self.count == 1 else 4}

        result = measurement.measured(Server(), lambda: 'done')
        self.assertEqual(result['cpuSeconds'], 2)
        self.assertEqual(result['processesStarted'], 3)


def interval(begin, end, a, b):
    return {'event': 'sample', 'beginUnixMs': begin, 'endUnixMs': end, 'cpuPercent': {'8': a, '9': b}, 'logicalCpuSumPercent': a + b}


class GlobalCpuTests(unittest.TestCase):
    def test_two_individually_unsaturated_generators_can_contaminate_core(self):
        result = cpu.window_utilization([interval(0, 1000, 60, 60)], 0, 1000)
        self.assertTrue(result['contaminated'])
        self.assertFalse(result['valid'])
        self.assertEqual(result['p95LogicalCpuSumPercent'], 120)

    def test_p95_is_time_weighted_and_peak_remains_visible(self):
        result = cpu.window_utilization([interval(0, 960, 20, 20), interval(960, 1000, 90, 90)], 0, 1000)
        self.assertTrue(result['valid'])
        self.assertEqual(result['p95LogicalCpuSumPercent'], 40)
        self.assertEqual(result['peakLogicalCpuSumPercent'], 180)

    def test_intersection_does_not_count_unrelated_outside_traffic(self):
        result = cpu.window_utilization([interval(0, 1000, 90, 90), interval(1000, 2000, 20, 20)], 1100, 1900)
        self.assertTrue(result['valid'])
        self.assertEqual(result['coveredSeconds'], .8)

    def test_missing_interval_invalidates_even_long_window(self):
        result = cpu.window_utilization([interval(0, 100000, 10, 10), interval(101000, 200000, 10, 10)], 0, 200000)
        self.assertFalse(result['completeCoverage'])

    def test_duplicate_intervals_and_forged_sums_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            cpu.window_utilization([interval(0, 1000, 10, 10), interval(0, 1000, 10, 10)], 0, 1000)
        row = interval(0, 1000, 10, 10)
        row['logicalCpuSumPercent'] = 0
        with self.assertRaisesRegex(ValueError, 'sum differs'):
            cpu.window_utilization([row], 0, 1000)


class GcTraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = pathlib.Path(self.temp.name)
        identity = {'schema': 1, 'runId': 'test', 'pid': 1, 'threadId': 0, 'isMainThread': True}
        self.rows = [{**identity, 'event': 'start', 'unixMs': 0, 'node': 'v24.19.0', 'v8': 'test', 'execArgv': [], 'environment': {}, 'resourceLimits': {}, 'v8CachedDataVersionTag': 1, 'heapSizeLimit': 1000, 'limits': {'maxBytes': 524288, 'maxRecords': 120}}]
        for count in range(3):
            self.rows.append({**identity, 'event': 'sample', 'unixMs': count * 1000,
                              'invalidEntries': 0, 'gc': {'minor': {'count': count, 'durationMs': count, 'maxDurationMs': min(count, 1)}},
                              'heap': {'heapUsed': 10, 'heapTotal': 20, 'external': 0, 'arrayBuffers': 0}})

    def result(self):
        (self.folder / '1-0.jsonl').write_text('\n'.join(json.dumps(row) for row in self.rows), encoding='utf-8')
        return gc.summarize(self.folder, 0, 2000)

    def test_valid_cumulative_counters_are_differenced_per_isolate(self):
        result = self.result()['isolates'][0]
        self.assertEqual(result['gcDelta']['minor'], {'count': 2, 'elapsedDurationMs': 2})

    def test_invalid_entry_counter_is_not_silently_discarded(self):
        self.rows[-1]['invalidEntries'] = 1
        with self.assertRaisesRegex(ValueError, 'Invalid GC entries'):
            self.result()

    def test_counter_regression_and_nonfinite_duration_are_rejected(self):
        valid = copy.deepcopy(self.rows)
        self.rows[-1]['gc']['minor']['count'] = 0
        with self.assertRaisesRegex(ValueError, 'regressed'):
            self.result()
        self.rows = valid
        self.rows[-1]['gc']['minor']['durationMs'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'Invalid GC duration'):
            self.result()


if __name__ == '__main__':
    unittest.main()
