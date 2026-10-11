"""Aggregation checks: partial output must never look like a final benchmark."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('performance_report', pathlib.Path(__file__).with_name('report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def measurement(label, rate, duration=30):
    return {'label': label, 'value': {'rps': rate, 'durationSeconds': duration, 'count': 100, 'errors': 0,
            'p50': 1, 'p95': 2, 'p99': 3}, 'cpuMsPerResponse': 2, 'cpuPercent': 99,
            'rssMedianMiB': 50, 'rssMaxMiB': 70, 'processesStarted': 0}


class ReportTests(unittest.TestCase):
    def test_truncated_and_unfinished_runs_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'throughput-next.json').write_text('{"results": [', encoding='utf-8')
            (base / 'throughput-before-balanced.json').write_text(json.dumps({'results': [measurement('ssr-1', 999)]}), encoding='utf-8')
            result = report.collect(base)
            self.assertEqual(result['dynamic'], [])
            statuses = {r['source']: r['status'] for r in result['inputs']}
            self.assertIn('écriture en cours', statuses['throughput-next.json'])
            self.assertIn('marqueur final absent', statuses['throughput-before-balanced.json'])
            self.assertNotIn('throughput-next.json', result['files'])

    def test_counts_ranges_quantiles_and_config_come_from_completed_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            rows = [measurement('warmup-ssr', 999), measurement('ssr-1', 10, 15), measurement('ssr-2', 20, 15)]
            rows[-1]['value'].update(errors=2, p99=9)
            data = {'results': rows, 'final': {'cpuSeconds': 300}, 'config': {'command': ['exact.exe', '<unsafe>']}, 'serverCpu': 2}
            (base / 'throughput-next.json').write_text(json.dumps(data), encoding='utf-8-sig')
            result = report.collect(base)
            row = result['dynamic'][0]
            self.assertEqual((row['runs'], row['secondsPerRun'], row['rps'], row['rpsRange']), (2, 15, 15, [10, 20]))
            self.assertEqual((row['errors'], row['completed'], row['p99Ms']), (2, 200, 6))
            self.assertEqual(result['configurations']['throughput-next.json']['config'], data['config'])
            self.assertEqual(len(result['files']['throughput-next.json']), 64)

    def test_final_marker_with_invalid_measurement_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'throughput-next.json').write_text(json.dumps({'final': {}, 'results': [{'label': 'ssr-1'}]}), encoding='utf-8')
            result = report.collect(base)
            self.assertEqual(result['dynamic'], [])
            self.assertEqual(result['inputs'][0]['status'], 'schéma invalide')

    def test_endurance_windows_use_timestamps_not_sample_count(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            row = measurement('stream-1', 20, 180)
            row.update(before={'time': 100, 'threads': 20}, after={'time': 280, 'threads': 21},
                       samples=[{'time': 110, 'rssMiB': 10}, {'time': 150, 'rssMiB': 20},
                                {'time': 170, 'rssMiB': 999}, {'time': 230, 'rssMiB': 30}, {'time': 280, 'rssMiB': 40}])
            (base / 'endurance-before-results.json').write_text(json.dumps({'final': {}, 'results': [row]}), encoding='utf-8')
            result = report.collect(base)['endurance'][0]
            self.assertEqual((result['rssFirstMinuteMiB'], result['rssLastMinuteMiB']), (15, 35))

    def test_html_preserves_french_escapes_untrusted_values_and_shows_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            result = report.collect(base)
            result['dynamic'] = [report.summarize('<script>', 'ssr', [measurement('ssr-1', 3)], 'a "b".json')]
            page = report.render(result, base)
            self.assertIn('Rapport provisoire', page)
            self.assertIn('req/s min – max', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertIn('a%20%22b%22.json', page)
            self.assertIn('mesures vérifiées', page.encode('utf-8').decode('utf-8'))
            self.assertTrue(page.endswith('</body></html>\n'))

    def test_node_log_counters_support_utf16_powershell_and_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            for name, encoding, failures in [('unit-tests.log', 'utf-16', 1), ('e2e-workers-verified.log', 'utf-8', 0)]:
                (base / name).write_bytes(f'ℹ tests 85\r\nℹ pass {85-failures}\r\nℹ fail {failures}\r\nℹ skipped 0\r\nℹ duration_ms 20\r\n'.encode(encoding))
            logs = {row['source']: row for row in report.collect(base)['testLogs']}
            self.assertEqual(logs['unit-tests.log']['fail'], 1)
            self.assertEqual(logs['unit-tests.log']['pass'], 84)
            self.assertEqual(logs['e2e-workers-verified.log']['pass'], 85)
            self.assertEqual(logs['e2e-workers-verified.log']['stage'], 'vérification finale')

    def test_archived_candidate_cannot_fill_missing_v2_and_old_tests_are_labelled(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            archive = base / 'candidate-v1'
            archive.mkdir()
            (archive / 'archive-manifest.json').write_text('{}', encoding='utf-8')
            (archive / 'summary.json').write_text('{"responseTotals": {"old": 1000}}', encoding='utf-8')
            (archive / 'throughput-after-balanced.json').write_text(json.dumps({'final': {}, 'results': [measurement('ssr-1', 999)]}), encoding='utf-8')
            old_log = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ duration_ms 1\n'
            for parent in (base, archive):
                (parent / 'unit-tests-verified.log').write_text(old_log, encoding='utf-8')
            result = report.collect(base)
            self.assertEqual(result['dynamic'], [])
            self.assertEqual(result['responseTotals']['afterOnly']['completed'], 0)
            self.assertEqual(result['testLogs'][0]['stage'], 'candidat v1 archivé')
            (base / 'unit-tests-verified.log').write_text(old_log + '# new execution\n', encoding='utf-8')
            self.assertEqual(report.collect(base)['testLogs'][0]['stage'], 'vérification v2')
            self.assertIn('Rapport candidat v1 archivé', report.render(result, base))

    def test_empty_main_binary_does_not_hide_rust_library_results(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'pool-postresponse.log').write_text(
                'test result: FAILED. 31 passed; 1 failed; 0 ignored; 0 measured; 113 filtered out; finished in 1.0s\n'
                'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.0s\n', encoding='utf-8')
            row = report.collect(base)['testLogs'][0]
            self.assertEqual((row['tests'], row['pass'], row['fail'], row['filteredOut'], row['testBinaries']), (32, 31, 1, 113, 2))

    def test_comparisons_preserve_cpu_regression_and_exclude_unpaired_rows(self):
        before = report.summarize('before-memory', 'stream', [measurement('stream-1', 100)], 'before.json')
        after = report.summarize('after-memory', 'stream', [measurement('stream-1', 120)], 'after.json')
        after['cpuMsPerResponse'] = 2.1
        unpaired = {**after, 'implementation': 'after-balanced'}
        rows = report.comparisons([before, after, unpaired], 'dynamic')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['profile'], 'memory')
        self.assertAlmostEqual(rows[0]['rpsChangePercent'], 20)
        self.assertAlmostEqual(rows[0]['cpuChangePercent'], 5)


if __name__ == '__main__':
    unittest.main()
