"""Read-only global CPU observation for concurrent V5 generators (no traffic).

Keep this observer running across every final experiment/idle/soak window. The
sum for logical processors 8/9 ranges from 0 to 200%; those SMT siblings are one
physical core, so this is deliberately not labelled physical-core utilization.
The predeclared conservative policy rejects a measurement when its time-weighted
p95 logical CPU sum exceeds 85%. All peaks remain visible separately.
"""
import argparse
import hashlib
import json
import math
import pathlib
import signal
import sys
import threading
import time


def window_utilization(rows, begin_ms, end_ms, cpus=(8, 9), threshold=85):
    """Join raw observer intervals to a wall-clock measurement without rounding.

    Missing or overlapping coverage invalidates this observation. A caller must
    retain an invalid/contaminated benchmark attempt and repeat it, not delete it.
    """
    if not all(math.isfinite(value) for value in [begin_ms, end_ms, threshold]) or end_ms <= begin_ms:
        raise ValueError('Invalid observation window')
    values, gaps, cursor = [], [], begin_ms
    peaks = {str(cpu): 0 for cpu in cpus}
    for row in sorted((row for row in rows if row.get('event') == 'sample'), key=lambda row: row['beginUnixMs']):
        begin, end = row['beginUnixMs'], row['endUnixMs']
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in [begin, end]) or end <= begin:
            raise ValueError('Invalid observer interval')
        if end <= begin_ms or begin >= end_ms:
            continue
        a, b = max(begin, begin_ms), min(end, end_ms)
        if a < cursor - .01:
            raise ValueError('Overlapping CPU observation intervals')
        if a > cursor:
            gaps.append(a - cursor)
        percents = [row['cpuPercent'].get(str(cpu)) for cpu in cpus]
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 100 for value in percents):
            raise ValueError('Invalid per-processor CPU percentage')
        total = sum(percents)
        if not math.isclose(row.get('logicalCpuSumPercent', float('nan')), total, abs_tol=1e-7):
            raise ValueError('CPU sum differs from raw per-processor values')
        for cpu, percent in zip(cpus, percents):
            peaks[str(cpu)] = max(peaks[str(cpu)], percent)
        values.append((total, b - a))
        cursor = b
    if cursor < end_ms:
        gaps.append(end_ms - cursor)
    covered = sum(weight for _, weight in values)
    duration = end_ms - begin_ms
    p95 = None
    if covered:
        accumulated = 0
        for value, weight in sorted(values):
            accumulated += weight
            if accumulated >= covered * .95:
                p95 = value
                break
    complete = bool(values) and covered >= duration - .01 and max(gaps, default=0) <= .01
    return {'beginUnixMs': begin_ms, 'endUnixMs': end_ms, 'cpus': list(cpus),
            'coveredSeconds': covered / 1000, 'windowSeconds': duration / 1000,
            'coverageFraction': covered / duration, 'maxGapSeconds': max(gaps, default=0) / 1000,
            'meanLogicalCpuSumPercent': sum(value * weight for value, weight in values) / covered if covered else None,
            'p95LogicalCpuSumPercent': p95, 'peakLogicalCpuSumPercent': max((value for value, _ in values), default=None),
            'perCpuPeakPercent': peaks, 'thresholdPercent': threshold,
            'completeCoverage': complete, 'contaminated': p95 is not None and p95 > threshold,
            'valid': complete and p95 is not None and p95 <= threshold,
            'policy': 'time-weighted p95 of summed logical CPU percentages must be <=85; all peaks remain reported'}


def read_observation(file):
    rows = [json.loads(line) for line in pathlib.Path(file).read_text(encoding='utf-8').splitlines()]
    if not rows or rows[0].get('event') != 'start':
        raise ValueError('CPU observer start record is missing')
    return rows


def requested_stop_file(name):
    if name is None:
        return None
    file = pathlib.Path(name).resolve()
    if file.exists():
        raise FileExistsError('Observer stop file already exists; choose a new path: ' + str(file))
    return file


def collect(args):
    stop_file = requested_stop_file(args.stop_file)
    root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'artifacts/performance/python'))
    import psutil
    if len(set(args.cpus)) != len(args.cpus) or not args.cpus:
        raise ValueError('Choose distinct generator processors')
    if args.observer_cpus:
        if set(args.observer_cpus) & set(args.cpus):
            raise ValueError('Observer affinity must exclude generator processors')
        psutil.Process().cpu_affinity(args.observer_cpus)
    if args.interval <= 0 or args.seconds <= 0:
        raise ValueError('Observation interval/duration must be positive')
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    initial = psutil.cpu_percent(interval=None, percpu=True)
    if any(cpu < 0 or cpu >= len(initial) for cpu in args.cpus):
        raise ValueError('Requested generator CPU does not exist')
    with output.open('x', encoding='utf-8') as stream:
        def write(record):
            stream.write(json.dumps(record, separators=(',', ':')) + '\n')
            stream.flush()
        write({'event': 'start', 'schema': 1, 'unixMs': time.time() * 1000,
               'cpus': args.cpus, 'observerAffinity': psutil.Process().cpu_affinity(),
               'pid': psutil.Process().pid, 'intervalSeconds': args.interval, 'requestedSeconds': args.seconds,
               'requestedStopFile': str(stop_file) if stop_file is not None else None,
               'pythonVersion': sys.version, 'psutilVersion': psutil.__version__,
               'observerSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
               'thresholdPercent': 85, 'policy': 'time-weighted p95 logical CPU sum >85 invalidates a measurement window',
               'scope': 'system-wide logical processor utilization, including concurrent generators and unrelated processes; two SMT sums are not physical-core utilization'})
        begin_unix = time.time() * 1000
        begin_clock = time.perf_counter()
        deadline = begin_clock + args.seconds
        complete = False
        try:
            while not stopped.is_set():
                if stop_file is not None and stop_file.exists():
                    stopped.set()
                    break
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    complete = True
                    break
                stopped.wait(min(args.interval, remaining))
                if stop_file is not None and stop_file.exists():
                    stopped.set()
                end_clock = time.perf_counter()
                percents = psutil.cpu_percent(interval=None, percpu=True)
                end_unix = time.time() * 1000
                if end_unix <= begin_unix:
                    raise RuntimeError('Wall clock regressed; observer windows are invalid')
                selected = {str(cpu): percents[cpu] for cpu in args.cpus}
                write({'event': 'sample', 'beginUnixMs': begin_unix, 'endUnixMs': end_unix,
                       'elapsedSeconds': end_clock - begin_clock, 'cpuPercent': selected,
                       'logicalCpuSumPercent': sum(selected.values())})
                begin_unix, begin_clock = end_unix, end_clock
            if time.perf_counter() >= deadline:
                complete = True
        except BaseException as error:
            write({'event': 'error', 'unixMs': time.time() * 1000, 'type': type(error).__name__, 'message': str(error)})
            raise
        finally:
            write({'event': 'stop', 'unixMs': time.time() * 1000, 'complete': complete, 'interrupted': stopped.is_set()})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seconds', type=float, default=4500)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--cpus', type=int, nargs='+', default=[8, 9])
    parser.add_argument('--observer-cpus', type=int, nargs='+')
    parser.add_argument('--stop-file', help='New path polled each interval; creating it requests a clean stop without deleting it')
    args = parser.parse_args()
    collect(args)


if __name__ == '__main__':
    main()
