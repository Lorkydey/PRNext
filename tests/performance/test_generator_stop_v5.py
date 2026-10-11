"""Synthetic Windows-friendly observer stop; no polling sleep or CPU load."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('generator_stop_test', pathlib.Path(__file__).with_name('generator-cpu-v5.py'))
observer = importlib.util.module_from_spec(spec); spec.loader.exec_module(observer)


class StopFileTests(unittest.TestCase):
    def test_stop_is_optional_and_existing_marker_is_rejected_without_deletion(self):
        self.assertIsNone(observer.requested_stop_file(None))
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'stop'; file.write_text('keep me')
            with self.assertRaisesRegex(FileExistsError, 'already exists'): observer.requested_stop_file(str(file))
            self.assertEqual(file.read_text(), 'keep me')

    def test_marker_writes_clean_interrupted_stop_and_preserves_last_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'stop'; output = pathlib.Path(directory) / 'cpu.jsonl'
            clock = [0]
            class Event:
                stopped = False
                def set(self): self.stopped = True
                def is_set(self): return self.stopped
                def wait(self, seconds):
                    clock[0] += seconds
                    marker.write_text('requested')
                    return False
            process = types.SimpleNamespace(pid=123, cpu_affinity=lambda: [4, 5])
            psutil = types.SimpleNamespace(__version__='synthetic', Process=lambda: process, cpu_percent=lambda **_: [1] * 10)
            args = types.SimpleNamespace(stop_file=str(marker), cpus=[8,9], observer_cpus=None,
                                         interval=1, seconds=7200, output=str(output))
            with mock.patch.dict(sys.modules, psutil=psutil), \
                 mock.patch.object(observer.threading, 'Event', Event), \
                 mock.patch.object(observer.signal, 'signal'), \
                 mock.patch.object(observer.time, 'time', lambda: 100 + clock[0]), \
                 mock.patch.object(observer.time, 'perf_counter', lambda: clock[0]):
                observer.collect(args)
            rows = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(rows[0]['requestedStopFile'], str(marker.resolve()))
            self.assertEqual([row['event'] for row in rows], ['start', 'sample', 'stop'])
            self.assertTrue(rows[-1]['interrupted']); self.assertFalse(rows[-1]['complete'])
            self.assertGreater(rows[1]['endUnixMs'], rows[1]['beginUnixMs'])
            self.assertEqual(marker.read_text(), 'requested')


if __name__ == '__main__': unittest.main()
