"""Prepared synthetic report checks; no server, npm, workload or real-log scan."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('report_v5_scope_tests', HERE / 'report-v5.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'artifacts/performance-v5'
        self.base.mkdir(parents=True)

    def write(self, file, value):
        file.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(value).encode('utf-8')
        file.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def fixture(self):
        binary = 'a' * 64
        names = ['clippy', 'e2e', 'fmt', 'next-oracle', 'rust', 'types-app', 'types-basic', 'types', 'unit']
        counters = {'rust': {'pass': 155, 'skipped': 1}, 'unit': {'pass': 669, 'skipped': 1},
                    'e2e': {'pass': 301, 'skipped': 1}, 'next-oracle': {'pass': 2, 'skipped': 0}}
        for value in counters.values():
            value.update(fail=0, cancelled=0)
        hashes, rows = {}, []
        for name in names:
            file = self.base / 'tests/final' / (name + '.json')
            hashes[name + '.json'] = self.write(file, {'exitCode': 0, 'binarySha256': binary})
            rows.append({'source': 'tests/final/' + name + '.json', 'counts': counters.get(name, {})})
        self.final = {'manifest': {'binarySha256': binary}, 'tests': rows}
        self.scope = {
            'binarySha256': binary, 'testProofs': hashes,
            'passed': {'rust': 155, 'unit': 669, 'e2e': 301, 'nextOracle': 2, 'typescriptProjects': 3},
            'notExecuted': [
                {'suite': 'rust', 'case': 'benchmark_contained_static_preparation',
                 'reason': 'Manual timing test; separate immutable exploratory static benchmarks were executed.'},
                {'suite': 'unit', 'case': 'computed native npm loaders traverse runtime and optional dependencies and survive relocation',
                 'reason': 'Node-API development headers are not installed.'},
                {'suite': 'e2e', 'case': 'native dev releases its process tree on SIGTERM, including during a rebuild',
                 'reason': 'Unix SIGTERM behavior is skipped on Windows.'},
            ],
        }
        self.write(self.base / 'validation-scope.json', self.scope)

    def collected(self):
        return report.validation_scope(report.Inputs(self.base), self.final)

    def test_scope_links_and_all_three_reasons_are_rendered_after_verification(self):
        self.fixture()
        item = self.collected()
        self.assertTrue(item['verified'], item['issues'])
        html = report.render_validation_scope(item, self.base)
        self.assertIn('href="validation-scope.json"', html)
        self.assertIn('Headers de développement Node-API non installés', html)
        self.assertIn('signal Unix SIGTERM', html)
        self.assertIn('Mesure manuelle de durée', html)
        self.assertIn('669', html)
        self.assertIn('contrats finis', html)

    def test_absent_scope_has_no_fabricated_success_or_broken_link(self):
        item = report.validation_scope(report.Inputs(self.base), {'manifest': None, 'tests': []})
        self.assertFalse(item['verified'])
        html = report.render_validation_scope(item, self.base)
        self.assertIn('absente ou indisponible', html)
        self.assertNotIn('href="validation-scope.json"', html)
        self.assertNotIn('669', html)

    def test_metadata_hash_tampering_hides_declared_counts(self):
        self.fixture()
        self.write(self.base / 'tests/final/unit.json', {'exitCode': 0, 'binarySha256': 'a' * 64, 'changed': True})
        item = self.collected()
        self.assertFalse(item['verified'])
        self.assertNotIn('669', report.render_validation_scope(item, self.base))

    def test_declared_counts_must_match_log_counts(self):
        self.fixture()
        self.scope['passed']['unit'] = 999
        self.write(self.base / 'validation-scope.json', self.scope)
        self.assertFalse(self.collected()['verified'])

    def test_failed_log_cannot_be_validated_by_successful_metadata(self):
        self.fixture()
        row = next(row for row in self.final['tests'] if row['source'] == 'tests/final/unit.json')
        row['counts']['fail'] = 1
        self.assertFalse(self.collected()['verified'])

    def test_omitted_skipped_case_cannot_disappear_from_scope(self):
        self.fixture()
        self.scope['notExecuted'] = [row for row in self.scope['notExecuted'] if row['suite'] != 'unit']
        self.write(self.base / 'validation-scope.json', self.scope)
        self.assertFalse(self.collected()['verified'])

    def test_rehashed_metadata_for_a_different_binary_is_rejected(self):
        self.fixture()
        self.scope['testProofs']['unit.json'] = self.write(self.base / 'tests/final/unit.json', {'exitCode': 0, 'binarySha256': 'b' * 64})
        self.write(self.base / 'validation-scope.json', self.scope)
        self.assertFalse(self.collected()['verified'])

    def test_scope_proof_paths_cannot_escape_the_final_test_directory(self):
        self.fixture()
        self.scope['testProofs']['../unexpected.json'] = self.scope['testProofs'].pop('unit.json')
        self.write(self.base / 'validation-scope.json', self.scope)
        self.assertFalse(self.collected()['verified'])

    def test_historical_review_points_to_current_proof_and_option_sources(self):
        self.fixture()
        self.write(self.base / 'compatibility-review.json', {})
        for name in ['packages/prnext/README.md', 'packages/prnext/build/typescript.test.mjs']:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('source', encoding='utf-8')
        item = {'source': 'compatibility-review.json', 'state': 'revue historique', 'issues': [],
                'review': {'retainedV4': [{'topic': 'typescript', 'supported': [], 'limits': []}], 'newV5': []}}
        html = report.render_compatibility(item, self.base)
        self.assertIn('revue historique précède', html)
        self.assertIn('href="#installation"', html)
        self.assertIn('href="validation-scope.json"', html)
        self.assertIn('href="../../packages/prnext/README.md"', html)
        self.assertIn('href="../../packages/prnext/build/typescript.test.mjs"', html)

    def test_diagnostic_interpretation_is_linked_with_limited_gc_causality(self):
        self.write(self.base / 'diagnostic-interpretation.json', {'complete': True, 'kind': 'documentary'})
        html = report.render(report.collect(self.base), self.base)
        self.assertIn('href="diagnostic-interpretation.json"', html)
        self.assertIn('sans démontrer à elle seule la cause', html)
        self.assertIn('ne se généralisent pas automatiquement à memory', html)

    def test_small_page_label_is_specific_to_the_measured_html_route(self):
        self.assertEqual(report.route_label('pages-static'), 'petite page HTML gzip (pages-static)')
        self.assertEqual(report.route_label('/pages-static'), 'petite page HTML gzip (/pages-static)')
        self.assertEqual(report.route_label('payload.txt'), 'payload.txt')
        self.assertEqual(report.route_label('_prnext/assets/control.html'), '_prnext/assets/control.html')


if __name__ == '__main__':
    unittest.main()
