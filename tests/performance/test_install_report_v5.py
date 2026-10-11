"""Synthetic files only: no npm, archive command, process, server or network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('install_report_v5', HERE / 'install-report-v5.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)
audit_spec = importlib.util.spec_from_file_location('audit_v5_install_tests', HERE / 'audit-v5.py')
audit = importlib.util.module_from_spec(audit_spec)
audit_spec.loader.exec_module(audit)


def digest(value):
    return hashlib.sha256(value).hexdigest()


class Inputs:
    def __init__(self, base):
        self.base, self.hashes = base, {}

    def relative(self, file):
        return Path(file).relative_to(self.base).as_posix()

    def raw(self, file):
        if not Path(file).is_file():
            return None
        value = Path(file).read_bytes()
        self.hashes[self.relative(file)] = digest(value)
        return value


class InstallProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.folder = self.base / 'install-reproduction'
        self.inputs = Inputs(self.base)

    def write(self, name, value):
        file = self.folder / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value), encoding='utf-8')
        return file

    def record(self, label, command, stdout='', stderr='', code=0, cwd=None):
        out = self.folder / (label + '.stdout.log')
        err = self.folder / (label + '.stderr.log')
        out.write_text(stdout, encoding='utf-8')
        err.write_text(stderr, encoding='utf-8')
        row = {'command': command, 'cwd': str(cwd or self.base), 'startedAt': '2026-10-11T00:00:00Z',
               'stdout': str(out), 'stderr': str(err), 'error': None, 'exitCode': code,
               'stdoutSha256': digest(out.read_bytes()), 'stderrSha256': digest(err.read_bytes()),
               'finishedAt': '2026-10-11T00:00:01Z', 'durationSeconds': 1}
        self.write(label + '.command.json', {**row, 'exitCode': None})
        self.write(label + '.exit.json', row)
        return row

    def fixture(self):
        self.folder.mkdir()
        node, npm = str(self.base / 'node.exe'), str(self.base / 'npm-cli.js')
        tools = {'node': node, 'npmCli': npm, 'nodeVersion': 'v24.19.0',
                 'npmVersion': '11.12.1', 'nodeSha256': report.NODE_SHA}
        harness = b'prepared fixture, never executed'
        (self.folder / 'install-reproduction-v5.py').write_bytes(harness)
        self.write('started.json', {'commit': report.COMMIT, 'harnessSha256': digest(harness)})
        self.record('node-version', [node, '--version'], 'v24.19.0\n')
        self.record('npm-version', [node, npm, '--version'], '11.12.1\n')
        self.record('commit', ['git', 'rev-parse', report.COMMIT + '^{commit}'], report.COMMIT + '\n')
        original = {'README.md': b'original source', 'package.json': b'{"name":"fixture"}', 'package-lock.json': b'{"packages":{}}'}
        fixed = {**original, 'package-lock.json': b'{"packages":{"fixed":{}}}'}
        self.addCleanup(patch.stopall)
        patch.object(report, 'LOCK_SHA', digest(fixed['package-lock.json'])).start()
        archive = self.folder / 'reference.zip'
        with zipfile.ZipFile(archive, 'w') as stream:
            stream.comment = report.COMMIT.encode('ascii')
            for name, value in original.items():
                stream.writestr(name, value)
        self.record('git-archive', ['git', 'archive', '--format=zip', '--output=' + str(archive), report.COMMIT])
        before = {label: {name: digest(value) for name, value in files.items()}
                  for label, files in [('original', original), ('lock-fixed', fixed)]}
        self.write('sources-before.json', before)
        missing = [name + '@0.1.11-alpha' for name in report.NATIVE]
        runs = []
        for label, files in [('original', original), ('lock-fixed', fixed)]:
            for name, value in files.items():
                file = self.folder / label / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(value)
            error = 'npm error code EUSAGE\n' + ''.join('npm error Missing: ' + name + ' from lock file\n' for name in missing) if label == 'original' else ''
            row = self.record(label, [node, npm, *report.FLAGS], stderr=error,
                              stdout='added 308 packages\n' if label == 'lock-fixed' else '',
                              code=1 if label == 'original' else 0, cwd=self.folder / label)
            self.write(label + '.sources-after.json', before[label])
            row.update(label=label, scriptsEnabled=True, optionalDependenciesEnabled=True,
                       sourceChanges=[], lockSha256Before=before[label]['package-lock.json'],
                       lockSha256After=before[label]['package-lock.json'],
                       allMissingEntries=missing if label == 'original' else [],
                       missingNativeEntries=report.NATIVE if label == 'original' else [],
                       observedEusage=(label == 'original'), installedVersions=report.INSTALLED if label == 'lock-fixed' else {})
            runs.append(row)
        for name, version in report.INSTALLED.items():
            self.write('lock-fixed/node_modules/' + name + '/package.json', {'version': version})
        result = {'complete': True, 'expectedOutcomeMatched': True, 'referenceCommit': report.COMMIT,
                  'tools': tools, 'archiveSha256': digest(archive.read_bytes()), 'sourceFileCount': len(original),
                  'sourceDifferences': ['package-lock.json'], 'runs': runs, 'rootLockStillUnchanged': True, 'error': None}
        self.write('result.json', result)
        return result

    def test_absent_does_not_claim_success_or_create_links(self):
        value = report.collect(self.inputs)
        self.assertFalse(value['verified'])
        self.assertFalse(value['present'])
        html = report.render(value)
        self.assertIn('non exécutée', html)
        self.assertNotIn('<a ', html)
        self.assertNotIn('original échoue', html)

    def test_complete_raw_evidence_is_verified(self):
        self.fixture()
        value = report.collect(self.inputs)
        self.assertTrue(value['verified'], value['issues'])
        self.assertEqual([v['missingCount'] for v in value['runs']], [6, 0])
        html = report.render(value, self.base)
        self.assertIn('scripts et dépendances optionnelles actifs', html)
        self.assertIn('href="install-reproduction/result.json"', html)
        self.assertNotIn(str(self.base), html)

    def test_declared_success_without_raw_logs_is_rejected(self):
        self.fixture()
        (self.folder / 'original.stderr.log').unlink()
        value = report.collect(self.inputs)
        self.assertFalse(value['verified'])
        self.assertNotIn('original échoue', report.render(value))

    def test_audit_entry_point_shares_report_checks_and_hashes(self):
        self.fixture()
        value = report.verify(self.base)
        self.assertTrue(value['verified'], value['issues'])
        self.assertIn('install-reproduction/result.json', value['inputSha256'])

    def test_partial_audit_marks_absent_installation_pending(self):
        check = audit.Audit(self.base, self.base, partial=True)
        check.installation()
        self.assertEqual(check.errors, [])
        self.assertEqual(len(check.pending), 1)
        self.assertFalse(check.installation_result['verified'])

    def test_final_audit_requires_installation(self):
        check = audit.Audit(self.base, self.base)
        check.installation()
        self.assertEqual(len(check.errors), 1)
        self.assertEqual(check.pending, [])

    def test_audit_links_verified_installation_to_current_lock(self):
        self.fixture()
        (self.base / 'package-lock.json').write_bytes((self.folder / 'lock-fixed/package-lock.json').read_bytes())
        check = audit.Audit(self.base, self.base)
        with patch.object(audit, 'installation_verifier', return_value=report):
            check.installation()
        self.assertEqual(check.errors, [])
        self.assertTrue(check.installation_result['verified'])
        (self.base / 'package-lock.json').write_bytes(b'changed')
        with patch.object(audit, 'installation_verifier', return_value=report):
            check.installation()
        self.assertTrue(any('current lockfile' in error for error in check.errors))

    def test_partial_audit_rejects_forged_present_success(self):
        self.fixture()
        (self.folder / 'original.stderr.log').write_text('forged', encoding='utf-8')
        check = audit.Audit(self.base, self.base, partial=True)
        with patch.object(audit, 'installation_verifier', return_value=report):
            check.installation()
        self.assertTrue(check.errors)
        self.assertFalse(check.installation_result['verified'])

    def test_modified_stdout_hash_is_rejected(self):
        self.fixture()
        (self.folder / 'lock-fixed.stdout.log').write_text('forged', encoding='utf-8')
        self.assertFalse(report.collect(self.inputs)['verified'])

    def test_scripts_disabled_is_rejected_even_with_zero_exit(self):
        data = self.fixture()
        data['runs'][1]['scriptsEnabled'] = False
        self.write('result.json', data)
        self.assertFalse(report.collect(self.inputs)['verified'])

    def test_seventh_missing_is_rejected_even_when_rehashed(self):
        data = self.fixture()
        record = data['runs'][0]
        file = self.folder / 'original.stderr.log'
        file.write_text(file.read_text(encoding='utf-8') + 'npm error Missing: unexpected@1.0.0 from lock file\n', encoding='utf-8')
        record['stderrSha256'] = digest(file.read_bytes())
        record['allMissingEntries'].append('unexpected@1.0.0')
        raw = json.loads((self.folder / 'original.exit.json').read_text(encoding='utf-8'))
        raw['stderrSha256'] = record['stderrSha256']
        self.write('original.exit.json', raw)
        self.write('result.json', data)
        self.assertFalse(report.collect(self.inputs)['verified'])

    def test_source_tampering_is_rejected(self):
        self.fixture()
        (self.folder / 'lock-fixed/README.md').write_text('changed', encoding='utf-8')
        self.assertFalse(report.collect(self.inputs)['verified'])

    def test_installed_package_version_is_checked(self):
        self.fixture()
        self.write('lock-fixed/node_modules/typescript/package.json', {'version': '0.0.0'})
        self.assertFalse(report.collect(self.inputs)['verified'])

    def test_incomplete_is_not_success(self):
        data = self.fixture()
        data['complete'] = False
        self.write('result.json', data)
        value = report.collect(self.inputs)
        self.assertFalse(value['verified'])
        self.assertIn('réussite non confirmée', value['state'])


if __name__ == '__main__':
    unittest.main()
