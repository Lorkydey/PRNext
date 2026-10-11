"""Compact French HTML from v5 evidence. Never rewrites a previous campaign.

Only report.html is written. Missing, partial, stale and rejected inputs remain
visible; exploratory trials can never stand in for the final candidate.
"""
import argparse
import collections
import datetime
import hashlib
import html
import importlib.util
import json
import math
import os
import pathlib
import re
import statistics
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BASE = ROOT / 'artifacts/performance-v5'
EXPECTED_EXPERIMENTS = ('routing', 'handles-static', 'handles-dynamic',
                        'mimalloc-static', 'mimalloc-dynamic', 'size-policy', 'node',
                        'size-space', 'memory28', 'native2-static', 'native2-dynamic')


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def stats(values):
    values = list(values)
    if not values or not all(finite(value) for value in values):
        return None
    return {'median': statistics.median(values), 'min': min(values), 'max': max(values), 'values': values}


class Inputs:
    def __init__(self, base):
        self.base, self.rows, self.hashes, self.cache = base, [], {}, {}

    def relative(self, path):
        return pathlib.Path(os.path.relpath(path, self.base)).as_posix()

    def raw(self, path):
        path = pathlib.Path(path)
        if not path.is_absolute():
            path = self.base / path
        if path in self.cache:
            return self.cache[path]
        try:
            value = path.read_bytes()
        except OSError as error:
            self.rows.append({'source': self.relative(path), 'state': 'absent ou inaccessible', 'detail': str(error)})
            return None
        self.cache[path] = value
        self.hashes[self.relative(path)] = hashlib.sha256(value).hexdigest()
        return value

    def read(self, path, optional=False):
        absolute = pathlib.Path(path)
        if not absolute.is_absolute():
            absolute = self.base / absolute
        if optional and not absolute.exists():
            return None
        raw = self.raw(absolute)
        if raw is None:
            return None
        try:
            value = json.loads(raw.decode('utf-8-sig'))
        except (UnicodeError, ValueError) as error:
            self.rows.append({'source': self.relative(absolute), 'state': 'illisible ou écriture en cours', 'detail': str(error)})
            return None
        if not isinstance(value, dict):
            self.rows.append({'source': self.relative(absolute), 'state': 'schéma invalide', 'detail': 'Objet JSON attendu.'})
            return None
        self.rows.append({'source': self.relative(absolute), 'state': 'lu', 'detail': ''})
        return value


def summarizer():
    spec = importlib.util.spec_from_file_location('v5_summary', pathlib.Path(__file__).with_name('summarize-v5.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def lifecycle(inputs):
    source = pathlib.Path(__file__).with_name('lifecycle-v5.py')
    raw = inputs.raw(source)
    spec = importlib.util.spec_from_file_location('v5_lifecycle', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.analyze(inputs.base, reader=inputs.raw)
    result['analyzerSha256'] = hashlib.sha256(raw).hexdigest() if raw is not None else None
    return result


def diagnostic_module():
    source = pathlib.Path(__file__).with_name('diagnostic-report-v5.py')
    spec = importlib.util.spec_from_file_location('v5_diagnostic_report', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def diagnostics(inputs):
    inputs.raw(pathlib.Path(__file__).with_name('diagnostic-report-v5.py'))
    return diagnostic_module().collect(inputs)


def installation_module():
    source = pathlib.Path(__file__).with_name('install-report-v5.py')
    spec = importlib.util.spec_from_file_location('v5_install_report', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def installation(inputs):
    inputs.raw(pathlib.Path(__file__).with_name('install-report-v5.py'))
    return installation_module().collect(inputs)


def compatibility(inputs):
    source = 'compatibility-review.json'
    data = inputs.read(source, optional=True)
    item = {'source': source, 'review': data, 'state': 'revue absente', 'issues': []}
    if not data:
        return item
    item['state'] = 'revue documentaire héritée — aucune validation finale déduite'
    if data.get('complete') is not True or data.get('testsExecutedByThisReview') is not False:
        item['issues'].append('État ou portée de la revue documentaire non confirmé.')
    for field in ('sourceSha256', 'evidenceSha256'):
        for name, expected in data.get(field, {}).items():
            path = (ROOT / name).resolve()
            if not path.is_relative_to(ROOT):
                item['issues'].append('Chemin de revue hors dépôt : ' + name)
                continue
            raw = inputs.raw(path)
            if raw is None or hashlib.sha256(raw).hexdigest() != expected:
                item['issues'].append('Preuve ou source modifiée depuis la revue : ' + name)
    if item['issues']:
        item['state'] = 'revue à actualiser — déclarations conservées, non validées'
    return item


def validation_scope(inputs, final):
    source = 'validation-scope.json'
    data = inputs.read(source, optional=True)
    item = {'source': source, 'data': data, 'verified': False, 'issues': [],
            'state': 'portée détaillée absente ou indisponible'}
    if not data:
        return item
    expected = (final.get('manifest') or {}).get('binarySha256')
    if not expected or data.get('binarySha256') != expected:
        item['issues'].append('La portée ne correspond pas au binaire final déclaré.')
    names = {'clippy.json', 'e2e.json', 'fmt.json', 'next-oracle.json', 'rust.json',
             'types-app.json', 'types-basic.json', 'types.json', 'unit.json'}
    proofs = data.get('testProofs')
    if not isinstance(proofs, dict) or set(proofs) != names:
        item['issues'].append('Les neuf preuves de validation attendues ne sont pas toutes déclarées.')
        proofs = {}
    for name, expected_hash in proofs.items():
        file = inputs.base / 'tests/final' / name
        raw = inputs.raw(file)
        proof = inputs.read(file)
        if raw is None or hashlib.sha256(raw).hexdigest() != expected_hash:
            item['issues'].append('Empreinte de validation différente : ' + name)
        if not isinstance(proof, dict) or type(proof.get('exitCode')) is not int or proof.get('exitCode') != 0 or proof.get('binarySha256') != expected:
            item['issues'].append('Code de sortie ou binaire non concordant : ' + name)
    rows = {row['source']: row for row in final.get('tests', [])}
    passed = data.get('passed') or {}
    if not isinstance(passed, dict):
        item['issues'].append('Compte de tests réussis invalide.')
        passed = {}
    for field, name in [('rust', 'rust'), ('unit', 'unit'), ('e2e', 'e2e'), ('nextOracle', 'next-oracle')]:
        count = passed.get(field)
        counters = rows.get('tests/final/' + name + '.json', {}).get('counts', {})
        actual = counters.get('pass')
        if type(count) is not int or count < 0 or actual != count:
            item['issues'].append('Compte de tests réussis différent du journal : ' + name)
        if counters.get('fail') != 0 or counters.get('cancelled', 0) != 0:
            item['issues'].append('Échec, annulation ou compte incomplet dans le journal : ' + name)
    if type(passed.get('typescriptProjects')) is not int or passed.get('typescriptProjects') != 3:
        item['issues'].append('Les trois projets TypeScript ne sont pas correctement comptés.')
    omitted = data.get('notExecuted')
    if not isinstance(omitted, list) or any(not isinstance(row, dict)
            or row.get('suite') not in ('rust', 'unit', 'e2e')
            or not isinstance(row.get('case'), str) or not row['case']
            or not isinstance(row.get('reason'), str) or not row['reason'] for row in omitted):
        item['issues'].append('Cas non exécutés ou raisons invalides.')
        omitted = []
    for suite in ('rust', 'unit', 'e2e'):
        actual = rows.get('tests/final/' + suite + '.json', {}).get('counts', {}).get('skipped')
        if actual != sum(row['suite'] == suite for row in omitted):
            item['issues'].append('Compte de cas non exécutés différent du journal : ' + suite)
    if rows.get('tests/final/next-oracle.json', {}).get('counts', {}).get('skipped') != 0:
        item['issues'].append('Le contrat Next contient un cas non exécuté ou son compte est absent.')
    item['verified'] = not item['issues']
    item['state'] = 'portée vérifiée sur les preuves et journaux du binaire final' if item['verified'] else 'portée non vérifiée — déclarations exclues de la synthèse'
    return item


def decode_log(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        return raw.decode('utf-16')
    if b'\x00' in raw[:200]:
        return raw.decode('utf-16-le')
    return raw.decode('utf-8-sig', errors='replace')


def test_counts(text):
    counts = {}
    for name in ('tests', 'pass', 'fail', 'skipped', 'cancelled'):
        matches = re.findall(r'(?m)^[ \t]*(?:ℹ|#)?[ \t]*' + name + r'[ \t]+(\d+)[ \t]*\r?$', text)
        if matches:
            counts[name] = int(matches[-1])
    rust = re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;', text)
    if rust:
        passed, failed, skipped, measured, filtered = (sum(int(row[i]) for row in rust) for i in range(5))
        counts.update(tests=passed + failed + skipped + measured, **{'pass': passed, 'fail': failed}, skipped=skipped, filteredOut=filtered)
    return counts


def experiment(inputs, name, verifier):
    folder = inputs.base / 'experiments' / name
    config = inputs.read(folder / 'config.json', optional=True) or inputs.read('configs/' + name + '.json', optional=True)
    summary = inputs.read(folder / 'summary.json', optional=True)
    item = {'name': name, 'config': config, 'state': 'non exécuté ou résumé absent', 'groups': [], 'attempts': [], 'issues': []}
    if summary:
        item['summary'] = inputs.relative(folder / 'summary.json')
        item['state'] = 'en cours ou incomplet — exclu des agrégats'
        if hasattr(verifier, 'summarize_folder'):
            try:
                audited = verifier.summarize_folder(folder, write=False)
                item['issues'].extend(audited.get('verificationErrors', []))
                if summary.get('groups') != audited.get('groups'):
                    item['issues'].append('Le résumé ne correspond plus aux tentatives : régénération nécessaire.')
                elif summary.get('complete') is True and audited.get('complete') is True:
                    item['state'] = 'terminé — résultats exploratoires'
                    item['groups'] = audited['groups']
                item['rejected'] = audited.get('rejected', [])
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
                item['issues'].append('Validation du résumé impossible : ' + str(error))
        else:
            item['issues'].append('Vérificateur de tentatives indisponible ; aucune agrégation acceptée.')
    for path in sorted(folder.glob('*-attempt*.json')):
        data = inputs.read(path)
        if not isinstance(data, dict):
            item['attempts'].append({'source': inputs.relative(path), 'state': 'illisible', 'errors': None})
            continue
        results = data.get('results', [])
        results = [row for row in results if isinstance(row, dict)] if isinstance(results, list) else []
        counts = [row['value'].get('errors') for row in results if isinstance(row.get('value'), dict)]
        errors = sum(counts) if counts and all(finite(value) for value in counts) else None
        state = 'terminée' if data.get('complete') is True else 'incomplète / exclue'
        binary_state = 'non vérifiée'
        command = data.get('command') or []
        if command and isinstance(data.get('binarySha256'), str):
            binary = pathlib.Path(command[0])
            if binary.is_file():
                binary_raw = inputs.raw(binary)
                if binary_raw is not None:
                    binary_state = 'concordante' if hashlib.sha256(binary_raw).hexdigest() == data['binarySha256'] else 'DIFFÉRENTE'
                    if binary_state == 'DIFFÉRENTE':
                        item['issues'].append('Binaire modifié depuis la mesure : ' + path.name)
                        item['groups'] = []
                        item['state'] = 'empreinte incompatible — exclu des agrégats'
        item['attempts'].append({'source': inputs.relative(path), 'state': state,
            'variant': data.get('variant'), 'repeat': data.get('repeat'), 'attempt': data.get('attempt'),
            'errors': errors, 'binarySha256': data.get('binarySha256'), 'binaryState': binary_state,
            'command': command, 'environment': data.get('environment', {}),
            'serverCpu': data.get('serverCpu'), 'generatorCpus': data.get('generatorCpus'),
            'startedAt': data.get('startedAt'), 'finishedAt': data.get('finishedAt'),
            'generatorMayLimit': any(row.get('generatorMayLimit') for row in results),
            'interference': len(data.get('backgroundInterference', []))})
    return item


def microbenchmarks(inputs):
    result = []
    for folder in ('node-envelope', 'node-transport'):
        for path in sorted((inputs.base / 'experiments' / folder).glob('results*.json')):
            data = inputs.read(path)
            if not isinstance(data, dict):
                continue
            groups = collections.defaultdict(list)
            for row in data.get('results', data.get('rows', [])):
                if not isinstance(row, dict):
                    continue
                field = 'nsPerDocument' if 'nsPerDocument' in row else 'nsPerResponse'
                if finite(row.get(field)) and row.get('count', 0) > 0:
                    groups[(row.get('caseName'), row.get('name'))].append((row, field))
            rows = []
            for (case, variant), values in groups.items():
                rows.append({'case': case, 'variant': variant, 'runs': len(values),
                             'wallNs': stats(row[field] for row, field in values),
                             'cpuNs': stats(row['cpuUs'] * 1000 / row['count'] for row, _ in values)})
            result.append({'name': folder, 'source': inputs.relative(path), 'rows': rows,
                           'node': data.get('node'), 'affinity': data.get('affinity'),
                           'method': data.get('method', 'Scanner HTML isolé, hors serveur HTTP'),
                           'sourceSha256': data.get('sourceSha256'), 'runnerSha256': data.get('runnerSha256')})
    return result


def mechanism_probes(inputs):
    """Retain failed diagnostics; verify raw counters/logs before showing a result."""
    result = []
    for path in sorted((inputs.base / 'experiments/public-probe').glob('*/result.json')):
        data = inputs.read(path)
        item = {'kind': 'public-probe', 'source': inputs.relative(path), 'state': 'incomplet / exclu',
                'rows': [], 'issues': [], 'evidence': data, 'links': []}
        result.append(item)
        if not data:
            continue
        raw_path = path.parent / 'raw.jsonl'
        item['links'] = [inputs.relative(raw_path)]
        if data.get('complete') is not True:
            item['issues'].append(data.get('error', 'Marqueur complet absent.'))
            continue
        try:
            raw = inputs.raw(raw_path)
            if raw is None or hashlib.sha256(raw).hexdigest() != data.get('rawSha256'):
                raise ValueError('Empreinte JSONL différente ou absente.')
            rows = [json.loads(line) for line in raw.decode('utf-8').splitlines()]
            spec = importlib.util.spec_from_file_location('public_probe_summary', pathlib.Path(__file__).with_name('public-probe-v5.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            groups = module.summarize(rows, rows[0]['rounds'], rows[0]['iterations'])
            if groups != data.get('groups') or data.get('exitCode') != 0 or data.get('compileExitCode') != 0:
                raise ValueError('Résumé ou code de sortie incohérent avec les compteurs bruts.')
            for file, expected in [(path.parent / 'public-probe-v5.rs', data.get('sourceSha256')),
                                   (pathlib.Path(data['command'][0]), data.get('binarySha256'))]:
                value = inputs.raw(file)
                if value is None or hashlib.sha256(value).hexdigest() != expected:
                    raise ValueError('Source ou exécutable de la micro-mesure modifié.')
            if data.get('fixtureBeforeSha256') != data.get('fixtureAfterSha256'):
                raise ValueError('Fichiers publics modifiés pendant la micro-mesure.')
            item.update(state='mesure isolée vérifiée — présonde rejetée', rows=groups)
        except (OSError, ValueError, TypeError, KeyError, AssertionError, IndexError) as error:
            item['issues'].append(str(error) or 'Les invariants des compteurs bruts ne sont pas satisfaits.')
    for path in sorted((inputs.base / 'experiments').glob('v8-policy*/result.json')):
        data = inputs.read(path)
        item = {'kind': 'v8-policy', 'source': inputs.relative(path), 'state': 'incomplet / observation absente — exclu',
                'rows': [], 'issues': [], 'evidence': data, 'links': []}
        result.append(item)
        if not data:
            continue
        variants = data.get('variants', [])
        try:
            if not isinstance(variants, list) or not variants:
                raise ValueError('Variantes absentes.')
            if data.get('complete') is True:
                if len(variants) != 4 or {variant.get('name') for variant in variants} != {'size-8', 'no-size-8', 'no-size-4', 'no-size-2'}:
                    raise ValueError('Le contrôle V8 complet exige les quatre variantes prévues.')
                node = inputs.raw(pathlib.Path(data['node']))
                if node is None or hashlib.sha256(node).hexdigest() != data.get('nodeSha256'):
                    raise ValueError('Exécutable Node de la sonde V8 absent ou modifié.')
            for variant in variants:
                row = {'name': variant['name'], 'flags': variant.get('flags', []), 'code': variant.get('code'),
                       'effectiveSemiSpaceMiB': None, 'workerYoungLimitMiB': None, 'workerCommittedNewSpaceMiB': None}
                item['rows'].append(row)
                if data.get('complete') is not True:
                    continue
                logs = {}
                for suffix, field in [('flags.stdout.log', 'flagStdoutSha256'), ('flags.stderr.log', 'flagStderrSha256'),
                                      ('stdout.log', 'observationStdoutSha256'), ('stderr.log', 'observationStderrSha256')]:
                    file = path.parent / (variant['name'] + '.' + suffix)
                    raw = inputs.raw(file)
                    item['links'].append(inputs.relative(file))
                    if raw is None or hashlib.sha256(raw).hexdigest() != variant.get(field):
                        raise ValueError('Journal V8 absent ou modifié : ' + file.name)
                    logs[suffix] = raw.decode('utf-8-sig')
                if variant.get('code') != 0 or variant.get('flagExitCode') != 0 or variant.get('error') or variant.get('signal'):
                    raise ValueError('Échec d’une commande du contrôle V8.')
                if logs['stderr.log'] or logs['flags.stderr.log']:
                    raise ValueError('Sortie stderr V8 non vide.')
                flag_lines = '\n'.join(line.strip().replace('_', '-') for line in logs['flags.stdout.log'].splitlines())
                effective = re.findall(r'^--max-semi-space-size=(\d+)$', flag_lines, re.MULTILINE)
                if len(effective) != 1 or int(effective[0]) != variant.get('effectiveSemiSpaceMiB'):
                    raise ValueError('Paramètre V8 effectif incohérent avec son journal.')
                marker = 'PRNEXT_V8_POLICY_RESULT '
                observations = [json.loads(line[len(marker):]) for line in logs['stdout.log'].splitlines() if line.startswith(marker)]
                if len(observations) != 1 or observations[0] != variant.get('observation'):
                    raise ValueError('Observation V8 absente ou différente du résumé.')
                worker = observations[0]['worker']['samples'][0]
                space = next(entry for entry in worker['spaces'] if entry['space_name'] == 'new_space')
                row.update(effectiveSemiSpaceMiB=int(effective[0]),
                           workerYoungLimitMiB=worker['resourceLimits'].get('maxYoungGenerationSizeMb'),
                           workerCommittedNewSpaceMiB=space['space_size'] / 1048576)
            if data.get('complete') is True:
                item['state'] = 'interaction des paramètres vérifiée — aucun essai de débit'
        except (OSError, ValueError, TypeError, KeyError, IndexError, StopIteration) as error:
            item['issues'].append(str(error))
            for row in item['rows']:
                row['effectiveSemiSpaceMiB'] = row['workerYoungLimitMiB'] = row['workerCommittedNewSpaceMiB'] = None
    return result


def verify_tree(inputs, root, hashes, errors, label):
    root = pathlib.Path(root).resolve()
    for name, expected in hashes.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            errors.append(label + ': chemin hors racine ' + name)
            continue
        raw = inputs.raw(path)
        if raw is None or hashlib.sha256(raw).hexdigest() != expected:
            errors.append(label + ': empreinte différente ou fichier absent ' + name)


def final_evidence(inputs):
    data = inputs.read('final.json', optional=True)
    final = {'manifest': data, 'state': 'non exécuté / manifeste final absent', 'issues': [], 'tests': [], 'functional': [], 'idle': [], 'soak': None}
    if not isinstance(data, dict):
        return final
    final['state'] = 'en cours — validation globale non terminée'
    expected = data.get('binarySha256')
    if data.get('complete') is True:
        for key in ('sourceSha256', 'compiledSourceSha256'):
            if not isinstance(data.get(key), dict) or not data[key]:
                final['issues'].append('Manifeste source absent : ' + key)
        if not expected or not data.get('nativeBinary'):
            final['issues'].append('Empreinte ou chemin du binaire final absent.')
        else:
            binary = pathlib.Path(data['nativeBinary'])
            if not binary.is_absolute():
                binary = inputs.base / binary
            raw = inputs.raw(binary)
            if raw is None or hashlib.sha256(raw).hexdigest() != expected:
                final['issues'].append('Le binaire final ne correspond pas au manifeste.')
        source = inputs.read('candidates/' + data.get('candidate', 'final') + '/source.json', optional=True)
        build = inputs.read('candidates/' + data.get('candidate', 'final') + '/build.json', optional=True)
        if not source or not build or build.get('exitCode') != 0 or build.get('binarySha256') != expected:
            final['issues'].append('Provenance source/build finale absente ou incohérente.')
        elif build.get('sourceTreeDigest') != source.get('sourceTreeDigest'):
            final['issues'].append('Le build final et son instantané source divergent.')
        else:
            if source.get('sourceSha256') != data.get('sourceSha256'):
                final['issues'].append('Les sources finales diffèrent du snapshot complet.')
            verify_tree(inputs, inputs.base / 'candidates' / data.get('candidate', 'final') / 'source',
                        data.get('compiledSourceSha256', {}), final['issues'], 'sources compilées')
        for key in ('dynamicBuild', 'staticBuild'):
            tree = data.get(key, {})
            if not tree.get('path') or not tree.get('sha256'):
                final['issues'].append('Instantané applicatif absent : ' + key)
            else:
                verify_tree(inputs, tree['path'], tree['sha256'], final['issues'], key)
        final['state'] = 'terminé — empreintes finales concordantes' if not final['issues'] else 'validation finale incohérente — exclue'
    for directory in data.get('testsDirectories', ['tests/final']):
        for path in sorted((inputs.base / directory).glob('*.json')):
            evidence = inputs.read(path)
            if not isinstance(evidence, dict):
                continue
            log = path.with_suffix('.log')
            raw = inputs.raw(log) if log.exists() else None
            counters = test_counts(decode_log(raw)) if raw else {}
            state = 'en cours / résultat absent'
            if 'exitCode' in evidence:
                state = 'échec' if evidence['exitCode'] != 0 or counters.get('fail', 0) else 'code 0, rattachement final à vérifier'
                if evidence['exitCode'] == 0 and not counters.get('fail', 0) and evidence.get('binarySha256') == expected:
                    state = 'réussi, rattaché à l’empreinte finale'
            final['tests'].append({'source': inputs.relative(path), 'log': inputs.relative(log) if log.exists() else None,
                                   'state': state, 'counts': counters, 'seconds': evidence.get('elapsedSeconds')})
    for name in data.get('functionalFiles', []):
        proof = inputs.read(name, optional=True)
        item = {'source': name, 'state': 'absent / non exécuté', 'checks': [], 'skipped': []}
        if isinstance(proof, dict):
            checks = proof.get('checks')
            item['state'] = 'incomplet ou empreinte différente'
            item['skipped'] = proof.get('skipped', [])
            if isinstance(checks, list):
                item['checks'] = checks
                valid = all(isinstance(check, str) and bool(check) or isinstance(check, dict) and check.get('exitCode') == 0 for check in checks)
                if proof.get('complete') is True and expected and proof.get('binarySha256') == expected and checks and valid:
                    item['state'] = 'terminé, rattaché à l’empreinte finale'
            item['binarySha256'] = proof.get('binarySha256')
        final['functional'].append(item)
    for name in data.get('idleFiles', ['idle/' + profile + '/result.json' for profile in ('balanced', 'memory', 'speed')]):
        idle = inputs.read(name, optional=True)
        item = {'source': name, 'state': 'absent / non exécuté', 'rows': []}
        if isinstance(idle, dict):
            item['state'] = 'en cours ou empreinte différente'
            if idle.get('complete') is True and idle.get('binarySha256') == expected:
                item['state'] = 'terminé'
                for row in idle.get('results', []):
                    label = row.get('label', '')
                    if label.endswith('-idle') or label.endswith('-resume') or 'startup' in label or label == 'first-dynamic':
                        item['rows'].append({'label': label, 'elapsedSeconds': row.get('elapsedSeconds'),
                            'cpuPercent': row.get('cpuPercent'), 'rssMiB': row.get('after', {}).get('rssMiB'),
                            'privateCommitMiB': row.get('after', {}).get('privateCommitMiB'),
                            'handles': row.get('after', {}).get('handles'),
                            'threads': row.get('after', {}).get('threads'), 'processes': row.get('after', {}).get('processes'),
                            'processesStarted': row.get('processesStarted'),
                            'firstMs': row.get('value', {}).get('first', {}).get('latencyMs') if isinstance(row.get('value'), dict) else None})
        final['idle'].append(item)
    soak_name = data.get('soakFile', 'soak/result.json')
    soak = inputs.read(soak_name, optional=True)
    if isinstance(soak, dict):
        final['soak'] = {'source': soak_name, 'state': 'en cours ou empreinte différente'}
        if soak.get('complete') is True and soak.get('binarySha256') == expected:
            load = next((row for row in soak.get('results', []) if row.get('label') == 'mixed-one-hour'), {})
            value = load.get('value', {})
            count = value.get('count', 0)
            if value.get('errors') != 0 or value.get('validationErrors') != 0 or value.get('exitCode') != 0:
                final['soak']['state'] = 'erreurs ou contrôles manquants — validation exclue'
                return final
            if not count or value.get('durationSeconds', 0) < 3600 or value.get('elapsedSeconds', 0) < 3600:
                final['soak']['state'] = 'durée ou charge insuffisante — validation d’une heure exclue'
                return final
            samples = load.get('samples', [])
            windows = []
            if samples:
                first, last = load['before']['time'], load['after']['time']
                # Fixed load windows are disjoint; the separate last-minute
                # observation includes final accounting and may include drain.
                ranges = [(0, 900, False), (900, 1800, False), (1800, 3600, False),
                          (max(0, last - first - 60), last - first, True)]
                for start, end, include_end in ranges:
                    selected = [sample for sample in samples if start <= sample['time'] - first
                                and (sample['time'] - first < end or include_end and sample['time'] - first == end)]
                    if selected:
                        windows.append({'start': start, 'end': end, 'lastMinuteObservation': include_end,
                            **{key: stats(sample[key] for sample in selected if finite(sample.get(key))) for key in ('rssMiB', 'privateCommitMiB', 'threads', 'handles', 'processes')}})
            idle_after = next((row for row in soak.get('results', []) if row.get('label') == 'idle-after-soak-310s'), None)
            resume = next((row for row in soak.get('results', []) if row.get('label') == 'resume-after-soak'), None)
            final['soak'].update(state='terminé', value=value, cpuMsPerResponse=1000 * load.get('cpuSeconds', 0) / count if count else None,
                                 rssMiB=load.get('rssMedianMiB'), rssPeakMiB=load.get('rssMaxMiB'),
                                 processesStarted=load.get('processesStarted'), idleAfter=idle_after, resume=resume, windows=windows,
                                 serverCpu=soak.get('serverCpu'), generatorCpus=soak.get('generatorCpus'),
                                 startedAt=soak.get('startedAt'), finishedAt=soak.get('finishedAt'), instrumented=soak.get('instrumented'))
    return final


def exploratory_tests(inputs, final):
    final_sources = {item['source'] for item in final['tests']}
    rows = []
    for path in sorted((inputs.base / 'tests').glob('*/*.json')):
        if inputs.relative(path) in final_sources:
            continue
        data = inputs.read(path)
        if not data or 'command' not in data:
            continue
        log = path.with_suffix('.log')
        raw = inputs.raw(log) if log.is_file() else None
        counts = test_counts(decode_log(raw)) if raw else {}
        state = 'en cours / code de sortie absent'
        if 'exitCode' in data:
            state = 'échec' if data['exitCode'] != 0 or counts.get('fail', 0) else 'code 0 — contrôle intermédiaire'
        rows.append({'source': inputs.relative(path), 'log': inputs.relative(log) if raw is not None else None,
                     'state': state, 'counts': counts, 'seconds': data.get('elapsedSeconds'), 'binarySha256': data.get('binarySha256')})
    return rows


def label_experiment(item, is_final, final_verified):
    item['final'] = is_final
    if is_final:
        if not final_verified:
            item['state'] = 'mesures prévues pour la finale — validation globale en cours'
        elif item['groups'] and not item['issues'] and item['state'].startswith('terminé'):
            item['state'] = 'terminé — résultats finaux'


def collect(base):
    inputs = Inputs(pathlib.Path(base).resolve())
    environment = inputs.read('environment.json', optional=True) or {}
    ledger = inputs.read('experiments/ledger.json', optional=True) or {}
    reference = inputs.read('reference-v4/reference.json', optional=True) or {}
    final = final_evidence(inputs)
    worker_lifecycle = lifecycle(inputs)
    final_names = (final.get('manifest') or {}).get('finalExperiments', ['final-static', 'final-dynamic'])
    names = set(EXPECTED_EXPERIMENTS) | set(final_names)
    names.update((final.get('manifest') or {}).get('exploratoryExperiments', []))
    names.update(path.stem for path in (inputs.base / 'configs').glob('*.json'))
    names.update(path.parent.name for path in (inputs.base / 'experiments').glob('*/config.json'))
    names.update(path.parent.name for path in (inputs.base / 'experiments').glob('*/summary.json'))
    verifier = summarizer()
    experiments = [experiment(inputs, name, verifier) for name in sorted(names)]
    if (final.get('manifest') or {}).get('complete') is True:
        soak_metrics = next((row for row in worker_lifecycle['metrics'] if row['source'] == 'soak/metrics.jsonl'), None)
        if not soak_metrics or not soak_metrics['valid'] or not soak_metrics['idleZeroValid'] or not soak_metrics['runComplete']:
            final['issues'].append('Compteurs lifecycle de l’endurance absents, incomplets ou gauges non libérées après repos.')
        elif soak_metrics['binarySha256'] != final['manifest'].get('binarySha256'):
            final['issues'].append('Compteurs lifecycle issus d’un autre binaire que le candidat final.')
        for item in experiments:
            if item['name'] in final_names and (not item['groups'] or item['issues']):
                final['issues'].append('Comparaison finale absente ou invalide : ' + item['name'])
        if not final['soak'] or final['soak']['state'] != 'terminé':
            final['issues'].append('Endurance finale complète indisponible.')
        if len(final['idle']) < 3 or any(item['state'] != 'terminé' for item in final['idle']):
            final['issues'].append('Cycles de repos finaux incomplets.')
        if not final['tests'] or any(not item['state'].startswith('réussi,') for item in final['tests']):
            final['issues'].append('Tests finaux absents, échoués ou sans rattachement à cette version.')
        if not final['functional'] or any(not row['state'].startswith('terminé,') for row in final['functional']):
            final['issues'].append('Contrôles fonctionnels finaux complets indisponibles.')
        if final['issues']:
            final['state'] = 'validation finale incohérente — exclue'
    for item in experiments:
        label_experiment(item, item['name'] in final_names, final['state'].startswith('terminé'))
    return {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'environment': environment,
            'ledger': ledger, 'reference': reference, 'final': final, 'experiments': experiments,
            'microbenchmarks': microbenchmarks(inputs), 'mechanismProbes': mechanism_probes(inputs),
            'exploratoryTests': exploratory_tests(inputs, final),
            'lifecycle': worker_lifecycle,
            'diagnostics': diagnostics(inputs),
            'installation': installation(inputs),
            'compatibility': compatibility(inputs),
            'validationScope': validation_scope(inputs, final),
            'diagnosticInterpretation': inputs.read('diagnostic-interpretation.json', optional=True),
            'inputs': inputs.rows, 'hashes': inputs.hashes}


def esc(value):
    return html.escape(str(value))


def number(value, digits=2):
    return '—' if not finite(value) else f'{value:,.{digits}f}'.replace(',', '\u202f')


def route_label(route):
    return 'petite page HTML gzip (' + route + ')' if route.lstrip('/') == 'pages-static' else route


def distribution(value, digits=2):
    if not value:
        return '—'
    return number(value['median'], digits) + '<span class="range">' + number(value['min'], digits) + ' – ' + number(value['max'], digits) + '</span>'


def link(base, path, label=None):
    if not path:
        return '—'
    local = pathlib.Path(path)
    if not local.is_absolute():
        local = base / local
    if not local.exists():
        return esc(label or path) + ' <span class="muted">(absent)</span>'
    target = pathlib.Path(os.path.relpath(local, base)).as_posix()
    return '<a href="' + html.escape(urllib.parse.quote(target, safe='/'), quote=True) + '">' + esc(label or path) + '</a>'


def table(headers, rows, caption=None):
    if not rows:
        return '<p class="pending">Non exécuté, en cours ou données complètes indisponibles.</p>'
    return '<div class="scroll"><table>' + ('<caption>' + esc(caption) + '</caption>' if caption else '') + '<thead><tr>' + ''.join('<th scope="col">' + esc(header) + '</th>' for header in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + value + '</td>' for value in row) + '</tr>' for row in rows) + '</tbody></table></div>'


def evidence(base, value, title):
    return '<details><summary>' + esc(title) + '</summary><pre>' + esc(json.dumps(value, ensure_ascii=False, indent=2)) + '</pre></details>'


def deltas(groups, config):
    profile = {}
    baseline = {}
    for variant in config.get('variants', []):
        command = variant.get('command', [])
        selected = command[command.index('--profile') + 1] if '--profile' in command else 'non précisé'
        profile[variant['name']] = selected
        baseline.setdefault(selected, variant['name'])
    lookup = {(row['variant'], row['route'], row['connections']): row for row in groups}
    rows = []
    for current in groups:
        reference = baseline.get(profile.get(current['variant']))
        before = lookup.get((reference, current['route'], current['connections']))
        if not before or reference == current['variant']:
            continue
        row = {'reference': reference, 'variant': current['variant'], 'route': current['route'], 'connections': current['connections']}
        for metric in ('rps', 'cpuMsPerResponse', 'rssMiB', 'p95', 'p99'):
            a, b = before['metrics'].get(metric, {}).get('median'), current['metrics'].get(metric, {}).get('median')
            row[metric] = 100 * (b / a - 1) if finite(a) and finite(b) and a else None
        rows.append(row)
    return rows


def next_deltas(groups, config):
    """Match every configured PRNext profile against Next at equal route/load."""
    variants = config.get('variants', [])
    references = [entry['name'] for entry in variants if entry.get('name') == 'next']
    if len(references) != 1:
        return []
    reference = references[0]
    profiles = {}
    for entry in variants:
        command = entry.get('command', [])
        if entry.get('name') == reference or '--profile' not in command:
            continue
        index = command.index('--profile') + 1
        if index < len(command):
            profiles[entry['name']] = command[index]
    baseline = {(row['route'], row['connections']): row for row in groups if row['variant'] == reference}
    rows = []
    for current in groups:
        if current['variant'] not in profiles:
            continue
        before = baseline.get((current['route'], current['connections']))
        if before is None:
            continue
        row = {'reference': reference, 'variant': current['variant'], 'profile': profiles[current['variant']],
               'route': current['route'], 'connections': current['connections']}
        for metric in ('rps', 'cpuMsPerResponse', 'rssMiB', 'p95', 'p99'):
            a, b = before['metrics'].get(metric, {}).get('median'), current['metrics'].get(metric, {}).get('median')
            row[metric] = 100 * (b / a - 1) if finite(a) and finite(b) and a else None
        rows.append(row)
    return rows


def render_experiment(item, base):
    config = item.get('config') or {}
    text = '<article id="experiment-' + esc(item['name']) + '"><h3>' + esc(item['name']) + '</h3><p class="status">' + esc(item['state']) + '</p>'
    text += '<p>' + link(base, item.get('summary'), 'Résumé JSON') + ' · ' + link(base, 'experiments/' + item['name'] + '/config.json', 'Configuration')
    if config:
        text += ' · ' + esc(str(config.get('repeats', '?')) + ' répétitions × ' + str(config.get('seconds', '?')) + ' s ; échauffement ' + str(config.get('warmup', 10)) + ' s ; ordre alterné')
    text += '</p>'
    rows = []
    for group in item['groups']:
        m = group['metrics']
        rows.append([esc(group['variant']), esc(route_label(group['route'])), esc(group['connections']), esc(group['repeats']),
                     distribution(m.get('rps'), 1), distribution(m.get('cpuMsPerResponse'), 4), distribution(m.get('rssMiB'), 1),
                     distribution(m.get('p50'), 1), distribution(m.get('p95'), 1), distribution(m.get('p99'), 1),
                     esc(group.get('errors')), esc(group.get('processesStarted')), distribution(m.get('threadsPeak'), 0)])
    text += table(['Variante', 'Route', 'Conn.', 'n', 'req/s', 'CPU ms/rép.', 'RSS Mio', 'p50 ms', 'p95 ms', 'p99 ms', 'Erreurs', 'Créations', 'Threads pic'], rows,
                  'Médiane ; étendue min–max sous chaque valeur. Quantiles calculés par mesure, sans fusion.')
    compared = deltas(item['groups'], config)
    if compared:
        text += table(['Référence → variante','Route / connexions','Δ req/s %','Δ CPU/rép. %','Δ RSS %','Δ p95 %','Δ p99 %'],
                      [[esc(row['reference']+' → '+row['variant']),esc(route_label(row['route'])+' / '+str(row['connections'])),*[number(row[metric]) for metric in ('rps','cpuMsPerResponse','rssMiB','p95','p99')]] for row in compared],
                      'Comparaison à la première variante configurée du même profil ; variations de médianes, sans test de significativité.')
    compared_next = next_deltas(item['groups'], config) if item.get('final') else []
    if compared_next:
        text += '<h4>PRNext par rapport à Next.js</h4>'
        text += table(['Variante PRNext','Profil','Route / connexions','Δ req/s %','Δ CPU/rép. %','Δ RSS %','Δ p95 %','Δ p99 %'],
                      [[esc(row['variant']),esc(row['profile']),esc(route_label(row['route'])+' / '+str(row['connections'])),*[number(row[metric]) for metric in ('rps','cpuMsPerResponse','rssMiB','p95','p99')]] for row in compared_next],
                      'Référence = Next du même essai, sur la même route et au même nombre de connexions. Calcul : 100 × (PRNext / Next − 1). Une hausse du débit est favorable ; une hausse du CPU, du RSS ou des latences est défavorable. Variations de médianes, sans test de significativité.')
    if item['issues'] or item.get('rejected'):
        text += evidence(base, {'issues': item['issues'], 'rejected': item.get('rejected', [])}, 'Tentatives exclues et incohérences')
    attempts = [[link(base, row['source']), esc(row.get('variant', '—')), esc(row['state']), esc(row.get('errors', '—')),
                 esc(row.get('interference', '—')), esc(row.get('generatorMayLimit', '—')), esc(row.get('binaryState', '—'))] for row in item['attempts']]
    text += '<details><summary>Toutes les tentatives, y compris celles exclues</summary>' + table(['Source', 'Variante', 'État', 'Erreurs avec échauffement', 'Interférences', 'Générateur limité', 'SHA binaire'], attempts) + '</details>'
    text += evidence(base, item['attempts'], 'Commandes, environnement, horaires et empreintes de chaque tentative') + '</article>'
    return text


def render_lifecycle(data, base):
    text = '<h2 id="lifecycle">Cycle de vie des workers</h2>'
    text += '<p>Les compteurs cumulatifs Rust et les occurrences de logs restent séparés. <code>laneDiscards</code> compte des transports abandonnés, pas des hôtes tués. Une création Node peut être un démarrage initial ou une reprise normale après repos.</p>'
    if not data['metrics']:
        text += '<p class="pending">Métriques cumulatives absentes : aucun zéro de redémarrage, d’annulation ou de file ne peut en être déduit.</p>'
    for dataset in data['metrics']:
        state = 'échantillons valides' if dataset['valid'] else 'échantillons absents, incomplets ou invalides'
        state += ' ; campagne terminée' if dataset['runComplete'] else ' ; campagne non terminée'
        text += '<article><h3>' + link(base, dataset['source']) + '</h3><p class="status">' + esc(state) + '</p>'
        text += table(['PID Rust','Créations Node','Annulations normales','Échecs requêtes','Connexions lanes','Lanes abandonnées','Retraits lanes au repos','Drainages hôtes','Watchdog hôtes'],
                      [[esc(row['pid']), *[esc(row['finalCounters'][key]) for key in ('hostStarts','consumerCancellations','failedRequests','laneConnections','laneDiscards','laneIdleRetirements','hostDrainStarts','watchdogKills')]] for row in dataset['processes']],
                      'Dernier instantané cumulatif par processus ; ne compte pas exhaustivement les remplacements d’isolats RSC.')
        rows = []
        for window in dataset['windows']:
            delta = window.get('counterDelta', {})
            gauges = window.get('finalGauges', {})
            rows.append([esc(window['label']), esc(window['kind']), esc(window['coverage']),
                         esc(delta.get('hostStarts', '—')), esc(delta.get('consumerCancellations', '—')),
                         esc(delta.get('failedRequests', '—')), esc(delta.get('laneDiscards', '—')),
                         esc(delta.get('laneIdleRetirements', '—')), esc(delta.get('hostDrainStarts', '—')),
                         esc(delta.get('watchdogKills', '—')),
                         ' / '.join(esc(gauges.get(key, '—')) for key in ('queuedJobs','activeJobs','activityProtectedHosts')),
                         esc({'yes':'oui','no':'NON','unknown':'couverture insuffisante','not-expected':'non exigé'}.get(window['idleZero'], window['idleZero']))])
        text += table(['Fenêtre','Type','Couverture','Δ hôtes','Δ annulations','Δ échecs','Δ lanes abandonnées','Δ retraits idle','Δ drainages','Δ watchdog','Gauges finales Q/A/P','Zéro en fin de repos'], rows,
                      'Deltas entre les bornes échantillonnées affichées dans le détail. Q = jobs soumis en file ; A = jobs actifs ; P = hôtes protégés par activité suivie.')
        if not dataset['idleZeroValid']:
            text += '<p class="status">La libération attendue des gauges en fin de repos n’est pas démontrée ; consulter les échantillons de fin de fenêtre.</p>'
        text += evidence(base, {key:dataset.get(key) for key in ('binarySha256','resultSource','counterMonotonic','invalidLines','issues','windowIssues','processes','windows')},
                         'Bornes, pics, compteurs monotones et lignes invalides') + '</article>'
    log_rows = []
    for row in data['logs']:
        counts = row['counts']
        log_rows.append([link(base,row['source']), esc(row['scope']), esc(sum(counts.values())),
                         esc(counts.get('normalConsumerCancellation',0)), esc(counts.get('legacyDisconnect',0)),
                         esc(counts.get('failedRequestLaneRestart',0)), esc(counts.get('hostWatchdogRetirement',0)),
                         esc(counts.get('hostGracefulDrainTimeout',0)), esc(counts.get('rscBackgroundUnresponsive',0)),
                         esc(counts.get('rscExitMessage',0)), esc(counts.get('brokenPipe',0)), esc(len(row['invalidLines']))])
    text += '<h3>Occurrences dans les journaux</h3><p>Les catégories peuvent se recouper sur une même ligne. Un message de reprise du worker Rust décrit une lane ; il ne prouve pas la création d’un nouveau processus. Zéro message n’est jamais présenté comme zéro remplacement d’isolat.</p>'
    text += table(['Journal','Contexte','Occurrences catégories','Annulation normale','Déconnexion ancienne','Reprise lane/échec','Watchdog hôte','Délai drain hôte','RSC non réactif','Sortie RSC observée','EPIPE','Lignes invalides'],log_rows)
    text += evidence(base, data['logs'], 'Extraits des messages, numéros de ligne et fenêtres horodatées ; messages non horodatés non attribués')
    if data['issues']:
        text += evidence(base, data['issues'], 'Sources lifecycle invalides ou inaccessibles')
    text += evidence(base, data['definitions'], 'Définition précise des compteurs et gauges')
    text += '<ul>' + ''.join('<li>' + esc(value) + '</li>' for value in data['limitations']) + '</ul>'
    return text


def render_mechanism_probes(probes, base):
    text = '<h3>Sondes de mécanisme : fichiers publics et politique V8</h3>'
    if not probes:
        return text + '<p class="pending">Aucune preuve disponible.</p>'
    for item in probes:
        data = item.get('evidence') or {}
        text += '<article><h3>' + esc(item['kind']) + '</h3><p class="status">' + esc(item['state']) + '</p><p>' + link(base, item['source']) + '</p>'
        if item['kind'] == 'public-probe':
            variants = ('metadata', 'open', 'open_handle_metadata', 'metadata_then_open_handle_metadata')
            groups = {(row['case'], row['variant']): row for row in item['rows']}
            rows = []
            for case in sorted({row['case'] for row in item['rows']}):
                values = [esc(case)]
                for variant in variants:
                    group = groups.get((case, variant))
                    if not group:
                        values.append('—')
                        continue
                    measured = group['wallNsPerOperation']
                    values.append(distribution({key: measured[key] / 1000 for key in ('median', 'min', 'max')}, 3))
                rows.append(values)
            text += table(['Chemin','metadata µs','open µs','open + metadata handle µs','Présonde + open + metadata handle µs'], rows,
                          'Durée murale par appel ; médiane et étendue. Les compteurs bruts incluent séparément l’échauffement.')
            text += '<p>La présonde a été rejetée : le faible écart sur les chemins absents ne démontre pas la cause de la régression API, tandis que les fichiers présents paient une metadata supplémentaire. ' + link(base, 'experiments/public-probe/README.md', 'Décision chiffrée et limites') + '. Ces opérations ne sont pas des requêtes HTTP.</p>'
        else:
            text += table(['Variante','Arguments demandés','Code observation','Semi-space effectif Mio','Limite young du worker annoncée Mio','New space engagé au démarrage Mio'],
                          [[esc(row['name']),'<code>'+esc(' '.join(row['flags']))+'</code>',esc(row['code']),number(row['effectiveSemiSpaceMiB'],0),number(row['workerYoungLimitMiB'],0),number(row['workerCommittedNewSpaceMiB'],1)] for row in item['rows']])
            text += '<p>Le paramètre effectif vient d’une commande distincte <code>--print-flag-values</code>, après résolution des implications V8. La capacité engagée de <code>new_space</code> et les contraintes annoncées de <code>resourceLimits</code> ne prouvent pas la limite effective du tas. Ce contrôle sans charge HTTP ne mesure ni le débit ni le coût du GC.</p>'
            if data.get('complete') is not True:
                text += '<p>Cette tentative incomplète reste exclue, même si une commande a terminé avec le code 0. Elle ne fournit pas toutes les observations attendues.</p>'
        if item['issues']:
            text += evidence(base, item['issues'], 'Motifs d’exclusion / incohérences')
        text += '<details><summary>Journaux et provenance</summary><p>' + ' · '.join(link(base, name) for name in item['links']) + '</p>'
        text += '<pre>' + esc(json.dumps({key: data.get(key) for key in ('startedAt','finishedAt','sourceSha256','runnerSha256','binarySha256','nodeSha256','profilesSha256','appRenderSha256','compileCommand','command','cpu','allocationRounds','method','note','initialJobSample','finalJobSample') if key in data}, ensure_ascii=False, indent=2)) + '</pre></details></article>'
    return text


def final_summary_pairs(report):
    """Only audited, globally complete final evidence may enter the lead table."""
    final = report['final']
    if (final.get('manifest') or {}).get('complete') is not True or final.get('issues') or not final['state'].startswith('terminé'):
        return []
    wanted = {('ssr', 64), ('stream', 128), ('api/json', 64), ('pages-static', 32)}
    rows = []
    for item in report['experiments']:
        if not item.get('final') or item.get('issues'):
            continue
        lookup = {(group['variant'], group['route'], group['connections']): group for group in item['groups']}
        for profile in ('balanced', 'memory'):
            for route, connections in [('ssr', 64), ('stream', 128), ('api/json', 64), ('pages-static', 32)]:
                if (route, connections) not in wanted or route == 'pages-static' and profile != 'balanced':
                    continue
                before = lookup.get(('v4-' + profile, route, connections))
                after = lookup.get(('v5-' + profile, route, connections))
                if before is None or after is None:
                    continue
                metrics = {}
                for name in ('rps', 'cpuMsPerResponse', 'rssMiB', 'p99'):
                    a, b = before['metrics'].get(name, {}).get('median'), after['metrics'].get(name, {}).get('median')
                    if not finite(a) or not finite(b) or a <= 0:
                        break
                    metrics[name] = {'before': a, 'after': b, 'delta': 100 * (b / a - 1)}
                if len(metrics) == 4:
                    rows.append({'experiment': item['name'], 'profile': profile, 'route': route,
                                 'connections': connections, 'metrics': metrics})
    return rows


def render_summary(report, base):
    final = report['final']
    complete = (final.get('manifest') or {}).get('complete') is True and not final.get('issues') and final['state'].startswith('terminé')
    document = '<section class="note" id="summary"><h2>Synthèse</h2><p class="status">'
    document += 'Campagne finale v5 validée par les contrôles du rapport.' if complete else 'Campagne finale v5 non validée : résultats incomplets ou contrôles encore en cours.'
    document += '</p><p>La référence v4 contient déjà les corrections précédentes. Les différences v4 → v5 ci-dessous mesurent uniquement cette nouvelle étape ; elles ne reproduisent pas les chiffres obtenus sur la machine de référence de l’utilisateur.</p>'
    inherited = report['reference'].get('sourceSha256', {})
    def inherited_source(name, description):
        return description + ' ' + link(base, 'reference-v4/source/' + name, 'Source v4') if name in inherited else 'Preuve héritée indisponible.'
    idle_done = complete and len(final['idle']) == 3 and all(item['state'] == 'terminé' for item in final['idle'])
    install = report.get('installation', {})
    statuses = [
        ['Threads et fichiers — héritage v4', inherited_source('crates/prnext/src/main.rs', 'Nombre maximal de threads bloquants configurable, avec instrumentation héritée ; aucune borne de longueur de la file statique n’est déduite.') + ' · ' + link(base, 'reference-v4/source/crates/prnext/src/blocking.rs', 'Instrumentation v4')],
        ['Ancien build/runtime — héritage v4', inherited_source('crates/prnext/src/runtime_contract.rs', 'Contrat runtime déjà contrôlé au démarrage ; reconstruire l’application avec le runtime correspondant.')],
        ['Repos et reprise', ('Trois profils vérifiés dans la campagne v5. ' if idle_done else 'Mesures v5 encore absentes, incomplètes ou non validées. ') + '<a href="#final">Durées, CPU, RSS et premières réponses</a>.'],
        ['Statique et profils — campagne v5', ('Comparaisons finales disponibles ci-dessous. ' if complete else 'Aucun gain final annoncé avant validation complète. ') + '<a href="#experiments">Essais exploratoires et pistes rejetées</a>.'],
        ['Installation', esc(install.get('state', 'preuve indisponible')) + ' · <a href="#installation">Preuves Windows et limites</a>.'],
        ['Linux et compatibilité', 'Linux non exécuté dans cette campagne Windows. Les options Next prises en charge et leurs limites sont <a href="#compatibility">documentées séparément</a> ; aucune compatibilité universelle n’est déduite.'],
    ]
    document += table(['Priorité', 'État et portée'], [[esc(label), value] for label, value in statuses])
    pairs = final_summary_pairs(report)
    if pairs:
        rows = []
        for pair in pairs:
            values = []
            for name, digits in [('rps', 1), ('cpuMsPerResponse', 4), ('rssMiB', 1), ('p99', 1)]:
                value = pair['metrics'][name]
                values.append(number(value['before'], digits) + ' → ' + number(value['after'], digits)
                              + '<span class="range">Δ ' + number(value['delta'], 1) + ' %</span>')
            rows.append([esc(pair['profile']), '<a href="#experiment-' + esc(pair['experiment']) + '">' + esc(route_label(pair['route']) + ' · c' + str(pair['connections'])) + '</a>', *values])
        document += '<h3>Comparaison finale compacte : v4 → v5</h3>' + table(['Profil', 'Scénario', 'req/s', 'CPU ms/rép.', 'RSS Mio', 'p99 ms'], rows,
                    'Médianes des seules paires finales validées. Étendues et répétitions dans les détails liés. Débit positif favorable ; CPU/RSS/p99 positifs défavorables. Les petits écarts ne prouvent pas un gain.')
    else:
        document += '<p class="pending">Tableau final non publié : aucune paire finale globalement validée. Les mesures exploratoires restent dans le détail.</p>'
    return document + '</section>'


def render_compatibility(item, base):
    document = '<section id="compatibility"><h2>Installation et compatibilité Next.js</h2><p>' + esc(item['state']) + '.</p>'
    data = item['review']
    if not data:
        return document + '</section>'
    document += '<p>' + link(base, item['source'], 'Revue de compatibilité et empreintes des preuves') + ' · <a href="#final">Tests du candidat final</a>. Les tests exploratoires de cette revue ne remplacent pas la validation finale ; aucune garantie générale de compatibilité Next.js n’en découle.</p>'
    document += '<p>Cette revue historique précède la nouvelle reproduction de <code>npm ci</code> et les suites finales. L’état actualisé se trouve dans <a href="#installation">les preuves d’installation</a> et ' + link(base, 'validation-scope.json', 'la portée des validations finales') + ' ; ses anciens compteurs et l’absence de journal alors constatée restent datés.</p>'
    if item['issues']:
        document += evidence(base, item['issues'], 'Écarts avec les preuves de la revue')
    document += '<h3>Corrections conservées de v4</h3>'
    rows = []
    for entry in data.get('retainedV4', []):
        topic = entry.get('topic', 'Sujet non renseigné')
        if 'cleanInstall' in entry:
            install = entry['cleanInstall']
            detail = (str(len(entry.get('addedPackages', []))) + ' entrées natives optionnelles ajoutées au lockfile. '
                      + str(install.get('command', 'commande non renseignée')) + ' : code ' + str(install.get('exitCode', 'inconnu'))
                      + ', Node ' + str(install.get('node', 'inconnu')) + ', npm ' + str(install.get('npm', 'inconnu'))
                      + ', ' + str(install.get('platform', 'plateforme non renseignée')) + '.')
            limits = 'Installation native réellement exécutée sur Windows x64 seulement ; autres plateformes : métadonnées vérifiées, installation non exécutée.'
        else:
            supported = entry.get('supported', [])
            if topic == 'reactCompiler et typedRoutes':
                detail = 'reactCompiler:false et typedRoutes:false acceptés ; absence : désactivés. Activation refusée explicitement.'
            else:
                detail = ' '.join(supported) if isinstance(supported, list) else str(supported)
            limits = entry.get('limits', '')
            limits = ' '.join(limits) if isinstance(limits, list) else str(limits)
        rows.append([esc(topic), esc(detail), esc(limits)])
    document += table(['Composant', 'Comportement documenté', 'Limites'], rows)
    if any(entry.get('topic') == 'typescript' for entry in data.get('retainedV4', [])):
        document += '<p>Le contrôle TypeScript exige une option explicite : sans <code>typescript</code>, PRNext conserve la transpilation seule. Aucun plugin TypeScript Next, aucun type de route Next et aucun <code>next-env.d.ts</code> ne sont générés.</p>'
    document += '<p>' + link(base, '../../packages/prnext/README.md', 'Options prises en charge et limites documentées') + ' · ' + link(base, '../../packages/prnext/build/typescript.test.mjs', 'Tests réels des options et du compilateur TypeScript') + ' · ' + link(base, 'tests/final/unit.json', 'Résultat unitaire du candidat final') + '.</p>'
    document += '<h3>Correction nouvelle en v5</h3>'
    for entry in data.get('newV5', []):
        document += '<p><strong>' + esc(entry.get('topic', 'Sujet non renseigné')) + '.</strong> ' + esc(entry.get('conclusion', '')) + ' ' + esc(entry.get('tradeoff', '')) + '</p>'
        if entry.get('defaultsChangedByThisFix') is False:
            document += '<p>Cette correction de l’override explicite ne change pas elle-même les valeurs par défaut des profils ; les variantes de politique V8 sont évaluées séparément dans les expériences.</p>'
    return document + '</section>'


def render_validation_scope(item, base):
    document = '<section id="validation-scope"><h3>Portée des suites et cas non exécutés</h3><p>'
    document += esc(item.get('state', 'portée détaillée absente ou indisponible')) + '. '
    document += link(base, item.get('source', 'validation-scope.json'), 'Portée, empreintes et exclusions exactes') + '.</p>'
    document += '<p>Ces suites vérifient des contrats finis ; elles ne garantissent pas la compatibilité générale de toutes les applications et fonctionnalités Next.js. Linux et Nginx ne sont pas exécutés dans cette campagne Windows.</p>'
    if item.get('issues'):
        document += evidence(base, item['issues'], 'Écarts empêchant de valider cette portée')
    if item.get('verified'):
        data = item['data']
        counts = data['passed']
        document += table(['Vérification', 'Réussites déclarées et rapprochées des preuves'],
                          [[label, esc(counts[key])] for key, label in [('rust', 'Tests Rust'), ('unit', 'Tests unitaires'), ('e2e', 'Tests E2E'), ('nextOracle', 'Contrats comparés à Next 16.3.5'), ('typescriptProjects', 'Projets TypeScript')]])
        reasons = {
            'Manual timing test; separate immutable exploratory static benchmarks were executed.': 'Mesure manuelle de durée ; des benchmarks statiques exploratoires séparés ont été exécutés.',
            'Node-API development headers are not installed.': 'Headers de développement Node-API non installés.',
            'Unix SIGTERM behavior is skipped on Windows.': 'Comportement du signal Unix SIGTERM non exécuté sur Windows.',
        }
        document += table(['Suite', 'Cas non exécuté', 'Raison'],
                          [[esc(row['suite']), '<code>' + esc(row['case']) + '</code>', esc(reasons.get(row['reason'], row['reason']))] for row in data['notExecuted']])
    return document + '</section>'


def render(report, base):
    env = report['environment']; final = report['final']
    document = '''<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRNext v5 — expériences et validation</title><style>
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#172532;font:16px/1.55 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:32px clamp(16px,3vw,48px) 64px}h1{font-size:clamp(28px,4vw,42px);letter-spacing:-.025em;line-height:1.15;margin:0 0 16px}h2{font-size:25px;margin:40px 0 12px}h3{font-size:20px;margin:0 0 8px}p{max-width:110ch}a{color:#075d97;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #b4510d;outline-offset:3px}nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}.note,article{background:#fff;border:1px solid #d4dde4;border-radius:10px;padding:20px;margin:16px 0}.note{border-left:5px solid #b46c19}.status{font-weight:650}.pending,.muted,.range{color:#53616d}.range{display:block;font-size:12px;white-space:nowrap}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}caption{text-align:left;color:#53616d;padding-bottom:8px}th,td{padding:10px 9px;text-align:left;border-bottom:1px solid #dce3e8;vertical-align:top}th{background:#edf2f5;font-weight:650}tbody tr:hover{background:#f5f8fa}.scroll{overflow:auto;max-width:100%;margin:16px 0}details{margin:12px 0}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;background:#edf2f5;padding:12px}code{overflow-wrap:anywhere}footer{font-size:13px;color:#53616d;margin-top:36px}@media print{body{background:white}main{padding:0}.scroll{overflow:visible}article{break-inside:avoid}th,td{padding:6px;font-size:10px}details{display:block}}
    </style></head><body><main><h1>PRNext v5<br>Expériences et validation</h1>'''
    document += '<p>Référence : état final v4, issu du commit <code>' + esc(env.get('baseCommit', 'non renseigné')) + '</code>. ' + link(base, 'reference-v4/reference.json', 'Instantané de référence') + '.</p>'
    document += '<div class="note"><strong>Validation finale : ' + esc(final['state']) + '.</strong><p>Les essais exploratoires ci-dessous restent séparés des résultats du candidat retenu. Une absence, une écriture incomplète ou une empreinte différente ne vaut jamais réussite. Les tentatives rejetées restent consultables.</p></div>'
    document += '<nav aria-label="Sections">' + ''.join('<a href="#' + name + '">' + title + '</a>' for name, title in [('summary','Synthèse'),('decisions','Décisions'),('experiments','Expériences'),('micro','Micro-mesures'),('final','Validation finale'),('lifecycle','Workers'),('diagnostics','GC et ETW'),('installation','Installation'),('compatibility','Compatibilité'),('method','Méthode et limites'),('sources','Sources')]) + '</nav>'
    document += '<p>' + esc(str(env.get('platform', 'Plateforme non renseignée')) + ' ; Node ' + str(env.get('node', '—')) + ' ; Next.js ' + str(env.get('next', '—')) + ' ; React ' + str(env.get('react', '—')) + '. Serveur CPU ' + str(env.get('serverCpu', '—')) + ', générateur ' + str(env.get('generatorCpus', '—')) + '.') + ' ' + link(base, 'environment.json', 'Versions et machine') + '.</p>'
    document += render_summary(report, base)
    document += '<h2 id="decisions">Décisions et hypothèses</h2><p>Le registre fournit les décisions déclarées et leur justification ; ses textes sont conservés tels qu’écrits. Une micro-mesure ne remplace pas un essai HTTP.</p>'
    decisions = report['ledger'].get('experiments', [])
    rows = []
    for item in decisions:
        links = [link(base, 'experiments/' + item[key], key) for key in ('evidence','microbenchmark','source') if item.get(key)]
        rows.append([esc(item.get('id', '—')), esc(item.get('status', 'non renseigné')), esc(item.get('reason', item.get('change', '—'))), ' · '.join(links) or '—'])
    document += table(['Piste', 'Décision déclarée', 'Motif / modification', 'Preuve'], rows)
    document += '<p>' + link(base, 'experiments/ledger.json', 'Registre complet') + ' · ' + link(base, 'final-selection.json', 'Sélection finale et compromis') + ' · ' + link(base, 'final-results-interpretation.json', 'Recalcul indépendant des comparaisons') + ' · ' + link(base, 'experiments/static-handles/README.md', 'Analyse du chemin statique et alternatives rejetées') + '.</p>'
    document += '<h2 id="experiments">Comparaisons exploratoires</h2><p>La baisse du CPU par réponse indique un coût réduit. Un débit accru peut s’accompagner de davantage de RAM ou de latence : les indicateurs restent séparés. Les petites différences et étendues chevauchantes ne démontrent pas un gain.</p>'
    for item in report['experiments']:
        if not item['final']:
            document += render_experiment(item, base)
    document += '<h2 id="micro">Micro-mesures isolées</h2><p>Ces durées concernent une opération dans un processus Node, pas le débit réseau ni le CPU de tout le serveur. Aucun de leurs appels n’entre dans les totaux des campagnes HTTP. Sans empreinte de runner, sa version exacte n’est pas établie par le JSON.</p>'
    for micro in report['microbenchmarks']:
        document += '<article><h3>' + esc(micro['name']) + '</h3><p>' + link(base, micro['source']) + ' · Node ' + esc(micro['node']) + ' · CPU ' + esc(micro['affinity']) + '. ' + esc(micro['method']) + '</p>'
        document += table(['Corpus', 'Variante', 'n', 'Temps ns/opération', 'CPU ns/opération'], [[esc(row['case']),esc(row['variant']),esc(row['runs']),distribution(row['wallNs'],0),distribution(row['cpuNs'],0)] for row in micro['rows']])
        document += evidence(base, {key:micro[key] for key in ('sourceSha256','runnerSha256')}, 'Empreintes déclarées') + '</article>'
    if not report['microbenchmarks']:
        document += '<p class="pending">Aucune micro-mesure disponible.</p>'
    document += render_mechanism_probes(report['mechanismProbes'], base)
    document += '<details><summary>Tests intermédiaires conservés, distincts de la validation finale</summary>'
    document += table(['Preuve','État','Tests','Succès','Échecs','Ignorés','Durée s'], [[link(base,row['source']) + (' · '+link(base,row['log'],'journal') if row['log'] else ''),esc(row['state']),esc(row['counts'].get('tests','—')),esc(row['counts'].get('pass','—')),esc(row['counts'].get('fail','—')),esc(row['counts'].get('skipped','—')),number(row['seconds'])] for row in report['exploratoryTests']]) + '</details>'
    document += '<h2 id="final">Candidat final</h2><p class="status">' + esc(final['state']) + '</p><p>' + link(base, 'final.json', 'Manifeste final') + '.</p>'
    if final['issues']:
        document += evidence(base, final['issues'], 'Incohérences excluant la validation finale')
    final_trials = [item for item in report['experiments'] if item['final']]
    document += ''.join(render_experiment(item, base) for item in final_trials) or '<p class="pending">Comparaison finale non exécutée ou non déclarée.</p>'
    document += '<h3>Endurance</h3>'
    soak = final['soak']
    if soak and soak['state'] == 'terminé':
        value = soak['value']
        if soak.get('instrumented') is True:
            document += '<p>Métriques de workers activées pour cette endurance instrumentée : leur coût est inclus. Cette observation de stabilité reste distincte des comparaisons de débit sans instrumentation.</p>'
        elif soak.get('instrumented') is not False:
            document += '<p>État de l’instrumentation non renseigné pour cette endurance ; ne pas l’assimiler aux comparaisons de débit sans instrumentation.</p>'
        document += table(['Durée mesurée s','req/s','CPU ms/rép.','RSS Mio','RSS pic Mio','p50 / p95 / p99 ms','Erreurs HTTP','Erreurs de validation','Créations'], [[number(value.get('durationSeconds'),0),number(value.get('rps')),number(soak.get('cpuMsPerResponse'),4),number(soak.get('rssMiB')),number(soak.get('rssPeakMiB')),' / '.join(number(value.get(k),1) for k in ('p50','p95','p99')),esc(value.get('errors','—')),esc(value.get('validationErrors','—')),esc(soak.get('processesStarted','—'))]])
        document += '<p>' + link(base, soak['source'], 'Résultat brut et ressources avant/après') + '. Une durée finie sans erreur ne démontre pas l’absence de fuite à plus long terme.</p>'
        document += '<p>Annulations planifiées : ' + esc(value.get('plannedDisconnects','non comptées')) + ' effectuées pour ' + esc(value.get('cancelStarts','—')) + ' démarrages ; compteur distinct des erreurs. Générateur : ' + number(value.get('generatorCpuPercent')) + ' % ; dépassements de l’histogramme à 12 s : ' + esc(value.get('latencyOverflow','—')) + ' ; maximum observé : ' + number(value.get('maxLatencyMs')) + ' ms.</p>'
        document += table(['Fenêtre min','RSS Mio','Commit privé Mio','Threads','Handles','Processus'], [[number(row['start']/60,1)+' – '+number(row['end']/60,1)+(' (dernière minute)' if row['lastMinuteObservation'] else ''),distribution(row['rssMiB']),distribution(row['privateCommitMiB']),distribution(row['threads'],0),distribution(row['handles'],0),distribution(row['processes'],0)] for row in soak['windows']], 'Médianes et étendues depuis le début de la charge : fenêtres disjointes 0–15, 15–30 et 30–60 min, fin exclue. La dernière minute est une observation séparée jusqu’au dernier relevé et peut inclure le drainage. Les premières minutes peuvent encore comprendre la stabilisation du tas ; les processus incluent tous les membres vivants du Job, pas uniquement Node.')
        document += evidence(base, {key:soak.get(key) for key in ('serverCpu','generatorCpus','startedAt','finishedAt','instrumented','idleAfter','resume')}, 'Contexte temporel, instrumentation, repos et reprise après endurance')
    else:
        document += '<p class="pending">' + esc(soak['state'] if soak else 'Non exécutée / résultat absent') + '.</p>'
    document += '<h3>Repos et reprise</h3>'
    document += '<p>' + link(base, 'stability-final-verified.json', 'Analyse indépendante des séries, ressources et deux réponses de reprise') + '. Les pentes de mémoire sont descriptives : une faible dérive ne démontre ni une fuite, ni son absence à durée illimitée.</p>'
    document += '<p>Sur les très courtes reprises, la résolution du compteur CPU du Job — pas observés de 15,625 ms dans cette campagne — peut donner zéro mesuré. Ce zéro ne signifie pas une absence de travail CPU ; il faut lire ces phases avec leurs latences et leur durée.</p>'
    document += '<p>Les générateurs partagent les CPU 8/9 entre campagnes. Certaines phases de charge et de reprise au repos dépassent le seuil de charge global : leurs latences décrivent cette exécution et ne mesurent pas un minimum isolé. La stabilité et la libération des ressources restent observables. Les comparaisons finales de débit excluent et rejouent les essais dépassant ce seuil.</p>'
    for item in final['idle']:
        document += '<p>' + link(base,item['source']) + ' : ' + esc(item['state']) + '</p>'
        document += table(['Phase','Durée s','CPU % cœur','RSS finale Mio','Commit privé final Mio','Handles finaux','Threads','Processus','Créations','1re réponse ms'], [[esc(row['label']),number(row['elapsedSeconds'],1),number(row['cpuPercent'],4),number(row['rssMiB']),number(row['privateCommitMiB']),esc(row['handles']),esc(row['threads']),esc(row['processes']),esc(row['processesStarted']),number(row['firstMs'])] for row in item['rows']])
    if not final['idle']:
        document += '<p class="pending">Cycles de repos non exécutés / résultats absents.</p>'
    document += '<h3>Tests et contrôles fonctionnels</h3>' + table(['Preuve','État','Tests','Succès','Échecs','Ignorés','Durée s'], [[link(base,row['source']) + (' · '+link(base,row['log'],'journal') if row['log'] else ''),esc(row['state']),esc(row['counts'].get('tests','—')),esc(row['counts'].get('pass','—')),esc(row['counts'].get('fail','—')),esc(row['counts'].get('skipped','—')),number(row['seconds'])] for row in final['tests']])
    document += render_validation_scope(report.get('validationScope', {}), base)
    document += '<p>' + link(base, 'tests/post-campaign-verified/exit.json', 'Tests finaux des outils de rapport et de provenance') + ' · ' + link(base, 'tests/report-review-final/exit.json', 'Contrôle des derniers libellés et limites du rapport') + ' · ' + link(base, 'tests/stability-final/tests.json', 'Tests de l’analyse indépendante de stabilité') + '.</p>'
    document += table(['Preuve fonctionnelle','État','Contrôles','Cas ignorés'], [[link(base,row['source']),esc(row['state']),esc(len(row['checks'])),esc(len(row['skipped']))] for row in final['functional']])
    for row in final['functional']:
        document += evidence(base, {'checks':row['checks'], 'skipped':row['skipped']}, 'Détail des contrôles : ' + row['source'])
    document += render_lifecycle(report['lifecycle'], base)
    document += diagnostic_module().render(report['diagnostics'], base)
    document += '<p>' + link(base, 'diagnostic-interpretation.json', 'Interprétation documentaire des diagnostics GC et ETW') + '. Une fréquence GC plus faible étaye une hypothèse, sans démontrer à elle seule la cause d’un gain CPU. La durée GC écoulée n’est pas du CPU et les tas par isolate ne sont pas le RSS global. Les observations de balanced ne se généralisent pas automatiquement à memory ; ces diagnostics instrumentés restent distincts des comparaisons HTTP finales.</p>'
    document += installation_module().render(report['installation'], base)
    document += render_compatibility(report['compatibility'], base)
    document += '<p>' + link(base, 'compatibility-final-status.json', 'État final des options et de l’installation, avec portée exacte des vérifications') + '.</p>'
    document += '<h2 id="method">Méthode et limites</h2><ul><li>CPU cumulé des Jobs Windows : Rust, Node, threads et processus déjà terminés. RSS : somme des working sets vivants, pages partagées potentiellement comptées plusieurs fois ; pas de PSS ni de plafond RAM imposé.</li><li>Débit : réponses terminées dans la fenêtre ; CPU/réponse : drainage inclus, divisé par toutes les réponses terminées. Les échauffements restent hors agrégats, leurs erreurs restent visibles.</li><li>Ordre alterné entre répétitions. Toute compilation détectée entraîne exclusion et nouvel essai ; les services de l’utilisateur restent actifs. Un générateur au-delà de 85 % invalide l’estimation du plafond serveur.</li><li>Médianes et étendues entre essais ; p50/p95/p99 non fusionnés en histogramme global. Les pics de RSS et threads restent soumis à l’échantillonnage.</li><li>Aucun cache de réponse dynamique ajouté. La fraîcheur, les cookies, le streaming progressif et les annulations exigent leurs propres preuves fonctionnelles ; zéro erreur HTTP ne les démontre pas.</li><li>Le chemin statique conserve les cas conditionnels/ranges et la sécurité des chemins. Le handle Windows lie contrôle et lecture de la même représentation sur le chemin court ; il ne rend pas atomiques les écritures concurrentes en place. Les replis conservent leur comportement historique. Le cache Windows demeure désactivé.</li><li>Les profils équilibrent débit, mémoire et reprise. L’essai size-policy ne doit changer que optimizeForSize pour balanced/memory ; ses effets doivent être vérifiés avec les configurations conservées, sans assimiler ces profils à speed.</li><li>Linux, Nginx et les tests propres à Unix ne sont pas exécutés par cette campagne Windows. Les résultats ne sont ni un débit de production ni une preuve de dépassement de Nginx. Aucun VPS ou service de production utilisé.</li></ul>'
    document += '<p>Dans chaque répétition et variante, le même serveur traite les scénarios dans l’ordre de la configuration : SSR, streaming, puis API pour la comparaison dynamique. Le RSS peut donc inclure l’état acquis pendant les scénarios précédents ; référence et candidat suivent le même ordre. Cette machine Windows et ce protocole ne reproduisent pas la machine ni les chiffres de référence initiaux de l’utilisateur.</p>'
    document += '<h2 id="sources">Sources et état des entrées</h2>'
    document += '<p>Chaque lien local n’est créé que si le fichier existe. Les SHA-256 ci-dessous portent sur les octets lus pour ce rapport ; des fichiers encore en cours peuvent ensuite évoluer.</p>'
    document += '<details><summary>Fichiers lus et empreintes SHA-256</summary>' + table(['Source','SHA-256'], [[link(base,name),'<code>'+esc(digest)+'</code>'] for name,digest in sorted(report['hashes'].items())]) + '</details>'
    problems = [row for row in report['inputs'] if row['state'] != 'lu']
    document += table(['Source','État','Détail'],[[esc(row['source']),esc(row['state']),esc(row['detail'])] for row in problems]) if problems else '<p>Aucun fichier lu tronqué ou inaccessible.</p>'
    document += '<footer>Généré le ' + esc(report['generatedAt']) + ' UTC. ' + link(base,'../../tests/performance/report-v5.py','Générateur du rapport') + '.</footer></main></body></html>\n'
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=pathlib.Path, default=DEFAULT_BASE)
    args = parser.parse_args()
    args.base.mkdir(parents=True, exist_ok=True)
    report = collect(args.base)
    output = args.base / 'report.html'
    output.write_text(render(report, args.base.resolve()), encoding='utf-8')
    print(json.dumps({'output':str(output), 'experiments':len(report['experiments']), 'finalState':report['final']['state']}, ensure_ascii=True))


if __name__ == '__main__':
    main()
