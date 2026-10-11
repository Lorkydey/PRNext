"""Synthetic diagnostic evidence only: no Node, server, capture or workload."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import statistics
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('diagnostic_report_v5', HERE / 'diagnostic-report-v5.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


class Inputs:
    def __init__(self, base):
        self.base, self.hashes = base, {}

    def relative(self, file):
        return pathlib.Path(file).relative_to(self.base).as_posix()

    def raw(self, file):
        file = pathlib.Path(file)
        if not file.is_file():
            return None
        value = file.read_bytes()
        self.hashes[self.relative(file)] = hashlib.sha256(value).hexdigest()
        return value

    def read(self, file, optional=False):
        value = self.raw(file)
        return json.loads(value) if value is not None else None


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.inputs = Inputs(self.base)

    def write(self, file, value):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value), encoding='utf-8')

    def test_absent_diagnostics_do_not_manufacture_zeroes(self):
        data = diagnostics.collect(self.inputs)
        self.assertEqual(data['gc']['runs'], [])
        self.assertEqual(data['etw']['traces'], [])
        rendered = diagnostics.render(data)
        self.assertIn('non exécuté', rendered)
        self.assertNotIn('0.00', rendered)

    def isolate(self):
        file = self.base / 'isolate.jsonl'
        identity = {'schema': 1, 'runId': 'balanced-v4', 'pid': 123, 'threadId': 0, 'isMainThread': True}
        first = {**identity, 'event': 'start', 'unixMs': 900, 'node': 'v24.19.0', 'v8': '13.6.233.17',
                 'gcDurationIsCpu': False, 'limits': {'maxBytes': 524288, 'maxRecords': 120}}
        rows = [first]
        for i, timestamp in enumerate([1000, 3000]):
            rows.append({**identity, 'event': 'sample', 'unixMs': timestamp, 'invalidEntries': 0,
                         'gc': {'minor': {'count': 2 + i * 3, 'durationMs': 1 + i * 6, 'maxDurationMs': 1 + i}},
                         'heap': {name: 1000 + i * 2000 for name in ['heapUsed', 'heapTotal', 'external', 'arrayBuffers']}})
        file.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        expected = {'sha256': sha(file), 'completeCoverage': True, 'counterCoverageSeconds': 2,
                    'gcDelta': {'minor': {'count': 3, 'elapsedDurationMs': 6}},
                    'heap': {name: {'medianBytes': 2000, 'maxBytes': 3000, 'firstBytes': 1000, 'lastBytes': 3000}
                             for name in ['heapUsed', 'heapTotal', 'external', 'arrayBuffers']}}
        return file, rows, expected

    def test_gc_deltas_and_heap_are_checked_against_isolate_rows(self):
        file, _, expected = self.isolate()
        result = diagnostics.gc_isolate(self.inputs, file, expected, 1000, 3000)
        self.assertEqual(result['gcDelta']['minor']['count'], 3)
        self.assertEqual(result['heap']['heapTotal']['medianBytes'], 2000)
        self.assertNotIn('rss', result)

    def test_gc_rehashed_counter_regression_is_rejected(self):
        file, rows, expected = self.isolate()
        rows[-1]['gc']['minor']['count'] = 1
        file.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        expected['sha256'] = sha(file)
        with self.assertRaisesRegex(ValueError, 'monotone'):
            diagnostics.gc_isolate(self.inputs, file, expected, 1000, 3000)

    def test_gc_forged_summary_is_rejected(self):
        file, _, expected = self.isolate()
        expected['gcDelta']['minor']['elapsedDurationMs'] = 0
        with self.assertRaisesRegex(ValueError, 'différent'):
            diagnostics.gc_isolate(self.inputs, file, expected, 1000, 3000)

    def etw(self, lost=0, reported_lost=None):
        folder = self.base / 'etw/static-final'
        analyzer = self.base / 'diagnostics/analyzers/analyze-etw-v5.py'
        analyzer.parent.mkdir(parents=True)
        analyzer.write_text('frozen synthetic analyzer')
        self.write(folder / 'result.json', {'complete': True, 'instrumented': True, 'labels': ['v4', 'v5']})
        self.write(folder / 'plan.json', {})
        traces = []
        for label in ['v4', 'v5']:
            self.write(folder / (label + '.json'), {'complete': True, 'binarySha256': label, 'wireSha256': 'same-wire'})
            (folder / (label + '.etl')).write_bytes(b'synthetic ETL')
            for suffix in ['profile', 'diskio', 'dumper']:
                (folder / (label + '-' + suffix + '.csv')).write_text('synthetic export')
            (folder / (label + '-tracestats.csv')).write_text('Total # Lost Buffers : 0\nTotal # Lost Events : ' + str(lost))
            names = {'plan.json', 'result.json', label + '.json', label + '.etl', *[label + '-' + suffix + '.csv' for suffix in ['profile', 'diskio', 'dumper', 'tracestats']]}
            traces.append({'label': label, 'binarySha256': label, 'wireSha256': 'same-wire', 'responses': 10, 'httpErrors': 0,
                           'lost': {'Buffers': 0, 'Events': lost if reported_lost is None else reported_lost}, 'attributionValid': True,
                           'inputsSha256': {name: sha(folder / name) for name in names},
                           'processes': [{'pid': 123, 'name': 'server<script>', 'modules': [{'module': '<script>alert(1)</script>', 'processSamplePercent': 50}]}],
                           'fileIoEventsPerResponse': {'FileIoRead': 1}, 'instrumentedRps': 1, 'jobCpuMsPerResponse': 2, 'instrumentedRssMiB': 3})
        analysis = {'complete': True, 'instrumented': True, 'csvEncoding': 'utf-8', 'analyzerSha256': sha(analyzer), 'traces': traces}
        self.write(folder / 'analysis.json', analysis)
        return folder, analysis

    def test_lossless_etw_is_separate_and_html_escaped(self):
        self.etw()
        data = diagnostics.collect(self.inputs)
        self.assertTrue(all(row['valid'] for row in data['etw']['traces']))
        rendered = diagnostics.render(data)
        self.assertIn('&lt;script&gt;', rendered)
        self.assertNotIn('<script>', rendered)
        self.assertIn('octets demandés', rendered)
        self.assertIn('pas des résultats HTTP finaux', rendered)

    def test_etw_losses_disable_attribution_even_if_flag_claims_valid(self):
        self.etw(lost=5)
        data = diagnostics.collect(self.inputs)
        self.assertFalse(any(row['valid'] for row in data['etw']['traces']))
        self.assertTrue(all(row['modules'] == [] for row in data['etw']['traces']))

    def test_etw_forged_zero_losses_are_detected_in_csv(self):
        self.etw(lost=5, reported_lost=0)
        data = diagnostics.collect(self.inputs)
        self.assertTrue(all(any('CSV brut' in issue for issue in row['issues']) for row in data['etw']['traces']))

    def test_etw_modified_raw_trace_fails_provenance(self):
        folder, _ = self.etw()
        (folder / 'v4.etl').write_bytes(b'changed trace')
        data = diagnostics.collect(self.inputs)
        self.assertFalse(data['etw']['traces'][0]['valid'])
        self.assertIn('SHA-256 différent', '; '.join(data['etw']['traces'][0]['issues']))

    def test_missing_frozen_etw_analyzer_prevents_verification(self):
        self.etw()
        (self.base / 'diagnostics/analyzers/analyze-etw-v5.py').unlink()
        data = diagnostics.collect(self.inputs)
        self.assertFalse(any(row['valid'] for row in data['etw']['traces']))


if __name__ == '__main__':
    unittest.main()
