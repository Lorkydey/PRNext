"""The v5 report must not promote incomplete or stale evidence to validation."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('report_v5', pathlib.Path(__file__).with_name('report-v5.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')


def fixture(base):
    folder = base / 'experiments' / 'case'
    binary = base / 'native.exe'
    binary.write_bytes(b'frozen binary')
    command = [str(binary), 'start', 'fixture', '--profile', 'balanced']
    config = {'name': 'case', 'warmup': 5, 'seconds': 10, 'repeats': 1,
              'scenarios': [['ssr', 1]], 'variants': [{'name': 'v4', 'command': command}]}
    write(base / 'configs/case.json', config)
    write(folder / 'config.json', config)
    rows = []
    for phase, duration in [('warmup', 5), ('measure', 10)]:
        before = {'cpuSeconds': 1, 'totalProcesses': 2, 'rssMiB': 10, 'threads': 4}
        after = {**before, 'cpuSeconds': 2}
        rows.append({'route': 'ssr', 'connections': 1, 'phase': phase,
                     'value': {'durationSeconds': duration, 'count': 100, 'started': 100, 'completedWithinWindow': 100,
                               'rps': 100 / duration, 'errors': 0, 'statuses': {'200': 100}, 'connections': 1,
                               'generatorCpuPercent': 20, 'p50': 1, 'p95': 2, 'p99': 3, 'bytes': 1000},
                     'cpuMsPerResponse': 10, 'cpuSeconds': 1, 'processesStarted': 0, 'generatorMayLimit': False,
                     'before': before, 'after': after, 'samples': [after], 'rssMedianMiB': 10})
    raw = {'complete': True, 'variant': 'v4', 'repeat': 1, 'attempt': 1, 'command': command, 'environment': {},
           'serverCpu': 10, 'generatorCpus': [8, 9], 'results': rows,
           'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
           'configSha256': hashlib.sha256((base / 'configs/case.json').read_bytes()).hexdigest()}
    write(folder / '01-v4-attempt1.json', raw)
    write(folder / 'complete.json', {'complete': True})
    report.summarizer().summarize_folder(folder, write=True)
    return folder, raw, binary


def policy_fixture(base):
    folder = base / 'experiments/v8-policy-verified'
    folder.mkdir(parents=True)
    node = base / 'node.exe'
    node.write_bytes(b'exact node fixture')
    variants = []
    for name, requested, effective in [('size-8', 8, 1), ('no-size-8', 8, 8), ('no-size-4', 4, 4), ('no-size-2', 2, 2)]:
        observation = {'worker': {'samples': [{'resourceLimits': {'maxYoungGenerationSizeMb': 16},
                                               'spaces': [{'space_name': 'new_space', 'space_size': 2 * 1048576}]}]}}
        row = {'name': name, 'flags': [f'--max-semi-space-size={requested}'], 'code': 0, 'flagExitCode': 0,
               'error': None, 'signal': None, 'effectiveSemiSpaceMiB': effective, 'observation': observation}
        logs = [('flags.stdout.log', 'flagStdoutSha256', f'  --max_semi_space_size={effective}\r\n'),
                ('flags.stderr.log', 'flagStderrSha256', ''), ('stderr.log', 'observationStderrSha256', ''),
                ('stdout.log', 'observationStdoutSha256', 'PRNEXT_V8_POLICY_RESULT ' + json.dumps(observation) + '\n')]
        for suffix, field, text in logs:
            raw = text.encode('utf-8')
            (folder / (name + '.' + suffix)).write_bytes(raw)
            row[field] = hashlib.sha256(raw).hexdigest()
        variants.append(row)
    write(folder / 'result.json', {'complete': True, 'variants': variants, 'node': str(node),
                                  'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest()})
    return folder


class ReportV5Tests(unittest.TestCase):
    def test_final_label_requires_completed_verified_measurements(self):
        def item(state='terminé — résultats exploratoires', groups=True, issues=False):
            return {'state': state, 'groups': [{}] if groups else [], 'issues': ['invalid'] if issues else []}

        final = item()
        report.label_experiment(final, True, True)
        self.assertEqual(final['state'], 'terminé — résultats finaux')
        self.assertTrue(final['final'])
        exploratory = item()
        report.label_experiment(exploratory, False, True)
        self.assertEqual(exploratory['state'], 'terminé — résultats exploratoires')
        self.assertFalse(exploratory['final'])
        pending = item()
        report.label_experiment(pending, True, False)
        self.assertIn('validation globale en cours', pending['state'])
        for incomplete in [item('incomplet', groups=False), item(issues=True)]:
            state = incomplete['state']
            report.label_experiment(incomplete, True, True)
            self.assertEqual(incomplete['state'], state)

    def test_soak_windows_are_disjoint_and_keep_final_drain_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'final.json', {'complete': False, 'binarySha256': 'final', 'idleFiles': []})
            samples = [{'time': 1000 + seconds, 'rssMiB': rss, 'privateCommitMiB': rss + 10,
                        'threads': 5, 'handles': 200 + rss, 'processes': processes}
                       for seconds, rss, processes in [(0.5, 10, 2), (899.5, 11, 2),
                           (900, 20, 3), (1799.5, 21, 3), (1800, 30, 4),
                           (3542, 31, 4), (3599.5, 32, 4), (3600, 99, 5), (3602, 100, 5)]]
            load = {'label': 'mixed-one-hour', 'before': {'time': 1000}, 'after': samples[-1],
                    'samples': samples, 'cpuSeconds': 10, 'rssMedianMiB': 30, 'rssMaxMiB': 100,
                    'processesStarted': 3, 'value': {'errors': 0, 'validationErrors': 0, 'exitCode': 0,
                    'count': 1000, 'durationSeconds': 3600, 'elapsedSeconds': 3602}}
            write(base / 'soak/result.json', {'complete': True, 'binarySha256': 'final',
                                             'instrumented': True, 'results': [load]})
            final = report.final_evidence(report.Inputs(base))
            windows = final['soak']['windows']
            self.assertEqual([(row['start'], row['end']) for row in windows],
                             [(0, 900), (900, 1800), (1800, 3600), (3542, 3602)])
            self.assertEqual([row['rssMiB']['values'] for row in windows],
                             [[10, 11], [20, 21], [30, 31, 32], [31, 32, 99, 100]])
            self.assertEqual([row['processes']['median'] for row in windows], [2, 3, 4, 4.5])
            self.assertEqual([row['lastMinuteObservation'] for row in windows], [False, False, False, True])
            data = report.collect(base)
            page = report.render(data, base)
            self.assertIn('fenêtres disjointes 0–15, 15–30 et 30–60 min', page)
            self.assertIn('(dernière minute)', page)
            self.assertIn('peut inclure le drainage', page)
            self.assertIn('Métriques de workers activées pour cette endurance instrumentée', page)
            self.assertIn('leur coût est inclus', page)
            data['final']['soak']['instrumented'] = False
            self.assertNotIn('Métriques de workers activées pour cette endurance instrumentée', report.render(data, base))
            data['final']['soak']['instrumented'] = None
            self.assertIn('État de l’instrumentation non renseigné', report.render(data, base))

    def test_idle_resources_use_final_private_commit_and_handles(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'final.json', {'complete': False, 'binarySha256': 'final',
                                       'idleFiles': ['idle/memory/result.json']})
            write(base / 'idle/memory/result.json', {'complete': True, 'binarySha256': 'final',
                  'results': [{'label': 'cycle-1-rest-60-idle', 'elapsedSeconds': 60, 'cpuPercent': 0.01,
                    'before': {'privateCommitMiB': 80, 'handles': 500},
                    'after': {'rssMiB': 20, 'privateCommitMiB': 7.5, 'handles': 123, 'threads': 8, 'processes': 2},
                    'processesStarted': 0, 'value': None}]})
            data = report.collect(base)
            row = data['final']['idle'][0]['rows'][0]
            self.assertEqual(row['privateCommitMiB'], 7.5)
            self.assertEqual(row['handles'], 123)
            self.assertEqual(row['processes'], 2)
            page = report.render(data, base)
            self.assertIn('Commit privé final Mio', page)
            self.assertIn('Handles finaux', page)
            self.assertIn('pas observés de 15,625 ms', page)
            self.assertIn('Ce zéro ne signifie pas une absence de travail CPU', page)

    def test_lifecycle_absence_and_lane_discard_semantics_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            data = report.collect(base)
            self.assertEqual(data['lifecycle']['state'], 'not-run')
            page = report.render(data, base)
            self.assertIn('Cycle de vie des workers', page)
            self.assertIn('laneDiscards', page)
            self.assertIn('pas des hôtes tués', page)
            self.assertIn('Métriques cumulatives absentes', page)

    def test_complete_experiment_keeps_ranges_and_does_not_imply_final_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            fixture(base)
            data = report.collect(base)
            item = next(item for item in data['experiments'] if item['name'] == 'case')
            self.assertEqual(item['groups'][0]['metrics']['rps'], {'median': 10, 'min': 10, 'max': 10, 'values': [10]})
            self.assertFalse(item['final'])
            self.assertIn('absent', data['final']['state'])

    def test_existing_false_marker_and_stale_summary_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            folder, raw, _ = fixture(base)
            write(folder / 'complete.json', {'complete': False})
            self.assertEqual(report.experiment(report.Inputs(base), 'case', report.summarizer())['groups'], [])
            write(folder / 'complete.json', {'complete': True})
            raw['results'][1]['value']['p99'] = 99
            write(folder / '01-v4-attempt1.json', raw)
            item = report.experiment(report.Inputs(base), 'case', report.summarizer())
            self.assertEqual(item['groups'], [])
            self.assertTrue(item['issues'])

    def test_changed_binary_and_failed_attempt_remain_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            folder, raw, binary = fixture(base)
            binary.write_bytes(b'changed')
            item = report.experiment(report.Inputs(base), 'case', report.summarizer())
            self.assertEqual(item['groups'], [])
            self.assertEqual(item['attempts'][0]['binaryState'], 'DIFFÉRENTE')
            raw['complete'] = False
            raw['results'][0]['value']['errors'] = 2
            write(folder / '01-v4-attempt1.json', raw)
            item = report.experiment(report.Inputs(base), 'case', report.summarizer())
            self.assertEqual(item['attempts'][0]['errors'], 2)
            self.assertTrue(item['rejected'])

    def test_truncated_json_and_html_escaping(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / 'environment.json').write_text('{', encoding='utf-8')
            write(base / 'experiments/ledger.json', {'experiments': [{'id': '<script>x</script>', 'reason': 'écritures'}]})
            data = report.collect(base)
            page = report.render(data, base)
            self.assertNotIn('<script>x</script>', page)
            self.assertIn('&lt;script&gt;x&lt;/script&gt;', page)
            self.assertIn('écritures', page)
            self.assertIn('écriture en cours', page)
            self.assertNotIn(chr(65533), page)

    def test_incomplete_final_manifest_cannot_claim_success(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'final.json', {'complete': True, 'generation': 'v5'})
            data = report.collect(base)
            self.assertIn('incohérente', data['final']['state'])
            self.assertTrue(data['final']['issues'])
            self.assertEqual(data['final']['tests'], [])

    def test_comparison_preserves_cpu_and_tail_regression(self):
        config = {'variants': [{'name': name, 'command': ['native', '--profile', 'memory']} for name in ('v4', 'v5')]}
        groups = [{'variant': name, 'route': 'stream', 'connections': 128,
                   'metrics': {key: {'median': value} for key, value in zip(('rps','cpuMsPerResponse','rssMiB','p95','p99'), values)}}
                  for name, values in [('v4', [100, 2, 50, 10, 20]), ('v5', [120, 2.2, 55, 11, 24])]]
        row = report.deltas(groups, config)[0]
        self.assertAlmostEqual(row['rps'], 20)
        self.assertAlmostEqual(row['cpuMsPerResponse'], 10)
        self.assertAlmostEqual(row['p99'], 20)

    def test_next_comparison_matches_load_and_keeps_profile_regressions(self):
        config = {'variants': [{'name': 'next', 'command': ['node', 'next', 'start']},
                              {'name': 'v5-memory', 'command': ['native', '--profile', 'memory']},
                              {'name': 'v5-balanced', 'command': ['native', '--profile', 'balanced']}]}
        def group(name, route, connections, values):
            return {'variant': name, 'route': route, 'connections': connections,
                    'metrics': {key: {'median': value} for key, value in zip(('rps','cpuMsPerResponse','rssMiB','p95','p99'), values)}}
        groups = [group('next', 'ssr', 64, [100, 10, 400, 20, 30]),
                  group('next', 'ssr', 1, [9999, 1, 1, 1, 1]),
                  group('v5-memory', 'ssr', 64, [90, 11, 100, 22, 33]),
                  group('v5-balanced', 'ssr', 64, [120, 8, 200, 16, 24]),
                  group('v5-memory', 'unmatched', 64, [1, 1, 1, 1, 1])]
        rows = report.next_deltas(groups, config)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['profile'], 'memory')
        self.assertAlmostEqual(rows[0]['rps'], -10)
        self.assertAlmostEqual(rows[0]['cpuMsPerResponse'], 10)
        self.assertAlmostEqual(rows[0]['rssMiB'], -75)
        self.assertAlmostEqual(rows[0]['p99'], 10)
        self.assertAlmostEqual(rows[1]['rps'], 20)

    def test_next_comparison_requires_unique_reference_and_avoids_zero_division(self):
        config = {'variants': [{'name': 'next', 'command': ['node']},
                              {'name': 'v5', 'command': ['native', '--profile', 'speed']}]}
        groups = [{'variant': name, 'route': 'api/json', 'connections': 64,
                   'metrics': {'rps': {'median': value}, 'p99': {'median': 0}}} for name, value in [('next', 0), ('v5', 10)]]
        row = report.next_deltas(groups, config)[0]
        self.assertIsNone(row['rps'])
        self.assertIsNone(row['p99'])
        self.assertIsNone(row['rssMiB'])
        self.assertEqual(report.next_deltas(groups, {'variants': config['variants'][1:]}), [])
        config['variants'].append(config['variants'][0])
        self.assertEqual(report.next_deltas(groups, config), [])

    def test_functional_evidence_requires_complete_checks_and_final_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'final.json', {'complete': False, 'binarySha256': 'final',
                                       'functionalFiles': ['functional-final/result.json', 'static-mutations-final/result.json']})
            functional = {'complete': True, 'binarySha256': 'final', 'checks': [{'script': 'validate.mjs', 'exitCode': 0}]}
            write(base / 'functional-final/result.json', functional)
            write(base / 'static-mutations-final/result.json', {'complete': True, 'binarySha256': 'old', 'checks': ['path check']})
            final = report.final_evidence(report.Inputs(base))
            self.assertTrue(final['functional'][0]['state'].startswith('terminé,'))
            self.assertFalse(final['functional'][1]['state'].startswith('terminé,'))
            self.assertIn('en cours', final['state'])
            functional['checks'][0]['exitCode'] = 1
            write(base / 'functional-final/result.json', functional)
            final = report.final_evidence(report.Inputs(base))
            self.assertFalse(final['functional'][0]['state'].startswith('terminé,'))
            functional['checks'] = []
            write(base / 'functional-final/result.json', functional)
            self.assertFalse(report.final_evidence(report.Inputs(base))['functional'][0]['state'].startswith('terminé,'))

    def test_discovers_manifest_explorations_and_config_only_experiments(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'final.json', {'complete': False, 'exploratoryExperiments': ['future-declared-trial']})
            write(base / 'experiments/config-only/config.json', {'name': 'config-only'})
            data = report.collect(base)
            cases = {item['name']: item for item in data['experiments']}
            self.assertIn('future-declared-trial', cases)
            self.assertIn('config-only', cases)
            for name in ('size-space', 'memory28', 'native2-static', 'native2-dynamic', 'future-declared-trial', 'config-only'):
                self.assertFalse(cases[name]['final'])
                self.assertEqual(cases[name]['groups'], [])

    def test_policy_requires_raw_flag_and_worker_observations_and_keeps_failed_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            folder = policy_fixture(base)
            write(base / 'experiments/v8-policy/result.json', {'complete': False, 'variants': [{'name': 'size-8', 'code': 0}]})
            values = report.mechanism_probes(report.Inputs(base))
            failed = next(item for item in values if item['source'] == 'experiments/v8-policy/result.json')
            verified = next(item for item in values if item['source'].startswith('experiments/v8-policy-verified/'))
            self.assertIn('exclu', failed['state'])
            self.assertEqual(failed['rows'][0]['code'], 0)
            self.assertIn('vérifiée', verified['state'])
            self.assertEqual(verified['rows'][0]['effectiveSemiSpaceMiB'], 1)
            self.assertEqual(verified['rows'][0]['workerYoungLimitMiB'], 16)
            self.assertEqual(verified['rows'][0]['workerCommittedNewSpaceMiB'], 2)
            (folder / 'size-8.flags.stdout.log').write_text('--max-semi-space-size=8\n', encoding='utf-8')
            changed = next(item for item in report.mechanism_probes(report.Inputs(base)) if item['source'].startswith('experiments/v8-policy-verified/'))
            self.assertIn('exclu', changed['state'])
            self.assertTrue(changed['issues'])
            self.assertIsNone(changed['rows'][0]['effectiveSemiSpaceMiB'])

    def test_public_probe_rejects_missing_raw_provenance_and_keeps_failure_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            write(base / 'experiments/public-probe/first/result.json', {'complete': True, 'groups': [{'fake': 'summary'}]})
            write(base / 'experiments/public-probe/failed/result.json', {'complete': False, 'error': 'compile failed'})
            values = report.mechanism_probes(report.Inputs(base))
            self.assertEqual(len(values), 2)
            self.assertTrue(all('exclu' in item['state'] and not item['rows'] and item['issues'] for item in values))
            page = report.render_mechanism_probes(values, base)
            self.assertIn('compile failed', page)
            self.assertNotIn('fake', page)

    def test_absent_gc_etw_remain_explicit_and_inventoried(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            data = report.collect(base)
            self.assertTrue(all(item['state'].startswith('non exécuté') for item in data['diagnostics'].values()))
            self.assertTrue(any(name.endswith('diagnostic-report-v5.py') for name in data['hashes']))
            page = report.render(data, base)
            self.assertIn('href="#diagnostics"', page)
            self.assertIn('Diagnostics instrumentés GC et ETW', page)
            self.assertNotIn('href="diagnostics/gc/result.json"', page)

    def test_compatibility_review_keeps_final_validation_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            review = {'complete': True, 'testsExecutedByThisReview': False, 'finalCandidateValidated': False,
                      'retainedV4': [{'topic': 'reactCompiler et typedRoutes', 'supported': 'false', 'limits': '<unsafe>'},
                                     {'topic': 'typescript', 'supported': ['contrôle explicite'], 'limits': ['pas de plugin Next']}],
                      'newV5': [{'topic': 'Override V8', 'conclusion': 'respecte la valeur explicite', 'defaultsChangedByThisFix': False}],
                      'observedValidation': {'v5ExploratoryUnit': {'tests': 987654, 'pass': 987654}}}
            write(base / 'compatibility-review.json', review)
            item = report.compatibility(report.Inputs(base))
            self.assertFalse(item['issues'])
            page = report.render_compatibility(item, base)
            self.assertIn('reactCompiler:false', page)
            self.assertIn('next-env.d.ts', page)
            self.assertIn('Corrections conservées de v4', page)
            self.assertIn('Correction nouvelle en v5', page)
            self.assertIn('&lt;unsafe&gt;', page)
            self.assertNotIn('987654', page)
            self.assertNotIn('<unsafe>', page)

    def test_compatibility_missing_or_stale_is_not_promoted_to_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            missing = report.compatibility(report.Inputs(base))
            self.assertEqual(missing['state'], 'revue absente')
            write(base / 'compatibility-review.json', {'complete': True, 'testsExecutedByThisReview': False,
                  'sourceSha256': {'tests/performance/report-v5.py': 'wrong-hash'}})
            stale = report.compatibility(report.Inputs(base))
            self.assertTrue(stale['issues'])
            self.assertIn('à actualiser', stale['state'])

    def test_lead_summary_never_uses_exploratory_or_incomplete_final_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            data = report.collect(base)
            metric = {name: {'median': 123456} for name in ('rps', 'cpuMsPerResponse', 'rssMiB', 'p99')}
            data['experiments'] = [{'name': 'final-dynamic', 'final': True, 'issues': [],
                                   'groups': [{'variant': 'v4-balanced', 'route': 'ssr', 'connections': 64, 'metrics': metric},
                                              {'variant': 'v5-balanced', 'route': 'ssr', 'connections': 64, 'metrics': metric}]}]
            self.assertEqual(report.final_summary_pairs(data), [])
            section = report.render_summary(data, base)
            self.assertIn('non validée', section)
            self.assertNotIn('123', section)
            self.assertNotIn('Comparaison finale compacte', section)
            data['final'].update(manifest={'complete': True}, state='terminé', issues=[])
            data['experiments'][0]['final'] = False
            self.assertEqual(report.final_summary_pairs(data), [])

    def test_lead_summary_retains_regressions_and_links_to_final_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            data = report.collect(base)
            data['final'].update(manifest={'complete': True}, state='terminé', issues=[])
            groups = [{'variant': name, 'route': 'stream', 'connections': 128,
                       'metrics': {metric: {'median': value} for metric, value in zip(('rps','cpuMsPerResponse','rssMiB','p99'), values)}}
                      for name, values in [('v4-memory', [100, 2, 100, 30]), ('v5-memory', [110, 2.2, 105, 33])]]
            data['experiments'] = [{'name': 'final-dynamic', 'final': True, 'issues': [], 'groups': groups}]
            pair = report.final_summary_pairs(data)[0]
            self.assertAlmostEqual(pair['metrics']['cpuMsPerResponse']['delta'], 10)
            self.assertAlmostEqual(pair['metrics']['rssMiB']['delta'], 5)
            section = report.render_summary(data, base)
            self.assertIn('href="#experiment-final-dynamic"', section)
            self.assertIn('défavorables', section)
            data['final']['issues'] = ['hash differs']
            self.assertEqual(report.final_summary_pairs(data), [])

    def test_lead_summary_precedes_exploratory_decisions(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            page = report.render(report.collect(base), base)
            self.assertLess(page.index('<h2>Synthèse</h2>'), page.index('<h2 id="decisions">'))
            self.assertIn('RSS peut donc inclure', page)


if __name__ == '__main__':
    unittest.main()
