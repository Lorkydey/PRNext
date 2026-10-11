import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('analyze_v6', pathlib.Path(__file__).with_name('analyze-v6.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class MeasurementAnalysis(unittest.TestCase):
    def sample(self, tick, busy=0):
        return dict(time=tick, cpuSeconds=tick, privateCommitMiB=10, rssMiB=20,
                    processes=2, threads=4, handles=7, pids=[[1, 'node.exe'], [2, 'prnext.exe']],
                    hostCpuTimes=[dict(user=busy, system=0, idle=tick-busy)], jobMemoryLimitEvents=0)

    def row(self):
        app = dict(index=0, connections=1, started=12, completed=11, useful=10, within=8,
                   rps=4, p50=1, p95=2, p99=3, maxLatencyMs=4,
                   errors=1, validationErrors=0, rejected=1, statuses={'200':10, '503':1})
        return dict(label='measure', before=self.sample(0), after=self.sample(2, .4), samples=[],
                    value=dict(apps=[app], generatorCpuPercent=20), elapsedSeconds=2,
                    cpuSeconds=1, cpuPercent=50, rssMedianMiB=20, rssMaxMiB=20, processesStarted=0)

    def test_errors_and_rejections_cannot_count_as_useful_capacity(self):
        row = a.phase(self.row(), ((0,),))
        self.assertEqual(row['useful'], 10)
        self.assertEqual(row['within'], 8)
        self.assertEqual(row['rps'], 4)
        self.assertEqual(row['cpuMsPerUseful'], 100)
        self.assertTrue(row['capacity']['capacityClaimEligible'])
        self.assertFalse(row['successfulCapacityClaimEligible'])
        self.assertEqual((row['errors'], row['rejected']), (1, 1))

    def test_background_cpu_and_generator_cpu_each_disqualify(self):
        row = self.row()
        row['after'] = self.sample(2, 1.9)
        self.assertFalse(a.capacity(row, ((0,),))['capacityClaimEligible'])
        row['after'] = self.sample(2, .4)
        row['value']['generatorCpuPercent'] = 90
        self.assertFalse(a.capacity(row, ((0,),))['capacityClaimEligible'])

    def test_request_and_response_error_events_do_not_double_failed_requests(self):
        row = self.row()
        row['value']['apps'][0]['errors'] = 2
        result = a.phase(row, ((0,),))
        self.assertEqual(result['errors'], 2)
        self.assertEqual(result['failedRequestsExcluding503'], 1)

    def test_multiple_generators_sum_counts_not_percentiles(self):
        row = self.row()
        row['value'] = [row['value'], row['value']]
        result = a.phase(row, ((0,),))
        self.assertEqual(result['rps'], 8)
        self.assertEqual(result['cpuMsPerUseful'], 50)
        self.assertEqual([x['generator'] for x in result['apps']], [0, 1])
        self.assertNotIn('p99', result)

    def test_spread_keeps_zero_failure_outcomes(self):
        self.assertEqual(a.spread([0, 10, None]), dict(median=5, min=0, max=10, n=2))


if __name__ == '__main__':
    a.os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
    if a.os.name == 'nt':
        a.sys.path.insert(0, str(a.ROOT/'artifacts/performance/python'))
        import psutil
        psutil.Process().cpu_affinity([0, 1])
    unittest.main()
