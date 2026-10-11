"""Read-only V5 provenance/accounting audit (no server, compiler or network).

--partial validates available evidence without pretending the final campaign ran.
Without it, final.json and every named final proof are required. Only the audit
JSON itself is written; snapshots, raw attempts and summaries are never repaired.
"""
import argparse
import datetime
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import pathlib
import re
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('summary_v5', pathlib.Path(__file__).with_name('summarize-v5.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)
spec = importlib.util.spec_from_file_location('generator_cpu_v5', pathlib.Path(__file__).with_name('generator-cpu-v5.py'))
generator_cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator_cpu)


def read(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def installation_verifier():
    source = pathlib.Path(__file__).with_name('install-report-v5.py')
    spec = importlib.util.spec_from_file_location('v5_installation_audit', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def native_sources(values):
    return {n: h for n, h in values.items() if n.startswith('crates/') or n in ['Cargo.toml', 'Cargo.lock', 'packages/prnext/runtime/profiles.json']}


def production_source(name):
    return name in ['Cargo.toml', 'Cargo.lock'] or name.startswith(('crates/', 'packages/prnext/')) and not name.endswith(('.test.mjs', '.md'))


def contained(root, name):
    """Manifest names must stay under their root, including symlink resolution."""
    pure = pathlib.PurePosixPath(name)
    if not name or '\\' in name or ':' in name or pure.is_absolute() or '..' in pure.parts:
        raise ValueError('unsafe manifest path: ' + name)
    file = (root / name).resolve()
    if not file.is_relative_to(root.resolve()):
        raise ValueError('manifest path escapes root: ' + name)
    return file


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.base = None
        self.targets = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'base':
            self.base = attrs.get('href')
        for name in ['href', 'src']:
            if name in attrs and tag != 'base':
                self.targets.append(attrs[name])


class Audit:
    def __init__(self, root, base, partial=False):
        self.root, self.base, self.partial = pathlib.Path(root), pathlib.Path(base), partial
        self.errors, self.pending, self.notes = [], [], []
        self.checks = 0
        self.hashes = {}
        self.candidates, self.binaries, self.experiments = {}, {}, {}
        self.fixture = None
        self.generator_windows = []
        self.installation_result = None
        self.totals = {'acceptedMeasuredResponses': 0, 'acceptedWarmupResponses': 0, 'sustainedResponses': 0, 'plannedDisconnects': 0, 'errors': 0}

    def check(self, condition, description):
        self.checks += 1
        if not condition:
            self.errors.append(description)
        return bool(condition)

    def require(self, file, description):
        if file.is_file():
            return True
        (self.pending if self.partial else self.errors).append(description + ': missing ' + str(file))
        return False

    def installation(self):
        file = self.base / 'install-reproduction/result.json'
        self.installation_result = {'present': file.is_file(), 'verified': False,
                                    'source': 'install-reproduction/result.json'}
        if not self.require(file, 'isolated original/fixed npm ci reproduction'):
            return
        self.installation_result = installation_verifier().verify(self.base)
        self.installation_result['verifierSha256'] = self.sha(pathlib.Path(__file__).with_name('install-report-v5.py'))
        if self.check(self.installation_result['verified'], 'isolated npm ci reproduction not verified: '
                      + '; '.join(self.installation_result.get('issues', []))):
            self.file_hash(self.root / 'package-lock.json', self.installation_result['lockSha256'],
                           'current lockfile differs from the verified clean installation')

    def sha(self, file):
        file = pathlib.Path(file).resolve()
        stat = file.stat()
        key = (str(file), stat.st_size, stat.st_mtime_ns)
        if key not in self.hashes:
            self.hashes[key] = hashlib.sha256(file.read_bytes()).hexdigest()
        return self.hashes[key]

    def file_hash(self, file, expected, label):
        return self.check(file.is_file(), label + ': recorded file is missing ' + str(file)) and self.check(self.sha(file) == expected, label + ': SHA-256 mismatch ' + str(file))

    def manifest(self, root, values, label, exact=False, exclude_cache=False):
        if not self.check(isinstance(values, dict) and bool(values), label + ': empty or invalid hash map'):
            return
        for name, expected in values.items():
            self.file_hash(contained(root, name), expected, label)
        if exact and root.is_dir():
            names = {f.relative_to(root).as_posix() for f in root.rglob('*') if f.is_file() and not (exclude_cache and any(p in ['cache', '.cache'] for p in f.relative_to(root).parts))}
            self.check(names == set(values), label + ': file membership differs from recorded map')

    def reference(self):
        folder = self.base / 'reference-v4'
        if not self.require(folder / 'reference.json', 'frozen V4 reference'):
            return
        record = read(folder / 'reference.json')
        self.check(record.get('baseline') == 'final-v4', 'reference baseline must be final-v4')
        values = record['sourceSha256']
        self.check(len(values) == 736, 'frozen V4 source manifest must have the original 736 files')
        self.check(digest(values) == record['sourceTreeDigest'], 'reference source tree digest')
        # V4's original freeze schema did not include profiles.json in this
        # digest; the full source map above still authenticates that file.
        compiled = {n: h for n, h in values.items() if n.startswith('crates/') or n in ['Cargo.toml', 'Cargo.lock']}
        self.check(digest(compiled) == record['compiledRustSourceDigest'], 'reference compiled native source digest')
        self.manifest(folder / 'source', values, 'reference source', exact=True)
        self.file_hash(folder / 'prnext-v4.exe', record['binarySha256'], 'reference binary')
        self.binaries.setdefault(record['binarySha256'], set()).add('reference-v4')
        self.manifest(folder / 'dynamic-build', record['dynamicBuild'], 'reference dynamic build', exact=True)
        self.manifest(folder / 'static-build', record['staticBuild'], 'reference static build', exact=True)

    def candidate_snapshots(self):
        for folder in sorted((self.base / 'candidates').glob('*')):
            if not folder.is_dir() or not self.require(folder / 'source.json', 'candidate ' + folder.name):
                continue
            record = read(folder / 'source.json')
            values = record['sourceSha256']
            self.check(record.get('name') == folder.name, 'candidate name ' + folder.name)
            self.check(digest(values) == record['sourceTreeDigest'], 'candidate tree digest ' + folder.name)
            self.check(digest(native_sources(values)) == record['rustSourceDigest'], 'candidate native digest ' + folder.name)
            # Build tools may add generated files; every input remains immutable.
            self.manifest(folder / 'source', values, 'candidate source ' + folder.name)
            self.candidates[folder.name] = record
            if not (folder / 'build.json').is_file():
                self.notes.append('Candidate without native build: ' + folder.name)
                continue
            build = read(folder / 'build.json')
            self.check(build.get('sourceTreeDigest') == record['sourceTreeDigest'], 'candidate build source linkage ' + folder.name)
            if build.get('exitCode') != 0:
                self.notes.append('Failed native experiment, not usable as a final binary: ' + folder.name)
                continue
            self.file_hash(folder / 'prnext.exe', build['binarySha256'], 'candidate binary ' + folder.name)
            self.binaries.setdefault(build['binarySha256'], set()).add(folder.name)

    def command_provenance(self, record, label, require_generators=True):
        command = record['command']
        self.file_hash(pathlib.Path(command[0]), record.get('binarySha256'), label + ' binary')
        if 'next' in record:
            self.next_provenance(record, label)
        else:
            # A variant called "next" receives no exception without explicit,
            # independently checked Node/package/CLI/build/lock provenance.
            self.check(record.get('binarySha256') in self.binaries, label + ': binary has no verified source/build provenance')
        if require_generators:
            self.check(record.get('nodeVersion') == 'v24.19.0', label + ': Node version differs')
            self.file_hash(self.root / 'artifacts/performance/node24/node.exe', record.get('nodeSha256'), label + ' Node')
            self.file_hash(self.root / 'tests/performance/load.mjs', record.get('generatorSha256'), label + ' generator')
        if '--build-dir' in command:
            project = pathlib.Path(command[command.index('start') + 1])
            build = project / command[command.index('--build-dir') + 1]
            self.manifest(build, record.get('buildSha256'), label + ' application build', exact=True, exclude_cache=True)

    def fixture_provenance(self):
        if self.fixture is not None:
            return self.fixture
        file = self.base / 'fixture-evidence.json'
        if not self.check(file.is_file(), 'Next comparison requires fixture-evidence.json'):
            return None
        record = read(file)
        self.check(record.get('complete') is True, 'common fixture evidence is incomplete')
        project = pathlib.Path(record['projectPath'])
        self.check(project.is_absolute(), 'common fixture project path must be absolute')
        values = record.get('sourceSha256')
        self.manifest(project, values, 'common application fixture')
        names = {f.relative_to(project).as_posix() for directory in ['app', 'pages', 'public'] for f in (project / directory).rglob('*') if f.is_file()}
        names.update(f.name for f in project.glob('next.config.*') if f.is_file())
        names.update(['package.json', 'package-lock.json'])
        self.check(isinstance(values, dict) and set(values) == names, 'common fixture source map must enumerate app/pages/public/config/package/lock exactly')
        self.check(any(name.startswith('app/') for name in names) and any(name.startswith('pages/') for name in names), 'common fixture must include both App and Pages sources')
        self.fixture = record
        return record

    def next_provenance(self, record, label):
        proof = record.get('next')
        if not self.check(isinstance(proof, dict), label + ': invalid Next provenance object'):
            return
        command = record['command']
        node = self.root / 'artifacts/performance/node24/node.exe'
        self.check(pathlib.Path(command[0]).resolve() == node.resolve(), label + ': Next server must use the pinned Node executable')
        self.check(record.get('nodeVersion') == 'v24.19.0', label + ': Next Node version differs')
        self.file_hash(node, record.get('nodeSha256'), label + ' Next Node')
        self.check(record.get('binarySha256') == record.get('nodeSha256'), label + ': Next server binary hash differs from pinned Node hash')
        self.check(proof.get('version') == '16.3.5', label + ': Next reference version differs')
        fields = ['packagePath', 'cliPath', 'buildPath', 'lockPath']
        if not self.check(all(isinstance(proof.get(name), str) and pathlib.Path(proof[name]).is_absolute() for name in fields), label + ': Next provenance requires absolute file/build paths'):
            return
        package, cli, build, lock = (pathlib.Path(proof[name]) for name in fields)
        project = build.parent
        self.check(build.name == '.next', label + ': Next build must be the common fixture .next')
        self.check(isinstance(record.get('cwd'), str) and pathlib.Path(record['cwd']).is_absolute() and pathlib.Path(record['cwd']).resolve() == project.resolve(), label + ': Next working directory does not select the recorded build')
        self.check(package.resolve() == (project / 'node_modules/next/package.json').resolve(), label + ': Next package is outside the fixture installation')
        self.check(cli.resolve() == (package.parent / 'dist/bin/next').resolve(), label + ': Next CLI is not the installed package entry point')
        self.check(lock.resolve() == (project / 'package-lock.json').resolve(), label + ': Next lock is not the common fixture lockfile')
        package_ok = self.file_hash(package, proof.get('packageSha256'), label + ' Next package')
        self.file_hash(cli, proof.get('cliSha256'), label + ' Next CLI')
        lock_ok = self.file_hash(lock, proof.get('lockSha256'), label + ' Next lock')
        if package_ok:
            value = read(package)
            self.check(value.get('name') == 'next' and value.get('version') == proof.get('version'), label + ': installed Next package identity differs')
            entry = value.get('bin', {}).get('next') if isinstance(value.get('bin'), dict) else value.get('bin')
            self.check(isinstance(entry, str) and (package.parent / entry).resolve() == cli.resolve(), label + ': package bin does not name the recorded Next CLI')
        if lock_ok:
            value = read(lock).get('packages', {})
            self.check(value.get('node_modules/next', {}).get('version') == '16.3.5', label + ': lockfile Next version differs')
            self.check(value.get('', {}).get('dependencies', {}).get('next') == '16.3.5', label + ': fixture does not pin Next exactly')
        valid_command = len(command) >= 3 and pathlib.Path(command[1]).resolve() == cli.resolve() and command[2] == 'start'
        options = command[3:]
        known = {'-H': 'host', '--hostname': 'host', '-p': 'port', '--port': 'port'}
        seen = set()
        if len(options) % 2:
            valid_command = False
        for index in range(0, len(options) - 1, 2):
            option, value = options[index:index + 2]
            kind = known.get(option)
            if kind is None or kind in seen or not isinstance(value, str) or not value:
                valid_command = False
            elif kind == 'port' and (not value.isdecimal() or not 1 <= int(value) <= 65535):
                valid_command = False
            elif kind == 'host' and value not in ['127.0.0.1', 'localhost', '::1']:
                valid_command = False
            seen.add(kind)
        self.check(valid_command and seen == {'host', 'port'}, label + ': command is not the verified local Next start invocation')
        self.manifest(build, proof.get('buildSha256'), label + ' Next build', exact=True, exclude_cache=True)
        self.check(isinstance(proof.get('buildSha256'), dict) and {'BUILD_ID', 'routes-manifest.json', 'required-server-files.json'} <= set(proof['buildSha256']), label + ': Next build map lacks production build markers')
        fixture = self.fixture_provenance()
        if fixture is not None:
            self.check(pathlib.Path(fixture['projectPath']).resolve() == project.resolve(), label + ': Next project differs from the common fixture')
            self.check(fixture.get('next') == proof, label + ': Next provenance differs from the frozen common fixture')

    def runtime_contract(self, build, candidate=None):
        file = build / 'runtime-contract.json'
        if not self.require(file, 'runtime compatibility contract'):
            return
        record = read(file)
        self.check((record.get('schema'), record.get('protocol'), record.get('lifecycle')) == (1, 2, 1), 'runtime contract protocol/lifecycle: ' + str(build))
        self.check(set(record.get('capabilities', [])) >= {'activity', 'tracked-finalization', 'graceful-drain', 'lane-cancellation'}, 'runtime contract capabilities: ' + str(build))
        self.manifest(build, record['modules'], 'runtime contract modules')
        modules = {f.relative_to(build).as_posix() for directory in ['runtime', 'compat'] for f in (build / directory).glob('*') if f.is_file() and f.suffix in ['.mjs', '.cjs', '.json']}
        self.check(modules == set(record['modules']), 'runtime contract does not enumerate all top-level modules: ' + str(build))
        if candidate is not None:
            for name, expected in candidate['sourceSha256'].items():
                relative = pathlib.PurePosixPath(name).relative_to('packages/prnext') if name.startswith('packages/prnext/') else None
                if relative is None or len(relative.parts) != 2:
                    continue
                copied = relative.parts[0] == 'runtime' and (name.endswith('.mjs') and not name.endswith('.test.mjs') or relative.name == 'profiles.json') or relative.parts[0] == 'compat' and name.endswith('.cjs')
                # env.mjs bundles dotenv; build/images.mjs generates image-config.cjs
                # from the normalized application image configuration. Both remain
                # checked by the immutable complete build map and runtime contract,
                # rather than being equated with their unbundled/default templates.
                generated = {'runtime/env.mjs', 'compat/image-config.cjs'}
                if copied and relative.as_posix() not in generated:
                    self.check(record['modules'].get(relative.as_posix()) == expected, 'built runtime/compat differs from final source: ' + name)

    def application_build(self, final, candidate):
        folder = self.base / 'candidates' / final['candidate']
        file = folder / 'application-build.json'
        if self.require(file, 'final application build provenance'):
            record = read(file)
            self.check(record.get('complete') is True, 'final application build incomplete')
            self.check(record.get('sourceTreeDigest') == candidate['sourceTreeDigest'], 'application build source tree differs from final snapshot')
            self.check(record.get('node') == 'v24.19.0', 'application build Node version')
            self.check(pathlib.Path(record.get('output', '')).resolve() == pathlib.Path(final['dynamicBuild']['path']).resolve(), 'application build output differs from final dynamic build')
        self.runtime_contract(pathlib.Path(final['dynamicBuild']['path']), candidate)
        # Static comparisons intentionally reuse V4's exact bytes on both sides.
        self.runtime_contract(pathlib.Path(final['staticBuild']['path']))

    def functional(self, file, final):
        if not self.require(file, 'final functional proof'):
            return
        record = read(file)
        self.check(record.get('complete') is True, 'functional proof is incomplete: ' + str(file))
        self.check(record.get('binarySha256') == final['binarySha256'], 'functional binary differs: ' + str(file))
        if 'originalBuild' in record:
            self.check(record.get('node') == 'v24.19.0', 'static mutations Node version')
            self.check(len(record.get('checks', [])) == 13 and record.get('skipped') == [], 'all thirteen static mutation groups must pass without skips')
            self.file_hash(pathlib.Path(record['originalBuild']) / 'manifest.json', record.get('originalManifestSha256'), 'static mutation original manifest')
        else:
            self.file_hash(self.root / 'artifacts/performance/node24/node.exe', record.get('nodeSha256'), 'functional Node')
            self.check(record.get('nodeVersion') == 'v24.19.0', 'functional Node version')
            checks = record.get('checks', [])
            self.check(len(checks) == 9, 'expected nine final functional executions')
            pairs = []
            for check in checks:
                self.check(check.get('exitCode') == 0, 'failed functional command: ' + check.get('script', 'unknown'))
                self.file_hash(self.root / 'tests/performance' / check['script'], check.get('scriptSha256'), 'functional script')
                command = check['serverCommand']
                self.file_hash(pathlib.Path(command[0]), final['binarySha256'], 'functional server')
                profile = command[command.index('--profile') + 1]
                pairs.append((check['script'], profile))
                project = pathlib.Path(command[command.index('start') + 1])
                build = project / command[command.index('--build-dir') + 1]
                expected = final['staticBuild' if check['script'] == 'validate-static.mjs' else 'dynamicBuild']['path']
                self.check(build.resolve() == pathlib.Path(expected).resolve(), 'functional build differs from final contract')
                expected_hashes = final['staticBuild' if check['script'] == 'validate-static.mjs' else 'dynamicBuild']['sha256']
                self.check(check.get('buildSha256') == expected_hashes and check.get('inputsUnchanged') is True, 'functional application inputs changed or lack provenance')
            expected = [(name, profile) for profile in ['balanced', 'memory', 'speed'] for name in ['validate.mjs', 'cancellation-storm.mjs']] + [('validate-static.mjs', 'balanced')] * 3
            self.check(pairs == expected, 'functional profile/scenario coverage differs')

    def experiment(self, folder):
        calculated = summary.summarize_folder(folder)
        self.experiments[folder.name] = calculated
        self.errors.extend(folder.name + ': ' + error for error in calculated['verificationErrors'])
        stored = folder / 'summary.json'
        if self.require(stored, 'summary ' + folder.name):
            actual = read(stored)
            # Legacy summaries have no hash fields; their reported numbers must
            # nevertheless equal the independently recalculated raw statistics.
            for key in ['name', 'complete', 'inputs', 'excluded', 'groups']:
                self.check(actual.get(key) == calculated[key], folder.name + ': summary differs from raw evidence: ' + key)
            for key in ['inputSha256', 'configSha256', 'rejected', 'verificationErrors', 'expectedAttempts']:
                if key in actual:
                    self.check(actual[key] == calculated[key], folder.name + ': summary provenance differs: ' + key)
                else:
                    self.notes.append(folder.name + ': legacy summary lacks ' + key)
        for name in calculated['inputs']:
            record = read(folder / name)
            self.command_provenance(record, folder.name + '/' + name)
            for row in record['results']:
                self.totals['acceptedMeasuredResponses' if row['phase'] == 'measure' else 'acceptedWarmupResponses'] += row['value']['count']
                self.totals['errors'] += row['value']['errors']
        for row in calculated['rejected']:
            self.notes.append(folder.name + '/' + row['file'] + ' excluded: ' + '; '.join(row['reasons']))

    def reports(self, required=False):
        files = [self.base / 'report.html', self.root / 'artifacts/performance/report.html']
        for file in files:
            if not file.is_file():
                if required:
                    self.require(file, 'final HTML report')
                continue
            content = file.read_text(encoding='utf-8')
            self.check('\ufffd' not in content, 'HTML report has replacement characters: ' + str(file))
            parser = Links()
            parser.feed(content)
            base = file.parent
            if parser.base:
                parsed = urlsplit(parser.base)
                self.check(not parsed.scheme and not parsed.netloc, 'report base must be local: ' + str(file))
                base = (base / unquote(parsed.path)).resolve()
            for link in parser.targets:
                parsed = urlsplit(link)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                target = (base / unquote(parsed.path)).resolve()
                self.check(target.exists(), 'broken local report link: ' + str(file) + ' -> ' + link)

    def test_proofs(self, directory, binary_hash):
        files = sorted(directory.glob('*.json'))
        self.check(bool(files), 'no final test evidence in ' + str(directory))
        tested = 0
        for file in files:
            record = read(file)
            if 'exitCode' not in record:
                continue  # Auxiliary summaries do not establish a test pass.
            tested += 1
            self.check(record['exitCode'] == 0, 'failed final test: ' + str(file))
            self.check(record.get('binarySha256') == binary_hash, 'test binary provenance: ' + str(file))
            self.check(record.get('nodeVersion', '24.19.0').lstrip('v') == '24.19.0', 'test Node version: ' + str(file))
            self.require(file.with_suffix('.log'), 'final test log')
        self.check(tested > 0, 'no executed test commands in ' + str(directory))

    def sustained(self, file, mode, final):
        if not self.require(file, mode + ' proof'):
            return
        record = read(file)
        self.check(record.get('complete') is True and record.get('mode') == mode, 'incomplete/wrong sustained proof ' + str(file))
        self.check(record.get('binarySha256') == final['binarySha256'], 'sustained binary differs ' + str(file))
        self.command_provenance(record, str(file), require_generators=False)
        self.check(record.get('nodeVersion') == 'v24.19.0', 'sustained Node version')
        self.file_hash(self.root / 'artifacts/performance/node24/node.exe', record.get('nodeSha256'), 'sustained Node')
        for name in ['load.mjs', 'mixed-load.mjs']:
            self.file_hash(self.root / 'tests/performance' / name, record.get('generatorSha256', {}).get(name), 'sustained generator')
        for name in ['sustain-v5.py', 'measurement-v5.py', 'windows-runner.py', 'static-probe.py']:
            self.file_hash(self.root / 'tests/performance' / name, record.get('runnerSha256', {}).get(name), 'sustained runner')
        self.check(record.get('buildSha256') == final['dynamicBuild']['sha256'], 'sustained application differs from final build')
        self.check(record.get('generatorCpus') == [8, 9], 'sustained generator CPU affinity')
        rows = record.get('results', [])
        labels = [row.get('label') for row in rows]
        if mode == 'soak':
            expected = ['warmup', 'mixed-one-hour', 'idle-after-soak-310s', 'resume-after-soak']
        else:
            expected = ['startup-zero-http-or-tcp-60s', 'first-dynamic'] + [f'cycle-{cycle}-rest-{seconds}-{phase}' for cycle in range(1, 4) for seconds in [60, 300, 900] for phase in ['load', 'idle', 'resume']]
        self.check(labels == expected, 'sustained phase/cycle sequence differs ' + str(file))
        for row in rows:
            label, value = row['label'], row.get('value')
            before, after = row['before'], row['after']
            self.check(summary.close(row['cpuSeconds'], after['cpuSeconds'] - before['cpuSeconds']) and row['cpuSeconds'] >= 0, 'sustained cumulative CPU delta: ' + label)
            self.check(row.get('samples', [None])[-1] == after, 'sustained final accounting sample: ' + label)
            if label.endswith('-idle') or label in ['idle-after-soak-310s', 'startup-zero-http-or-tcp-60s']:
                seconds = 60 if label.startswith('startup-') else 310 if label.startswith('idle-after-') else int(label.split('-')[3])
                self.check(row['elapsedSeconds'] >= seconds, 'short idle period: ' + label)
                if label == 'startup-zero-http-or-tcp-60s':
                    self.check(all(name.lower() != 'node.exe' for sample in [before, *row['samples']] for _, name in sample['pids']), 'Node worker observed before first traffic')
            if isinstance(value, dict) and 'count' in value:
                self.totals['sustainedResponses'] += value.get('count', 0)
                self.totals['errors'] += value.get('errors', 0) + value.get('validationErrors', 0)
                self.totals['plannedDisconnects'] += value.get('plannedDisconnects', 0)
                self.check(value.get('errors') == 0 and value.get('validationErrors', 0) == 0 and value.get('exitCode', 0) == 0, 'sustained request/validation/generator error: ' + label)
                self.check(value.get('count', 0) > 0 and value.get('started') == value.get('count'), 'sustained requests not fully drained: ' + label)
                self.check(value.get('statuses') == {'200': value['count']}, 'sustained response statuses: ' + label)
                self.check(summary.close(value.get('rps'), value['completedWithinWindow'] / value['durationSeconds']), 'sustained throughput arithmetic: ' + label)
                if 'plannedDisconnects' in value:
                    self.check(value['plannedDisconnects'] == value['cancelStarts'] and value['cancellationStatuses'] == ({'200': value['plannedDisconnects']} if value['plannedDisconnects'] else {}), 'planned cancellation accounting: ' + label)
                if label == 'mixed-one-hour':
                    self.check(value.get('type') == 'final' and value.get('durationSeconds') == 3600 and row['elapsedSeconds'] >= 3600, 'endurance must span one hour and drain to a final generator record')
                if label.endswith('-load'):
                    self.check(value.get('durationSeconds') == 10, 'idle preceding load duration: ' + label)
            if isinstance(value, dict) and 'first' in value:
                for request in [value['first'], value.get('second', {})]:
                    self.check(request.get('status') == 200 and request.get('isolation') is True and request.get('freshness') is True, 'resume response/freshness/isolation: ' + label)
                    self.check(isinstance(request.get('startedAtUnixMs'), (int, float)) and isinstance(request.get('finishedAtUnixMs'), (int, float)) and request['finishedAtUnixMs'] >= request['startedAtUnixMs'], 'precise resume timestamps: ' + label)

    def generator_observation(self, final):
        name = final.get('generatorCpuFile')
        if not self.check(isinstance(name, str) and bool(name), 'global generator CPU observation is required'):
            return
        file = contained(self.base, name)
        if not self.require(file, 'global generator CPU observation'):
            return
        records = generator_cpu.read_observation(file)
        self.check(records[0].get('cpus') == [8, 9], 'global generator observation must cover CPUs 8/9')
        self.file_hash(self.root / 'tests/performance/generator-cpu-v5.py', records[0].get('observerSha256'), 'global generator observer')
        self.check(records[-1].get('event') == 'stop' and not any(row.get('event') == 'error' for row in records), 'global generator observer did not finish cleanly')

        def inspect(row, label, enforce_limit):
            result = generator_cpu.window_utilization(records, row['before']['time'] * 1000, row['after']['time'] * 1000)
            self.generator_windows.append({'source': label, 'capacityComparison': enforce_limit, **result})
            self.check(result['completeCoverage'], 'global generator observation lacks full coverage: ' + label)
            if enforce_limit:
                self.check(not result['contaminated'], 'global generator CPU p95 >85%; preserve and repeat final comparison: ' + label)
            elif result['contaminated']:
                self.notes.append('Shared generator load influences throughput/latencies; stability proof remains separate: ' + label)

        for name in final['finalExperiments']:
            for attempt in self.experiments.get(name, {}).get('inputs', []):
                source = self.base / 'experiments' / name / attempt
                for row in read(source)['results']:
                    if row['phase'] == 'measure':
                        inspect(row, str(source.relative_to(self.base)) + ':' + row['route'], True)
        for name in [final['soakFile'], *final['idleFiles']]:
            source = contained(self.base, name)
            if not source.is_file():
                continue
            for row in read(source).get('results', []):
                value = row.get('value')
                if isinstance(value, dict) and ('count' in value or 'first' in value):
                    inspect(row, name + ':' + row['label'], False)

    def final(self):
        file = self.base / 'final.json'
        if not self.require(file, 'final campaign contract'):
            return
        final = read(file)
        self.check(final.get('complete') is True and final.get('generation') == 'v5' and final.get('candidate') == 'final', 'final contract must designate completed V5 final candidate')
        candidate = self.candidates.get(final.get('candidate'))
        if not self.check(candidate is not None, 'final source snapshot is missing'):
            return
        native = final['compiledSourceSha256']
        self.check(native == native_sources(candidate['sourceSha256']), 'final compiled sources differ from candidate snapshot')
        self.manifest(self.root, native, 'current native source vs final')
        final_production = {n: h for n, h in final['sourceSha256'].items() if production_source(n)}
        candidate_production = {n: h for n, h in candidate['sourceSha256'].items() if production_source(n)}
        self.check(final_production == candidate_production, 'final production source map must match entire candidate snapshot')
        for name, expected in final['sourceSha256'].items():
            if production_source(name):
                self.file_hash(contained(self.root, name), expected, 'current production source vs final')
                self.check(candidate['sourceSha256'].get(name) == expected, 'final production source differs from snapshot: ' + name)
            elif not (self.root / name).is_file() or self.sha(self.root / name) != expected:
                self.notes.append('Non-production source changed after freeze: ' + name)
        binary = contained(self.base, final['nativeBinary'])
        self.file_hash(binary, final['binarySha256'], 'final published binary')
        self.check('final' in self.binaries.get(final['binarySha256'], set()), 'final binary must match final candidate build')
        for kind in ['dynamicBuild', 'staticBuild']:
            self.manifest(pathlib.Path(final[kind]['path']), final[kind]['sha256'], 'final ' + kind, exact=True, exclude_cache=True)
        self.application_build(final, candidate)
        self.check(bool(final.get('finalExperiments')), 'final experiment list is empty')
        for name in final.get('finalExperiments', []):
            self.check(self.experiments.get(name, {}).get('complete') is True, 'final benchmark incomplete: ' + name)
            binaries = set()
            attempts = []
            for attempt in self.experiments.get(name, {}).get('inputs', []):
                record = read(self.base / 'experiments' / name / attempt)
                attempts.append(record)
                binaries.add(record.get('binarySha256'))
                if record.get('binarySha256') == final['binarySha256']:
                    self.check(record.get('buildSha256') in [final['dynamicBuild']['sha256'], final['staticBuild']['sha256']], 'final benchmark build differs from contract: ' + name + '/' + attempt)
            self.check(final['binarySha256'] in binaries, 'final experiment never ran the final binary: ' + name)
            self.check(any('reference-v4' in self.binaries.get(value, set()) for value in binaries), 'final experiment lacks its frozen V4 control: ' + name)
            if any('next' in record for record in attempts):
                fixture = self.fixture_provenance()
                if fixture is not None:
                    project = pathlib.Path(fixture['projectPath']).resolve()
                    for record in attempts:
                        if 'next' not in record:
                            command = record['command']
                            self.check('start' in command and pathlib.Path(command[command.index('start') + 1]).resolve() == project, 'Next comparison does not use a common PRNext application fixture: ' + name)
        for directory in final.get('testsDirectories', []):
            self.test_proofs(contained(self.base, directory), final['binarySha256'])
        self.check(bool(final.get('testsDirectories')), 'final test directories are missing')
        self.check(len(final.get('functionalFiles', [])) == 2, 'both final functional proof files are required')
        for name in final.get('functionalFiles', []):
            self.functional(contained(self.base, name), final)
        self.sustained(contained(self.base, final['soakFile']), 'soak', final)
        self.check(len(final.get('idleFiles', [])) == 3, 'expected three final profile idle proofs')
        idle_profiles = []
        for name in final.get('idleFiles', []):
            file = contained(self.base, name)
            if file.is_file():
                idle_profiles.append(read(file).get('profile'))
            self.sustained(file, 'idle', final)
        self.check(sorted(idle_profiles) == ['balanced', 'memory', 'speed'], 'final idle proofs must cover exactly balanced, memory and speed')
        self.generator_observation(final)
        self.check(final.get('linuxExecuted') is False, 'Linux execution is not established by this Windows audit')
        self.reports(required=True)

    def safely(self, operation, label):
        try:
            operation()
        except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, ZeroDivisionError) as error:
            self.errors.append(label + ': ' + str(error))

    def run(self):
        self.safely(self.reference, 'reference audit')
        self.safely(self.candidate_snapshots, 'candidate audit')
        self.safely(self.installation, 'installation audit')
        for file in sorted((self.base / 'experiments').glob('*/config.json')):
            self.safely(lambda: self.experiment(file.parent), 'experiment ' + file.parent.name)
        if not self.partial or (self.base / 'final.json').is_file():
            self.safely(self.final, 'final audit')
        else:
            self.pending.append('Final campaign not yet designated (final.json absent)')
            self.safely(self.reports, 'available report links')
        return {'auditVersion': 1, 'generation': 'v5', 'mode': 'partial' if self.partial else 'final', 'passed': not self.errors and (self.partial or not self.pending), 'finalVerified': not self.partial and not self.errors and not self.pending, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': self.checks, 'totals': self.totals, 'generatorWindows': self.generator_windows, 'installation': self.installation_result, 'errors': self.errors, 'pending': self.pending, 'notes': self.notes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--partial', action='store_true')
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    parser.add_argument('--base', type=pathlib.Path, default=ROOT / 'artifacts/performance-v5')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    result = Audit(args.root.resolve(), args.base.resolve(), args.partial).run()
    out = args.output or args.base / ('audit-partial.json' if args.partial else 'audit-final.json')
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({key: result[key] for key in ['mode', 'passed', 'finalVerified', 'checks', 'totals', 'errors', 'pending']}, indent=2))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
