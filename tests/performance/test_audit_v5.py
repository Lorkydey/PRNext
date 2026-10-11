"""Adversarial local tests for V5 evidence, without spawning a server or load."""
import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audit_v5', HERE / 'audit-v5.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
summary = audit.summary


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.folder = self.base / 'experiments' / 'probe'
        self.folder.mkdir(parents=True)
        (self.base / 'configs').mkdir()
        self.config = {'name': 'probe', 'variants': [{'name': 'candidate', 'command': ['fake.exe']}], 'scenarios': [['ssr', 2]], 'warmup': 1, 'seconds': 1, 'repeats': 1}
        for file in [self.folder / 'config.json', self.base / 'configs/probe.json']:
            self.write(file, self.config)
        before = {'cpuSeconds': 1, 'totalProcesses': 1, 'threads': 2, 'rssMiB': 1}
        after = {'cpuSeconds': 2, 'totalProcesses': 2, 'threads': 3, 'rssMiB': 2}
        row = {'route': 'ssr', 'connections': 2, 'cpuSeconds': 1, 'cpuMsPerResponse': 100, 'processesStarted': 1, 'rssMedianMiB': 2, 'before': before, 'after': after, 'samples': [after], 'generatorMayLimit': False,
               'value': {'durationSeconds': 1, 'connections': 2, 'count': 10, 'started': 10, 'completedWithinWindow': 9, 'rps': 9, 'errors': 0, 'bytes': 100, 'statuses': {'200': 10}, 'generatorCpuPercent': 10, 'p50': 1, 'p95': 2, 'p99': 3}}
        self.raw = {'complete': True, 'variant': 'candidate', 'command': ['fake.exe'], 'environment': {}, 'repeat': 1, 'serverCpu': 10, 'generatorCpus': [8, 9], 'configSha256': summary.sha(self.base / 'configs/probe.json'), 'results': [{**copy.deepcopy(row), 'phase': 'warmup'}, {**copy.deepcopy(row), 'phase': 'measure'}]}
        self.file = self.folder / '01-candidate-attempt1.json'
        self.write(self.file, self.raw)
        self.write(self.folder / 'complete.json', {'complete': True})

    def write(self, file, value):
        file.write_text(json.dumps(value, indent=2), encoding='utf-8')

    def result(self):
        self.write(self.file, self.raw)
        return summary.summarize_folder(self.folder)

    def assertRejected(self, needle):
        result = self.result()
        self.assertFalse(result['complete'])
        self.assertEqual(result['inputs'], [])
        self.assertTrue(any(needle in reason for row in result['rejected'] for reason in row['reasons']), result)

    def attach_aggregate_observation(self, warmup=40, measure=40):
        self.config['generatorCpuFile'] = 'generator-cpu.jsonl'
        for file in [self.folder / 'config.json', self.base / 'configs/probe.json']:
            self.write(file, self.config)
        self.raw['configSha256'] = summary.sha(self.base / 'configs/probe.json')
        start = {'event': 'start', 'schema': 1, 'cpus': [8, 9], 'thresholdPercent': 85,
                 'observerSha256': summary.sha(HERE / 'generator-cpu-v5.py')}
        rows = [start]
        for index, value in enumerate([warmup, measure]):
            rows.append({'event': 'sample', 'beginUnixMs': (index + 1) * 1000, 'endUnixMs': (index + 2) * 1000,
                         'cpuPercent': {'8': value / 2, '9': value / 2}, 'logicalCpuSumPercent': value})
        file = self.base / 'generator-cpu.jsonl'
        prefix = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        file.write_bytes(prefix)
        proof = {'file': str(file), 'start': start, 'prefixBytes': len(prefix), 'prefixSha256': summary.sha(file)}
        for index, row in enumerate(self.raw['results']):
            row['before']['time'] = index + 1
            row['after']['time'] = index + 2
            observed = summary.generator_cpu.window_utilization(rows, (index + 1) * 1000, (index + 2) * 1000)
            row['aggregateGeneratorCpu'] = {**observed, 'observation': copy.deepcopy(proof)}
            row['aggregateGeneratorMayLimit'] = observed['contaminated']
        return file

    def test_global_generator_join_accepts_complete_prefix_after_append(self):
        file = self.attach_aggregate_observation()
        with file.open('ab') as stream:
            stream.write(b'{"event":"stop","complete":true}\n')
        self.assertTrue(self.result()['complete'])

    def test_global_generator_missing_observation_is_rejected(self):
        self.attach_aggregate_observation()
        del self.raw['results'][1]['aggregateGeneratorCpu']
        self.assertRejected('aggregate generator observation is missing')

    def test_global_generator_forged_p95_does_not_hide_contamination(self):
        self.attach_aggregate_observation(measure=90)
        self.raw['results'][1]['aggregateGeneratorCpu']['p95LogicalCpuSumPercent'] = 1
        self.assertRejected('window differs from raw observation')

    def test_global_generator_contaminated_measure_rejected_without_reported_interference(self):
        self.attach_aggregate_observation(measure=90)
        self.assertRejected('aggregate generator CPU p95 exceeds 85%')

    def test_global_generator_contaminated_warmup_remains_annotated_and_accepted(self):
        self.attach_aggregate_observation(warmup=90)
        self.assertTrue(self.result()['complete'])

    def test_global_generator_modified_prefix_is_rejected(self):
        file = self.attach_aggregate_observation()
        file.write_bytes(file.read_bytes().replace(b'40', b'41'))
        self.assertRejected('prefix is incomplete or its hash differs')

    def test_valid_raw_has_expected_counts_and_hashes_without_writing(self):
        result = self.result()
        self.assertTrue(result['complete'])
        self.assertEqual(result['groups'][0]['responses'], 10)
        self.assertEqual(result['groups'][0]['metrics']['rps']['values'], [9])
        self.assertEqual(result['inputSha256'][self.file.name], summary.sha(self.file))
        self.assertFalse((self.folder / 'summary.json').exists())

    def test_marker_exists_but_false_does_not_claim_completion(self):
        self.write(self.folder / 'complete.json', {'complete': False})
        self.assertFalse(self.result()['complete'])

    def test_interference_excluded_even_if_raw_claims_complete(self):
        self.raw['backgroundInterference'] = [{'processes': ['cargo']}]
        self.assertRejected('interference')

    def test_duplicate_successes_are_both_excluded(self):
        self.write(self.folder / '01-candidate-attempt2.json', self.raw)
        result = self.result()
        self.assertEqual(len(result['rejected']), 2)
        self.assertFalse(result['complete'])

    def test_error_counts_cannot_hide_under_complete(self):
        self.raw['results'][1]['value']['errors'] = 1
        self.assertRejected('has errors')

    def test_generator_limit_is_recomputed_not_trusted(self):
        self.raw['results'][1]['value']['generatorCpuPercent'] = 90
        self.assertRejected('generator may limit')

    def test_cpu_delta_forgery_rejected(self):
        self.raw['results'][1]['cpuSeconds'] = 0.5
        self.raw['results'][1]['cpuMsPerResponse'] = 50
        self.assertRejected('cumulative CPU delta')

    def test_rps_forgery_rejected(self):
        self.raw['results'][1]['value']['rps'] = 100
        self.assertRejected('throughput arithmetic')

    def test_response_count_cannot_exclude_undrained_requests(self):
        self.raw['results'][1]['value']['started'] = 11
        self.assertRejected('fully drained')

    def test_missing_warmup_is_not_a_valid_measurement(self):
        self.raw['results'].pop(0)
        self.assertRejected('missing or extra phases')

    def test_changed_or_missing_original_config_rejected(self):
        self.raw['configSha256'] = 'bad'
        self.assertRejected('config hash mismatch')
        (self.base / 'configs/probe.json').unlink()
        self.assertRejected('configuration unavailable')

    def test_malformed_attempt_records_rejection(self):
        self.raw['results'] = [None, None]
        self.assertRejected('invalid attempt')

    def test_missing_accounting_is_rejected(self):
        self.raw['results'][1]['samples'] = []
        self.assertRejected('final accounting sample')

    def test_empty_scenarios_are_invalid_configuration(self):
        self.config['scenarios'] = []
        self.write(self.folder / 'config.json', self.config)
        with self.assertRaisesRegex(ValueError, 'scenarios'):
            self.result()

    def test_audit_rejects_summary_tampering(self):
        stored = self.result()
        stored['groups'][0]['responses'] = 999
        self.write(self.folder / 'summary.json', stored)
        check = audit.Audit(self.base, self.base, True)
        # This test isolates aggregation integrity; provenance has separate tests.
        check.command_provenance = lambda *args, **kwargs: None
        check.experiment(self.folder)
        self.assertIn('probe: summary differs from raw evidence: groups', check.errors)

    def test_partial_mode_still_rejects_missing_recorded_source(self):
        check = audit.Audit(self.base, self.base, True)
        self.assertFalse(check.file_hash(self.base / 'removed.rs', 'fake', 'snapshot'))
        self.assertTrue(check.errors)
        self.assertEqual(check.pending, [])

    def test_partial_absence_does_not_establish_final_pass(self):
        check = audit.Audit(self.base, self.base, True)
        check.experiment = lambda *_: None
        result = check.run()
        self.assertTrue(result['passed'])
        self.assertFalse(result['finalVerified'])
        self.assertTrue(result['pending'])

    def test_manifest_rejects_traversal_and_windows_paths(self):
        for name in ['../outside', '/absolute', 'C:/secret', 'one\\two']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit.contained(self.base, name)

    def test_report_local_base_resolves_links_and_detects_missing(self):
        report = self.base / 'report.html'
        (self.base / 'proof.json').write_text('{}')
        report.write_text('<base href="./"><a href="proof.json#part">preuve</a><a href="https://example.com">remote</a>', encoding='utf-8')
        check = audit.Audit(self.base / 'absent-root', self.base, True)
        check.reports()
        self.assertEqual(check.errors, [])
        report.write_text('<a href="missing.json">manquant</a>', encoding='utf-8')
        check.reports()
        self.assertTrue(any('broken local' in error for error in check.errors))

    def runtime_fixture(self):
        build = self.base / 'build'
        (build / 'runtime').mkdir(parents=True)
        (build / 'compat').mkdir()
        values = {'runtime/worker.mjs': 'original worker', 'runtime/env.mjs': 'bundled dotenv', 'runtime/profiles.json': '{}', 'compat/cache.cjs': 'original compatibility', 'compat/image-config.cjs': "'use strict';module.exports={\"path\":\"/app/image\"};\n"}
        for name, content in values.items():
            (build / name).write_text(content)
        hashes = {name: summary.sha(build / name) for name in values}
        contract = {'schema': 1, 'protocol': 2, 'lifecycle': 1, 'capabilities': ['activity', 'tracked-finalization', 'graceful-drain', 'lane-cancellation'], 'modules': hashes}
        self.write(build / 'runtime-contract.json', contract)
        candidate = {'sourceSha256': {'packages/prnext/' + name: value for name, value in hashes.items()}}
        candidate['sourceSha256']['packages/prnext/runtime/env.mjs'] = 'unbundled-source-hash'
        candidate['sourceSha256']['packages/prnext/compat/image-config.cjs'] = 'default-template-source-hash'
        return build, candidate, contract

    def test_runtime_contract_accepts_copies_and_bundled_environment(self):
        build, candidate, _ = self.runtime_fixture()
        check = audit.Audit(self.base, self.base, True)
        check.runtime_contract(build, candidate)
        self.assertEqual(check.errors, [])

    def test_runtime_contract_detects_changed_module_and_omitted_module(self):
        build, candidate, contract = self.runtime_fixture()
        (build / 'runtime/worker.mjs').write_text('tampered worker')
        del contract['modules']['compat/cache.cjs']
        self.write(build / 'runtime-contract.json', contract)
        check = audit.Audit(self.base, self.base, True)
        check.runtime_contract(build, candidate)
        self.assertTrue(any('SHA-256 mismatch' in error for error in check.errors))
        self.assertTrue(any('does not enumerate' in error for error in check.errors))

    def test_runtime_contract_cannot_rehash_modified_copy_to_hide_source_drift(self):
        build, candidate, contract = self.runtime_fixture()
        (build / 'runtime/worker.mjs').write_text('tampered worker')
        contract['modules']['runtime/worker.mjs'] = summary.sha(build / 'runtime/worker.mjs')
        self.write(build / 'runtime-contract.json', contract)
        check = audit.Audit(self.base, self.base, True)
        check.runtime_contract(build, candidate)
        self.assertTrue(any('differs from final source' in error for error in check.errors))

    def test_generated_image_configuration_remains_bound_to_frozen_build(self):
        build, candidate, contract = self.runtime_fixture()
        frozen_modules = dict(contract['modules'])
        (build / 'compat/image-config.cjs').write_text('tampered application image configuration')
        check = audit.Audit(self.base, self.base, True)
        check.runtime_contract(build, candidate)
        self.assertTrue(any('SHA-256 mismatch' in error for error in check.errors))
        # Even rehashing the contract cannot bypass the immutable final build map.
        contract['modules']['compat/image-config.cjs'] = summary.sha(build / 'compat/image-config.cjs')
        self.write(build / 'runtime-contract.json', contract)
        check = audit.Audit(self.base, self.base, True)
        check.runtime_contract(build, candidate)
        self.assertEqual(check.errors, [])
        check.manifest(build, frozen_modules, 'immutable final build')
        self.assertTrue(any('SHA-256 mismatch' in error for error in check.errors))

    def test_final_application_provenance_rejects_other_source_tree(self):
        build, candidate, _ = self.runtime_fixture()
        candidate['sourceTreeDigest'] = 'expected-tree'
        folder = self.base / 'candidates/final'
        folder.mkdir(parents=True)
        self.write(folder / 'application-build.json', {'complete': True, 'sourceTreeDigest': 'other-tree', 'node': 'v24.19.0', 'output': str(build)})
        check = audit.Audit(self.base, self.base, True)
        check.application_build({'candidate': 'final', 'dynamicBuild': {'path': str(build)}, 'staticBuild': {'path': str(build)}}, candidate)
        self.assertIn('application build source tree differs from final snapshot', check.errors)

    def test_documentation_can_change_but_build_and_compat_are_production(self):
        self.assertFalse(audit.production_source('packages/prnext/README.md'))
        self.assertFalse(audit.production_source('packages/prnext/runtime/transport.test.mjs'))
        for name in ['packages/prnext/runtime/transport.mjs', 'packages/prnext/compat/cache.cjs', 'packages/prnext/build/config.mjs']:
            self.assertTrue(audit.production_source(name))


class NextProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.base = self.root / 'artifacts/performance-v5'
        self.base.mkdir(parents=True)
        self.project = self.root / 'artifacts/performance/app'
        self.node = self.root / 'artifacts/performance/node24/node.exe'
        self.node.parent.mkdir(parents=True)
        self.node.write_bytes(b'pinned Node fixture, never executed')
        values = {
            'app/page.mjs': 'app fixture', 'pages/index.mjs': 'pages fixture',
            'public/robots.txt': 'fixture', 'next.config.mjs': 'export default {};',
            'package.json': json.dumps({'dependencies': {'next': '16.3.5'}}),
            'package-lock.json': json.dumps({'packages': {'': {'dependencies': {'next': '16.3.5'}}, 'node_modules/next': {'version': '16.3.5'}}}),
            'node_modules/next/package.json': json.dumps({'name': 'next', 'version': '16.3.5', 'bin': {'next': './dist/bin/next'}}),
            'node_modules/next/dist/bin/next': 'verified CLI fixture',
            '.next/BUILD_ID': 'next-build', '.next/routes-manifest.json': '{}',
            '.next/required-server-files.json': '{}',
        }
        for name, value in values.items():
            file = self.project / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(value, encoding='utf-8')
        self.proof = {'version': '16.3.5'}
        for key, name in [('package', 'node_modules/next/package.json'), ('cli', 'node_modules/next/dist/bin/next'), ('lock', 'package-lock.json')]:
            self.proof[key + 'Path'] = str(self.project / name)
            self.proof[key + 'Sha256'] = summary.sha(self.project / name)
        self.proof['buildPath'] = str(self.project / '.next')
        self.proof['buildSha256'] = {name.removeprefix('.next/'): summary.sha(self.project / name) for name in values if name.startswith('.next/')}
        self.fixture = {'complete': True, 'projectPath': str(self.project), 'sourceSha256': {name: summary.sha(self.project / name) for name in values if not name.startswith(('node_modules/', '.next/'))}, 'next': copy.deepcopy(self.proof)}
        self.write(self.base / 'fixture-evidence.json', self.fixture)
        self.record = {'variant': 'arbitrary-label', 'command': [str(self.node), self.proof['cliPath'], 'start', '-H', '127.0.0.1', '-p', '32900'], 'cwd': str(self.project), 'binarySha256': summary.sha(self.node), 'nodeSha256': summary.sha(self.node), 'nodeVersion': 'v24.19.0', 'next': copy.deepcopy(self.proof)}

    def write(self, file, value):
        file.write_text(json.dumps(value), encoding='utf-8')

    def check(self):
        check = audit.Audit(self.root, self.base, True)
        check.command_provenance(self.record, 'next proof', require_generators=False)
        return check.errors

    def test_valid_explicit_next_provenance_does_not_need_native_registry(self):
        self.assertEqual(self.check(), [])

    def test_next_label_without_provenance_does_not_bypass_native_registry(self):
        self.record['variant'] = 'next'
        del self.record['next']
        self.assertTrue(any('no verified source/build provenance' in error for error in self.check()))

    def test_other_node_binary_cannot_bypass_pinning_with_matching_reported_hash(self):
        other = self.node.with_name('other.exe')
        other.write_bytes(b'another Node')
        self.record['command'][0] = str(other)
        self.record['binarySha256'] = self.record['nodeSha256'] = summary.sha(other)
        self.assertTrue(any('pinned Node executable' in error for error in self.check()))

    def test_next_dev_or_extra_project_argument_is_rejected(self):
        for args in [['dev', '-H', '127.0.0.1', '-p', '32900'], ['start', '.', '-H', '127.0.0.1', '-p', '32900']]:
            with self.subTest(args=args):
                self.record['command'] = [str(self.node), self.proof['cliPath'], *args]
                self.assertTrue(any('Next start invocation' in error for error in self.check()))

    def test_missing_or_different_cwd_cannot_select_other_build(self):
        for cwd in [None, str(self.base)]:
            with self.subTest(cwd=cwd):
                self.record['cwd'] = cwd
                self.assertTrue(any('working directory' in error for error in self.check()))

    def test_rehashed_wrong_package_version_still_fails(self):
        package = pathlib.Path(self.proof['packagePath'])
        self.write(package, {'name': 'next', 'version': '16.3.6', 'bin': {'next': './dist/bin/next'}})
        self.record['next']['packageSha256'] = summary.sha(package)
        self.assertTrue(any('package identity' in error for error in self.check()))

    def test_rehashed_lock_version_drift_still_fails(self):
        lock = pathlib.Path(self.proof['lockPath'])
        self.write(lock, {'packages': {'': {'dependencies': {'next': '16.3.5'}}, 'node_modules/next': {'version': '16.3.6'}}})
        self.record['next']['lockSha256'] = summary.sha(lock)
        self.assertTrue(any('lockfile Next version' in error for error in self.check()))

    def test_cli_outside_package_cannot_be_authenticated_by_self_reported_hash(self):
        other = self.project / 'other-cli.mjs'
        other.write_text('arbitrary server')
        self.record['next']['cliPath'] = self.record['command'][1] = str(other)
        self.record['next']['cliSha256'] = summary.sha(other)
        self.assertTrue(any('installed package entry point' in error for error in self.check()))

    def test_incomplete_build_map_cannot_hide_changed_files(self):
        del self.record['next']['buildSha256']['routes-manifest.json']
        self.assertTrue(any('file membership' in error for error in self.check()))

    def test_fixture_evidence_cannot_omit_source_or_be_absent(self):
        del self.fixture['sourceSha256']['app/page.mjs']
        self.write(self.base / 'fixture-evidence.json', self.fixture)
        self.assertTrue(any('enumerate' in error for error in self.check()))
        (self.base / 'fixture-evidence.json').unlink()
        self.assertTrue(any('requires fixture-evidence' in error for error in self.check()))


if __name__ == '__main__':
    unittest.main()
