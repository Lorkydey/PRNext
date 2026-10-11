"""Checked sampling for new V5 runners; the historical runner stays immutable."""
import json
import math
import statistics
import threading
import time


def measured(server, fn, raw=None, sample_interval=.5):
    """Retain cumulative Job CPU (including exited children), fail on lost samples.

    Only ``fn`` owns workload lifetime. A sampling failure invalidates the result
    once it finishes; it can never become a successful measurement with a partial
    RSS series. The caller still owns server shutdown in its outer finally block.
    """
    if not math.isfinite(sample_interval) or sample_interval <= 0:
        raise ValueError('sample_interval must be finite and positive')
    samples, errors = [], []
    stop = threading.Event()
    before = server.sample()

    def monitor():
        while not stop.wait(sample_interval):
            try:
                sample = server.sample()
                samples.append(sample)
                if raw is not None:
                    with open(raw, 'a', encoding='utf-8') as output:
                        output.write(json.dumps(sample) + '\n')
            except BaseException as error:
                errors.append(error)
                return

    thread = threading.Thread(target=monitor, name='prnext-v5-accounting')
    thread.start()
    start = time.perf_counter()
    try:
        value = fn()
    finally:
        stop.set()
        thread.join()
    if errors:
        raise RuntimeError('Resource sampling failed; measurement invalid: ' + str(errors[0])) from errors[0]
    elapsed = time.perf_counter() - start
    after = server.sample()
    samples.append(after)
    cpu = after['cpuSeconds'] - before['cpuSeconds']
    if not math.isfinite(cpu) or cpu < 0:
        raise RuntimeError('Invalid cumulative Job CPU accounting')
    return {'value': value, 'elapsedSeconds': elapsed, 'cpuSeconds': cpu,
            'cpuPercent': 100 * cpu / elapsed, 'rssMedianMiB': statistics.median(x['rssMiB'] for x in samples),
            'rssMaxMiB': max(x['rssMiB'] for x in samples),
            'processesStarted': after['totalProcesses'] - before['totalProcesses'],
            'before': before, 'after': after, 'samples': samples}
