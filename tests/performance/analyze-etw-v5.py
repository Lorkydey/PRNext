"""Read completed v5 ETW exports. No capture, symbol lookup or source mutation.

Only a new analysis.json is written; an existing analysis is never overwritten.
CPU percentages are sample weights, not source-level function attribution.
FileIoRead Size is requested bytes, not physical-disk bytes or network bytes.
"""
import argparse
import collections
import csv
import datetime
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_FOLDER = ROOT / 'artifacts/performance-v5/etw/static-final'
PID = re.compile(r'\(\s*(\d+)\)\s*$')


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def sha(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def pid(value):
    match = PID.search(value)
    return int(match[1]) if match else None


def integer(value):
    value = value.strip()
    return int(value, 16) if value.lower().startswith('0x') else int(value)


def rows(file, encoding):
    with file.open(encoding=encoding, errors='strict', newline='') as source:
        for row in csv.reader(source, skipinitialspace=True):
            yield [value.strip() for value in row]


def normalized(path):
    value = path.replace('/', '\\').lower()
    return value[4:] if value.startswith('\\\\?\\') else value


def analyse(folder, label, encoding):
    record_file = folder / (label + '.json')
    data = read(record_file)
    assert data.get('complete') is True and data.get('instrumented') is True, label + ': incomplete capture'
    assert data.get('label') == label and label in ('v4', 'v5')
    plan = read(folder / 'plan.json')
    variant = next(row for row in plan['variants'] if row['label'] == label)
    for field in ('binarySha256', 'buildSha256', 'publicSha256', 'command', 'wireSha256', 'wireBytes'):
        assert data[field] == variant[field], (label, 'capture/plan mismatch', field)
    assert sha(folder / (label + '.etl')) == data['etlSha256'], label + ': changed ETL'
    for name, expected in data['exportsSha256'].items():
        assert pathlib.PurePath(name).name == name and '/' not in name and '\\' not in name
        assert sha(folder / name) == expected, (label, 'changed export', name)
    required = {label + '-' + suffix + '.csv' for suffix in ('profile', 'dumper', 'diskio', 'tracestats')}
    assert required == set(data['exportsSha256']), label + ': incomplete export inventory'
    load = data['load']
    responses = load['value']['count']
    assert responses > 0 and load['value']['errors'] == 0 and load['value']['started'] == responses
    assert load['value']['statuses'] == {'200': responses}
    names = {}
    for sample in [data['processesBeforeTrace'], load['before'], *load['samples'], load['after'], data['finalProcessSample']]:
        names.update({int(owner): name for owner, name in sample['pids']})
    pids = set(names)
    assert data['nativePid'] in pids and not any(name.lower() == 'node.exe' for name in names.values())
    assert load['processesStarted'] == 0, 'Unexpected static worker lifecycle makes this comparison invalid'
    modules = collections.defaultdict(collections.Counter)
    for row in rows(folder / (label + '-profile.csv'), encoding):
        owner = pid(row[0]) if row else None
        if len(row) == 4 and owner in pids:
            modules[owner][row[3]] += integer(row[1])
    assert sum(modules[data['nativePid']].values()) > 0, 'Missing native CPU samples'
    headers, inside_header = {}, False
    counts, network, drops = collections.Counter(), collections.Counter(), collections.Counter()
    file_counts = collections.defaultdict(collections.Counter)
    read_bytes, threads = collections.Counter(), collections.defaultdict(set)
    read_sizes = collections.defaultdict(collections.Counter)
    event_rows = 0
    for row in rows(folder / (label + '-dumper.csv'), encoding):
        if not row:
            continue
        event = row[0]
        if event == 'BeginHeader':
            inside_header = True
            continue
        if event == 'EndHeader':
            inside_header = False
            continue
        if inside_header:
            headers[event] = row
            continue
        event_rows += 1
        header = headers.get(event)
        if not header or 'Process Name ( PID)' not in header:
            continue
        offset = header.index('Process Name ( PID)')
        if offset >= len(row):
            continue
        owner = pid(row[offset])
        if owner not in pids:
            continue
        if event == 'SampledProfile':
            threads[owner].add(integer(row[header.index('ThreadID')]))
        elif event.startswith('FileIo'):
            counts[event] += 1
            if 'FileName' in header:
                filename = row[header.index('FileName')]
                file_counts[filename][event] += 1
                if event == 'FileIoRead':
                    size = integer(row[header.index('Size')])
                    read_bytes[filename] += size
                    read_sizes[filename][size] += 1
        elif event.startswith(('Microsoft-Windows-TCPIP/', 'Microsoft-Windows-Networking-Correlation/')):
            network[event] += 1
            if 'TcpipTransportPacketDrops' in event:
                drops[row[header.index('Reason')]] += integer(row[header.index('PacketCount')])
    trace = (folder / (label + '-tracestats.csv')).read_text(encoding=encoding)
    losses = {}
    for kind in ('Buffers', 'Events'):
        found = re.search(r'Total # Lost ' + kind + r'\s*:\s*(\d+)', trace)
        assert found, (label, 'missing trace loss accounting', kind)
        losses[kind] = int(found[1])
    physical = []
    prefixes = [normalized(data[key]).rstrip('\\') + '\\' for key in ('build', 'public')]
    for row in rows(folder / (label + '-diskio.csv'), encoding):
        if len(row) == 11 and any(normalized(row[-1]).startswith(prefix) for prefix in prefixes):
            physical.append({'file': row[-1], 'operations': integer(row[0]), 'bytes': integer(row[1]),
                             'readOperations': integer(row[3]), 'readBytes': integer(row[4])})
    total_weight = sum(sum(values.values()) for values in modules.values())
    processes = []
    for owner, values in modules.items():
        weight = sum(values.values())
        if not weight:
            continue
        processes.append({'pid': owner, 'name': names[owner], 'sampleWeight': weight,
                          'serverSamplePercent': 100 * weight / total_weight,
                          'sampledExecutingThreadCount': len(threads[owner]),
                          'modules': [{'module': name, 'sampleWeight': count, 'processSamplePercent': 100 * count / weight}
                                      for name, count in values.most_common()]})
    files = [{'file': name, 'events': dict(values),
              'eventsPerResponse': {event: count / responses for event, count in values.items()},
              'requestedReadBytes': read_bytes[name], 'requestedReadSizeCounts': dict(read_sizes[name])}
             for name, values in sorted(file_counts.items(), key=lambda item: sum(item[1].values()), reverse=True)]
    wire_file = [file for file in files if normalized(file['file']) == normalized(data['wireRepresentation'])]
    assert wire_file, label + ': precompressed control file is absent from FileIO events'
    inputs = {name: sha(folder / name) for name in sorted(required | {label + '.json', label + '.etl', 'plan.json', 'result.json'})}
    return {'label': label, 'instrumented': True, 'route': data['route'], 'connections': data['connections'],
            'startedAt': data['startedAt'], 'finishedAt': data['finishedAt'], 'serverCpu': data['serverCpu'],
            'generatorCpus': data['generatorCpus'], 'binarySha256': data['binarySha256'],
            'nativePid': data['nativePid'], 'serverPids': names, 'responses': responses, 'httpErrors': load['value']['errors'],
            'jobCpuMsPerResponse': load['cpuSeconds'] * 1000 / responses,
            'instrumentedRps': load['value']['rps'], 'instrumentedRssMiB': load['rssMedianMiB'],
            'traceStats': trace, 'lost': losses, 'attributionValid': not any(losses.values()),
            'processes': processes, 'fileIoEvents': dict(counts),
            'fileIoEventsPerResponse': {event: count / responses for event, count in counts.items()},
            'files': files, 'wireRepresentation': wire_file, 'wireBytes': data['wireBytes'], 'wireSha256': data['wireSha256'],
            'networkEventsInServerContext': dict(network), 'networkDroppedPacketsByRawReason': dict(drops),
            'physicalDiskForApplicationFilesAllProcesses': physical, 'parsedEventRows': event_rows,
            'inputsSha256': inputs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=pathlib.Path, default=DEFAULT_FOLDER)
    parser.add_argument('--csv-encoding', default='cp1252', help='WPT export on the recorded French Windows installation')
    args = parser.parse_args()
    out = args.folder / 'analysis.json'
    assert not out.exists(), 'Refusing to overwrite an existing analysis'
    capture = read(args.folder / 'result.json')
    assert capture.get('complete') is True and capture.get('labels') == ['v4', 'v5'], 'Incomplete trace pair'
    result = {'complete': False, 'generation': 'v5', 'instrumented': True, 'csvEncoding': args.csv_encoding,
              'analyzerSha256': sha(pathlib.Path(__file__)),
              'method': 'CPU.light + FileIO.light + Network.light, whole trace including load startup/drain; server PID context filtering. CPU sample weights are module proportions, not source attribution. FileIoRead size is requested bytes, not physical-disk or wire bytes.',
              'traces': []}
    for label in capture['labels']:
        value = analyse(args.folder, label, args.csv_encoding)
        result['traces'].append(value)
        print(label, value['parsedEventRows'], 'event rows; lost', value['lost'], flush=True)
    assert len({trace['wireSha256'] for trace in result['traces']}) == 1, 'Wire representation changed between traces'
    result['complete'] = True
    result['lossless'] = all(trace['attributionValid'] for trace in result['traces'])
    result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with out.open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2, ensure_ascii=False)


if __name__ == '__main__':
    main()
