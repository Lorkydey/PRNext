"""Synthetic tests only; no servers, benchmarks or campaign evidence read."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('stability_final_v5', pathlib.Path(__file__).with_name('stability-final-v5.py'))
stability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stability)


def sample(at, rss=100, cpu=None, total=3):
    return {'time': at, 'cpuSeconds': at / 100 if cpu is None else cpu,
            'rssMiB': rss, 'privateCommitMiB': rss + 10, 'threads': 8, 'handles': 200,
            'processes': 3, 'totalProcesses': total,
            'pids': [[1, 'prnext.exe'], [2, 'node.exe'], [3, 'conhost.exe']],
            'processDetail': [{'pid': 1, 'name': 'prnext.exe', 'rssMiB': rss, 'privateCommitMiB': rss + 10, 'threads': 8}]}


def resume_value(begin):
    return {name: {'status': 200, 'freshness': True, 'isolation': True, 'latencyMs': 40,
                   'startedAtUnixMs': begin * 1000 + offset,
                   'finishedAtUnixMs': begin * 1000 + offset + 40}
            for name, offset in [('first', 0), ('second', 50)]}


def phase(label, begin, duration):
    before, after = sample(begin), sample(begin + duration)
    periodic = [sample(begin + offset) for offset in range(2, int(duration), 2)]
    value = None
    if label in ('warmup', 'mixed-one-hour'):
        value = {'durationSeconds': duration, 'count': 100, 'started': 100, 'errors': 0,
                 'validationErrors': 0, 'exitCode': 0, 'statuses': {'200': 100},
                 'plannedDisconnects': 4, 'cancelStarts': 4, 'cancellationStatuses': {'200': 4}}
    elif label == 'resume-after-soak':
        value = resume_value(begin)
    return {'label': label, 'before': before, 'after': after, 'samples': [*periodic, after],
            'elapsedSeconds': duration, 'cpuSeconds': after['cpuSeconds'] - before['cpuSeconds'],
            'processesStarted': 0, 'value': value}, periodic


def soak_fixture():
    rows, periodic, begin = [], [], 1000
    for label, duration in [('warmup', 30), ('mixed-one-hour', 3600),
                            ('idle-after-soak-310s', 310), ('resume-after-soak', .2)]:
        row, samples = phase(label, begin, duration)
        rows.append(row)
        periodic.extend(samples)
        begin += duration + .1
    return {'complete': True, 'mode': 'soak', 'profile': 'balanced', 'instrumented': True,
            'binarySha256': 'a' * 64, 'buildSha256': {'manifest.json': 'b' * 64}, 'results': rows}, periodic


class StabilityFinalV5Tests(unittest.TestCase):
    def test_invalid_json_lines_and_overflow_are_visible(self):
        rows, invalid = stability.json_lines(b'{"time": 1}\nnot json\n{"rssMiB": NaN}\n{"cpuSeconds":1e400}\n')
        self.assertEqual(rows, [{'time': 1}])
        self.assertEqual([row['line'] for row in invalid], [2, 3, 4])

    def test_series_rejects_negative_nonfinite_boolean_and_duplicate_pids(self):
        for key, value in [('cpuSeconds', -1), ('rssMiB', float('inf')), ('privateCommitMiB', float('nan')),
                           ('threads', True), ('handles', -1), ('processes', 1.5)]:
            with self.subTest(key=key):
                item = sample(100)
                item[key] = value
                self.assertTrue(stability.validate_series([item], 'synthetic'))
        item = sample(100)
        item['pids'][1][0] = 1
        self.assertTrue(any('Duplicate PIDs' in error['reason'] for error in stability.validate_series([item], 'synthetic')))

    def test_series_rejects_time_cpu_and_job_creation_regression(self):
        first, second = sample(100), sample(101)
        second.update(time=100, cpuSeconds=.1, totalProcesses=3)
        errors = stability.validate_series([first, second], 'synthetic')
        self.assertTrue(any('time did not increase' in item['reason'] for item in errors))
        self.assertTrue(any('cpuSeconds regressed' in item['reason'] for item in errors))
        # A structurally valid active count is needed to reach cross-sample checks.
        second = sample(101, total=3)
        first['totalProcesses'] = 4
        self.assertTrue(any('totalProcesses regressed' in item['reason'] for item in stability.validate_series([first, second], 'synthetic')))

    def test_resource_gaps_are_not_hidden_by_endpoints(self):
        _, coverage = stability.coverage([sample(100), sample(101), sample(110)], 100, 110)
        self.assertFalse(coverage['valid'])
        self.assertEqual(coverage['maxSampleGapSeconds'], 9)
        _, coverage = stability.coverage([sample(103), sample(104)], 100, 104)
        self.assertFalse(coverage['valid'])
        self.assertEqual(coverage['leadingGapSeconds'], 3)

    def test_descriptive_slope_units_and_resource_ranges(self):
        rows = [sample(100 + seconds, 100 + seconds / 5) for seconds in (0, 50, 100)]
        summary = stability.distribution(rows, 'rssMiB')
        self.assertEqual((summary['min'], summary['median'], summary['max']), (100, 110, 120))
        self.assertAlmostEqual(summary['descriptiveSlopeMiBPerMinute'], 12)
        self.assertNotIn('descriptiveSlopeMiBPerMinute', stability.distribution(rows, 'handles'))

    def test_fixed_windows_exclude_boundary_and_drain_but_keep_last_minute(self):
        rows = [sample(1000 + seconds, (10 if seconds < 900 else 20 if seconds < 1800 else 30 if seconds < 3600 else 99))
                for seconds in range(0, 3603, 2)]
        windows = stability.load_windows({'before': rows[0], 'after': rows[-1], 'samples': rows[1:]})
        self.assertEqual([row['resources']['rssMiB']['median'] for row in windows[:3]], [10, 20, 30])
        self.assertTrue(all(row['coverage']['valid'] for row in windows))
        self.assertEqual(windows[2]['resources']['rssMiB']['max'], 30)
        self.assertEqual(windows[3]['resources']['rssMiB']['max'], 99)
        self.assertTrue(windows[3]['separateObservation'])

    def test_resume_keeps_both_responses_zero_cpu_and_job_scope(self):
        row, _ = phase('resume-after-soak', 1000, .2)
        row['after']['cpuSeconds'] = row['before']['cpuSeconds']
        row['cpuSeconds'] = 0
        result, errors = stability.resume_details(row)
        self.assertFalse(errors)
        self.assertEqual(result['first']['latencyMs'], 40)
        self.assertEqual(result['second']['latencyMs'], 40)
        self.assertEqual(result['cpuBothResponsesSeconds'], 0)
        self.assertEqual(result['jobCreationsBothResponses'], 0)
        self.assertIn('15,625 ms', result['zeroCpuResolutionNote'])
        row['value']['second']['isolation'] = False
        self.assertTrue(stability.resume_details(row)[1])

    def test_resume_timestamps_must_fit_resource_phase(self):
        row, _ = phase('resume-after-soak', 1000, .2)
        row['value']['first']['startedAtUnixMs'] -= 1
        self.assertTrue(any('outside resource phase: 1' in error for error in stability.resume_details(row)[1]))
        row['value'] = resume_value(1000)
        row['value']['second']['finishedAtUnixMs'] = row['after']['time'] * 1000 + 1
        self.assertTrue(any('outside resource phase: 2' in error for error in stability.resume_details(row)[1]))

    def test_rsc_and_pipe_faults_remain_distinct_from_normal_cancellations(self):
        self.assertEqual(stability.unexpected_log_events({'counts': {'normalConsumerCancellation': 20,
                         'legacyDisconnect': 5, 'rscExitMessage': 1, 'failedRequestLaneRestart': 2}}), [])
        self.assertEqual(stability.unexpected_log_events({'counts': {'rscBackgroundUnresponsive': 1, 'brokenPipe': 2}}),
                         [{'category': 'rscBackgroundUnresponsive', 'occurrences': 1}, {'category': 'brokenPipe', 'occurrences': 2}])

    def test_complete_record_validates_cross_phase_accounting_and_raw_samples(self):
        record, periodic = soak_fixture()
        result = stability.analyze_record(record, periodic, 'soak', 'balanced', 'a' * 64, {'manifest.json': 'b' * 64})
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(result['phases'][1]['windows']), 4)
        self.assertEqual(len(result['observedProcesses']), 3)
        self.assertIn('lastFiveSeconds', result['phases'][2])
        self.assertIn('second', result['phases'][3]['resume'])
        mismatch = stability.analyze_record(record, periodic[:-1], 'soak', 'balanced')
        self.assertFalse(mismatch['valid'])
        self.assertTrue(any('samples.jsonl differs' in item['reason'] for item in mismatch['errors']))

    def test_errors_drain_and_declared_provenance_fail_closed(self):
        record, periodic = soak_fixture()
        record['results'][1]['value']['started'] += 1
        record['results'][1]['value']['cancelStarts'] += 1
        result = stability.analyze_record(record, periodic, 'soak', 'balanced', 'c' * 64)
        self.assertFalse(result['valid'])
        reasons = [item['reason'] for item in result['errors']]
        self.assertIn('Declared final binary differs', reasons)
        self.assertIn('Load did not drain successful ordinary responses', reasons)
        self.assertIn('Deliberate cancellations did not drain', reasons)

    def test_incomplete_run_is_not_read_as_live_resource_series(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'soak').mkdir()
            (base / 'final.json').write_text(json.dumps({'binarySha256': 'a' * 64, 'dynamicBuild': {'sha256': {'manifest.json': 'b' * 64}}}))
            (base / 'soak/result.json').write_text('{"complete": false}')
            live = base / 'soak/samples.jsonl'
            live.write_bytes(b'not a completed series')
            result = stability.analyze(base)
            self.assertFalse(result['valid'])
            self.assertNotIn(str(live), result['sourcesSha256'])
            self.assertIn('live series were not read', result['runs'][0]['errors'][0]['reason'])

    def test_lifecycle_counter_regression_and_idle_jobs_are_visible(self):
        _, lifecycle = stability.lifecycle_module()
        phases = [{'label': 'idle', 'kind': 'idle', 'beginUnixMs': 0, 'endUnixMs': 6000,
                   'requiredCoverage': True, 'expectedZeroAtEnd': True}]
        rows = [{'pid': 42, 'unixMs': second * 1000,
                 'workers': {**dict.fromkeys(lifecycle.COUNTERS, 0), **dict.fromkeys(lifecycle.GAUGES, 0)}} for second in range(7)]
        raw = lambda: ('\n'.join(json.dumps(row) for row in rows)).encode()
        result = lifecycle.metrics(raw(), phases)
        self.assertTrue(result['valid'])
        self.assertTrue(result['idleZeroValid'])
        rows[-1]['workers']['queuedJobs'] = 1
        self.assertFalse(lifecycle.metrics(raw(), phases)['idleZeroValid'])
        rows[-2]['workers']['hostStarts'] = 2
        result = lifecycle.metrics(raw(), phases)
        self.assertFalse(result['counterMonotonic'])
        self.assertFalse(result['valid'])

    def test_output_never_overwrites_previous_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'analysis.json'
            stability.write_analysis(path, {'valid': True})
            with self.assertRaises(FileExistsError):
                stability.write_analysis(path, {'valid': False})
            self.assertEqual(json.loads(path.read_text()), {'valid': True})


if __name__ == '__main__':
    unittest.main()
