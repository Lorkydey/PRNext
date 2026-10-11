"""Pure parser fixtures only; no server, load generator, or ETW session."""
import datetime
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('lifecycle_v5', pathlib.Path(__file__).with_name('lifecycle-v5.py'))
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


def sample(second, **changes):
    values = {key: 0 for key in lifecycle.COUNTERS + lifecycle.GAUGES}
    values.update(submitted=min(second, 10), hostStarts=1, laneConnections=4,
                  consumerCancellations=min(second, 6), laneDiscards=min(second, 4),
                  activeJobs=2 if second < 10 else 0, laneIdleRetirements=4 if second >= 15 else 0)
    values.update(changes)
    return {'pid': 42, 'unixMs': (100 + second) * 1000, 'workers': values, 'tokioCreatedThreads': 3}


def windows():
    return lifecycle.windows({'results': [
        {'label': 'mixed-one-hour', 'before': {'time': 100}, 'after': {'time': 110}},
        {'label': 'idle-after-soak-310s', 'before': {'time': 110}, 'after': {'time': 120}},
        {'label': 'resume-after-soak', 'before': {'time': 120}, 'after': {'time': 120.05}},
    ]})[0]


def encode(rows):
    return ('\n'.join(json.dumps(row) for row in rows) + '\n').encode()


class LifecycleTests(unittest.TestCase):
    def test_cycle_suffix_overrides_planned_rest_duration(self):
        for kind in ('load', 'idle', 'resume'):
            self.assertEqual(lifecycle.phase_kind('cycle-1-rest-60-' + kind), kind)
        self.assertEqual(lifecycle.phase_kind('load-before-idle-300'), 'load')
        self.assertEqual(lifecycle.phase_kind('startup-zero-http-or-tcp-60s'), 'idle')

    def test_absent_idle_window_does_not_prove_zero_gauges(self):
        data = lifecycle.metrics(encode([sample(i) for i in range(11)]), windows()[:1])
        self.assertTrue(data['valid'])
        self.assertFalse(data['idleZeroValid'])
        self.assertFalse(lifecycle.metrics(encode([sample(0)]), [])['idleZeroValid'])

    def test_counters_are_distinct_and_short_resume_does_not_require_two_samples(self):
        data = lifecycle.metrics(encode([sample(i) for i in range(21)]), windows())
        self.assertTrue(data['valid'])
        self.assertTrue(data['idleZeroValid'])
        self.assertEqual(data['processes'][0]['finalCounters']['hostStarts'], 1)
        self.assertEqual(data['processes'][0]['finalCounters']['laneDiscards'], 4)
        self.assertEqual(data['processes'][0]['finalCounters']['consumerCancellations'], 6)
        self.assertEqual(data['windows'][0]['kind'], 'load')
        self.assertEqual(data['windows'][1]['idleZero'], 'yes')
        self.assertFalse(data['windows'][2]['requiredCoverage'])

    def test_regression_and_invalid_lines_remain_visible(self):
        raw = encode([sample(0), sample(1, hostStarts=0)]) + b'{broken\n{"unixMs":NaN}\n'
        data = lifecycle.metrics(raw, windows())
        self.assertFalse(data['valid'])
        self.assertFalse(data['counterMonotonic'])
        self.assertEqual([row['line'] for row in data['invalidLines']], [3, 4])
        self.assertTrue(any(row.get('counter') == 'hostStarts' for row in data['issues']))

    def test_missing_tail_and_nonzero_idle_gauges_are_not_success(self):
        missing = lifecycle.metrics(encode([sample(i) for i in range(13)]), windows())
        self.assertEqual(missing['windows'][1]['idleZero'], 'unknown')
        self.assertFalse(missing['idleZeroValid'])
        active = lifecycle.metrics(encode([sample(i, activityProtectedHosts=1) for i in range(21)]), windows())
        self.assertEqual(active['windows'][1]['idleZero'], 'no')
        self.assertFalse(active['idleZeroValid'])

    def test_pid_boundary_never_sums_counters_as_one_lifetime(self):
        first, second = sample(0), sample(1)
        second['pid'] = 99
        data = lifecycle.metrics(encode([first, second]), windows())
        self.assertFalse(data['valid'])
        self.assertEqual(len(data['processes']), 2)
        self.assertEqual(data['windows'][0]['coverage'], 'multiple-pids')

    def test_logs_are_non_exhaustive_and_untimed_occurrences_are_unassigned(self):
        begin = 1790000000000
        phases = [{'label': 'load', 'beginUnixMs': begin, 'endUnixMs': begin + 10000}]
        stamp = datetime.datetime.fromtimestamp(begin / 1000 + 5, datetime.timezone.utc).isoformat()
        raw = (f'{stamp} DEBUG HTTP consumer cancelled render response\n'
               f'{stamp} WARN restarting render worker after failed request: EPIPE\n'
               '[prnext] RSC background worker stopped responding: application blocked\n').encode()
        data = lifecycle.log_observations(raw, phases)
        self.assertFalse(data['exhaustive'])
        self.assertEqual(data['counts']['normalConsumerCancellation'], 1)
        self.assertEqual(data['counts']['failedRequestLaneRestart'], 1)
        self.assertEqual(data['counts']['brokenPipe'], 1)
        self.assertEqual(data['matches'][-1]['window'], 'unassigned')
        self.assertEqual(data['matches'][0]['window'], 'load')
        self.assertEqual(data['matches'][1]['line'], 2)

    def test_analyzer_hashes_sources_and_excludes_failure_test_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'soak').mkdir()
            metrics = encode([sample(i) for i in range(21)])
            (base / 'soak/metrics.jsonl').write_bytes(metrics)
            result = {'complete': True, 'binarySha256': 'candidate', 'results': [
                {'label': 'load', 'before': {'time': 100}, 'after': {'time': 110}},
                {'label': 'idle-after-soak', 'before': {'time': 110}, 'after': {'time': 120}},
            ]}
            (base / 'soak/result.json').write_text(json.dumps(result))
            (base / 'soak/server.log').write_text('RSC background worker stopped responding\n')
            (base / 'tests').mkdir()
            (base / 'tests/expected-failure.log').write_text('restarting render worker after failed request\n')
            data = lifecycle.analyze(base)
            self.assertTrue(data['soakMetricsPresent'])
            self.assertEqual(data['sourcesSha256']['soak/metrics.jsonl'], hashlib.sha256(metrics).hexdigest())
            self.assertEqual(len(data['logs']), 1)
            self.assertTrue(data['metrics'][0]['valid'])


if __name__ == '__main__':
    unittest.main()
