"""Shared read-only verification/rendering of the isolated npm reproduction.

No subprocess, installation or network access. Audit may consume collect()['verified']
after HTTP screening; the report never substitutes a declared success for raw proof.
"""
import hashlib
from html import escape
import io
import json
import pathlib
import re
import urllib.parse
import zipfile

COMMIT = '63847087826f178de3a32f165231b20b6c66b92e'
NODE_SHA = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'
LOCK_SHA = '7ee2fd2fc24826ecd159f9b6bf7e23845ebf72d90af9dff459f3b8b399ec4029'
NATIVE = ['prnext-darwin-arm64', 'prnext-darwin-x64', 'prnext-linux-arm64-gnu',
          'prnext-linux-x64-gnu', '@thomas.f/prnext-win32-arm64-msvc',
          '@thomas.f/prnext-win32-x64-msvc']
FLAGS = ['ci', '--no-audit', '--no-fund', '--ignore-scripts=false', '--include=dev', '--include=optional']
INSTALLED = {'react': '19.3.0', 'react-dom': '19.3.0', 'react-server-dom-webpack': '19.3.0',
             'typescript': '5.9.3', 'esbuild': '0.28.2', '@thomas.f/prnext-win32-x64-msvc': '0.1.11-alpha'}


def collect(inputs):
    folder = pathlib.Path(inputs.base) / 'install-reproduction'
    file = folder / 'result.json'
    result = {'source': 'install-reproduction/result.json', 'present': file.is_file(),
              'verified': False, 'state': 'non exécutée ou résultat indisponible',
              'issues': [], 'runs': [], 'links': []}
    if not file.is_file():
        return result

    def require(condition, message):
        if not condition:
            raise ValueError(message)

    def raw(path, link=True):
        path = pathlib.Path(path)
        require(path.resolve().is_relative_to(folder.resolve()), 'Preuve hors du dossier isolé')
        content = inputs.raw(path)
        require(content is not None, 'Preuve absente : ' + path.name)
        name = inputs.relative(path)
        if link and name not in result['links']:
            result['links'].append(name)
        return content

    def read(path):
        value = json.loads(raw(path).decode('utf-8-sig'))
        require(isinstance(value, dict), 'Objet JSON attendu : ' + pathlib.Path(path).name)
        return value

    def record(label):
        value = read(folder / (label + '.exit.json'))
        command = read(folder / (label + '.command.json'))
        for key in ('command', 'cwd', 'startedAt', 'stdout', 'stderr'):
            require(command.get(key) == value.get(key), 'Commande/fin incohérentes : ' + label)
        require(value.get('error') is None and not value.get('cleanupError'), 'Erreur de processus/nettoyage : ' + label)
        require(type(value.get('exitCode')) is int, 'Code de sortie absent ou invalide : ' + label)
        texts = []
        for stream in ('stdout', 'stderr'):
            path = folder / (label + '.' + stream + '.log')
            require(pathlib.Path(value.get(stream, '')).resolve() == path.resolve(), 'Journal détourné : ' + label)
            content = raw(path)
            require(hashlib.sha256(content).hexdigest() == value.get(stream + 'Sha256'), 'SHA journal différent : ' + label)
            texts.append(content.decode('utf-8-sig'))
        return value, '\n'.join(texts)

    try:
        data = read(file)
        result['state'] = 'résultat présent, non vérifié'
        require(data.get('complete') is True and data.get('expectedOutcomeMatched') is True
                and data.get('error') is None, 'Reproduction incomplète ou résultat inattendu')
        require(data.get('referenceCommit') == COMMIT, 'Commit original différent')
        started = read(folder / 'started.json')
        require(started.get('commit') == COMMIT, 'Commit de départ différent')
        require(hashlib.sha256(raw(folder / 'install-reproduction-v5.py')).hexdigest()
                == started.get('harnessSha256'), 'Empreinte du script exécuté différente')
        tools = data.get('tools', {})
        require(tools.get('nodeVersion') == 'v24.19.0' and tools.get('npmVersion') == '11.12.1'
                and tools.get('nodeSha256') == NODE_SHA, 'Versions/empreinte Node/npm non vérifiées')
        for label, expected, command in (
            ('node-version', 'v24.19.0', [tools.get('node'), '--version']),
            ('npm-version', '11.12.1', [tools.get('node'), tools.get('npmCli'), '--version']),
            ('commit', COMMIT, ['git', 'rev-parse', COMMIT + '^{commit}']),
        ):
            proof, text = record(label)
            require(proof.get('exitCode') == 0 and text.strip() == expected
                    and proof.get('command') == command, 'Preuve de version/commit invalide : ' + label)
        archive = raw(folder / 'reference.zip')
        require(hashlib.sha256(archive).hexdigest() == data.get('archiveSha256'), 'SHA archive différent')
        archive_proof, _ = record('git-archive')
        require(archive_proof.get('exitCode') == 0 and archive_proof.get('command') == [
            'git', 'archive', '--format=zip', '--output=' + str(folder / 'reference.zip'), COMMIT],
            'Commande git archive différente')
        before = read(folder / 'sources-before.json')
        require(set(before) == {'original', 'lock-fixed'}, 'Inventaires initiaux incomplets')
        archived = {}
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            require(source.comment.decode('ascii') == COMMIT, 'Commit embarqué dans le ZIP différent')
            for entry in source.infolist():
                if entry.is_dir():
                    continue
                name = entry.filename
                require(not name.startswith(('/', '\\')) and '\\' not in name
                        and all(part not in ('', '.', '..') and ':' not in part for part in name.split('/')),
                        'Chemin dangereux dans le ZIP')
                require(name not in archived and entry.file_size <= 256 * 1024**2, 'Entrée ZIP dupliquée ou excessive')
                archived[name] = hashlib.sha256(source.read(entry)).hexdigest()
        require(archived == before['original'] and len(archived) == data.get('sourceFileCount'), 'Sources originales différentes de git archive')
        require(set(before['original']) == set(before['lock-fixed']), 'Fichiers différents entre copies')
        changed = [name for name in archived if before['original'][name] != before['lock-fixed'][name]]
        require(changed == ['package-lock.json'] and data.get('sourceDifferences') == changed,
                'La comparaison ne modifie pas uniquement le lockfile')
        require(before['lock-fixed'].get('package-lock.json') == LOCK_SHA, 'Lock corrigé différent de la preuve conservée')
        runs = data.get('runs', [])
        require(len(runs) == 2 and [row.get('label') for row in runs] == ['original', 'lock-fixed'], 'Deux installations distinctes sont requises')
        for declared in runs:
            label = declared['label']
            proof, text = record(label)
            for key, value in proof.items():
                require(declared.get(key) == value, 'Résumé/fin incohérents : ' + label + '/' + key)
            require(proof.get('command') == [tools['node'], tools['npmCli'], *FLAGS], 'npm ci ou scripts/options modifiés : ' + label)
            require(pathlib.Path(proof.get('cwd', '')).resolve() == (folder / label).resolve(), 'Installation hors copie : ' + label)
            require(declared.get('scriptsEnabled') is True and declared.get('optionalDependenciesEnabled') is True,
                    'Scripts ou dépendances optionnelles non actifs')
            after = read(folder / (label + '.sources-after.json'))
            require(after == before[label] and declared.get('sourceChanges') == [], 'Sources modifiées pendant installation : ' + label)
            for name, expected in after.items():
                require(hashlib.sha256(raw(folder / label / name, link=False)).hexdigest() == expected, 'Source copiée modifiée : ' + label + '/' + name)
            require(declared.get('lockSha256Before') == after['package-lock.json']
                    and declared.get('lockSha256After') == after['package-lock.json'], 'Lockfile changé pendant installation')
            missing = re.findall(r'\bMissing:\s+(\S+)\s+from lock file', text)
            require(declared.get('allMissingEntries') == missing, 'Comptage Missing différent du journal')
            require(declared.get('observedEusage') == ('EUSAGE' in text), 'État EUSAGE différent du journal')
            expected_missing = {name + '@0.1.11-alpha' for name in NATIVE}
            if label == 'original':
                require(type(proof.get('exitCode')) is int and proof['exitCode'] != 0
                        and 'EUSAGE' in text and len(missing) == 6 and set(missing) == expected_missing,
                        'Échec original avec exactement six Missing non démontré')
                require(set(declared.get('missingNativeEntries', [])) == set(NATIVE), 'Résumé des six paquets différent')
            else:
                require(proof.get('exitCode') == 0 and not missing and 'EUSAGE' not in text,
                        'Installation corrigée réussie non démontrée')
                for package, expected in INSTALLED.items():
                    installed = json.loads(raw(folder / label / 'node_modules' / package / 'package.json', link=False))
                    require(installed.get('version') == expected
                            and declared.get('installedVersions', {}).get(package) == expected,
                            'Version installée différente : ' + package)
            result['runs'].append({'label': label, 'exitCode': proof['exitCode'], 'missingCount': len(missing),
                                   'scriptsEnabled': True, 'durationSeconds': proof.get('durationSeconds')})
        require(data.get('rootLockStillUnchanged') is True, 'Le lockfile racine a changé')
        result.update(verified=True, state='reproduction vérifiée : original EUSAGE × 6, corrigé réussi',
                      node='24.19.0', npm='11.12.1', platform='Windows x64', lockSha256=LOCK_SHA)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, UnicodeError) as error:
        result['issues'].append(str(error))
        result['state'] = 'preuve incomplète, incohérente ou résultat inattendu — réussite non confirmée'
    return result


def verify(base):
    """Audit entry point; uses exactly the same checks as the HTML report."""
    class Inputs:
        def __init__(self, directory):
            self.base = pathlib.Path(directory).resolve()
            self.hashes = {}

        def relative(self, file):
            return pathlib.Path(file).resolve().relative_to(self.base).as_posix()

        def raw(self, file):
            try:
                content = pathlib.Path(file).read_bytes()
            except FileNotFoundError:
                return None
            self.hashes[self.relative(file)] = hashlib.sha256(content).hexdigest()
            return content

    inputs = Inputs(base)
    result = collect(inputs)
    result['inputSha256'] = inputs.hashes
    return result


def render(data, base=None):
    out = ['<section id="installation"><h2>Installation npm reproduite</h2>',
           '<p>' + escape(data['state']) + '.</p>']
    if data['verified']:
        out.append('<p>Sur Windows x64, Node 24.19.0 et npm 11.12.1 : le commit original échoue avec EUSAGE et exactement six dépendances natives absentes du lockfile. La même copie avec le seul lockfile corrigé réussit ; scripts et dépendances optionnelles actifs, sources et lockfile inchangés après installation.</p>')
        out.append('<p>Cette vérification ne prouve pas l’installation native sur les cinq autres plateformes.</p>')
    for issue in data['issues']:
        out.append('<p class="warning">' + escape(issue) + '</p>')
    if data['links']:
        out.append('<details><summary>Résultats bruts et empreintes vérifiées</summary><ul>')
        for name in data['links']:
            # All listed paths were successfully read by collect; no absent link.
            # The enclosing report lives at base/report.html. Keep links relative
            # to that base, including when its caller passes an absolute Path.
            href = urllib.parse.quote(name, safe='/._-')
            out.append('<li><a href="' + escape(href, quote=True) + '">' + escape(name) + '</a></li>')
        out.append('</ul></details>')
    out.append('</section>')
    return '\n'.join(out)
