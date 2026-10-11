"""Endurance runner failures simulated without starting a server or generator."""
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('sustain_test',pathlib.Path(__file__).with_name('sustain-v5.py'))
sustain=importlib.util.module_from_spec(spec);spec.loader.exec_module(sustain)


def value(seconds=3600):
    return {'type':'final','durationSeconds':seconds,'exitCode':0,'errors':0,'validationErrors':0,
            'count':10,'started':10,'completedWithinWindow':9,'rps':9/seconds,'statuses':{'200':10},
            'plannedDisconnects':32,'cancelStarts':32,'cancellationStatuses':{'200':32}}


class ConsistencyTests(unittest.TestCase):
    def test_drained_load_and_warmup_without_storm_are_valid(self):
        sustain.validate_mixed(value(),3600)
        warm=value(30);warm.update(plannedDisconnects=0,cancelStarts=0,cancellationStatuses={})
        sustain.validate_mixed(warm,30)

    def test_inconsistent_counters_statuses_and_errors_are_rejected(self):
        for key,bad in [('type','interval'),('durationSeconds',30),('exitCode',1),('errors',1),('validationErrors',1),
                        ('count',0),('started',11),('statuses',{'200':9,'500':1}),('completedWithinWindow',11),
                        ('rps',1),('plannedDisconnects',31),('cancelStarts',33),('cancellationStatuses',{'200':31,'500':1})]:
            with self.subTest(key=key):
                changed=value();changed[key]=bad
                with self.assertRaises(AssertionError):sustain.validate_mixed(changed,3600)

    def test_cleanup_attempts_close_after_sample_failure_and_names_both_errors(self):
        closed=[]
        def fail_sample():raise RuntimeError('sampling broke')
        def fail_close():closed.append(True);raise OSError('closing broke')
        result={'complete':True,'error':{'type':'ValueError','message':'earlier workload failure'}}
        errors=sustain.cleanup(types.SimpleNamespace(sample=fail_sample,close=fail_close),result)
        self.assertEqual(len(errors),2);self.assertEqual(closed,[True]);self.assertFalse(result['complete'])
        self.assertEqual([error['stage'] for error in result['cleanupErrors']],['finalSample','serverClose'])
        self.assertEqual(result['error']['message'],'earlier workload failure')


class MainTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=pathlib.Path(self.temp.name);out=root/'evidence';app=root/'app';node=root/'node.exe'
        files=[out/'prnext-v5.exe',node,app/'.prnext-v5-final/manifest.json']
        files += [root/'tests/performance'/name for name in ['load.mjs','mixed-load.mjs','sustain-v5.py','measurement-v5.py','windows-runner.py','static-probe.py']]
        for file in files:file.parent.mkdir(parents=True,exist_ok=True);file.write_text('fixture')
        self.out=out;self.closed=[]
        outer=self
        class Server:
            process=types.SimpleNamespace(poll=lambda:None)
            def __init__(self,*args,**kwargs):pass
            def sample(self):return {'time':1,'cpuSeconds':0,'rssMiB':1,'totalProcesses':1}
            def close(self):outer.closed.append(True)
        runtime=types.SimpleNamespace(Server=Server,get=lambda _:None)
        for target,name,item in [(sustain,'ROOT',root),(sustain,'OUT',out),(sustain,'APP',app),(sustain,'NODE',node),
                                 (sustain,'r',runtime),(sys,'argv',['sustain-v5.py','soak','--cpu','10','--port','32900']),
                                 (sustain.subprocess,'check_output',lambda *_a,**_k:'v24.19.0\n')]:
            patch=mock.patch.object(target,name,item);patch.start();self.addCleanup(patch.stop)

    def result(self):return json.loads((self.out/'soak/result.json').read_text())

    def test_constructor_failure_is_recorded_without_attempting_to_close_absent_server(self):
        with mock.patch.object(sustain.r,'Server',side_effect=OSError('cannot start native server')):
            with self.assertRaisesRegex(OSError,'cannot start'):sustain.main()
        result=self.result();self.assertFalse(result['complete']);self.assertEqual(result['error']['type'],'OSError')
        self.assertIn('cannot start',result['error']['message']);self.assertIn('finishedAt',result)
        self.assertEqual(self.closed,[])

    def test_invalid_hour_record_is_saved_and_prevents_idle_phase(self):
        warm=value(30);broken=value();broken['cancelStarts']=33
        rows=[{'value':item,'cpuSeconds':1} for item in [warm,broken]]
        with mock.patch.object(sustain.measurement,'measured',side_effect=rows) as measured:
            with self.assertRaisesRegex(AssertionError,'cancellations were not fully drained'):sustain.main()
        result=self.result();self.assertFalse(result['complete']);self.assertEqual(measured.call_count,2)
        self.assertEqual([row['label'] for row in result['results']],['warmup','mixed-one-hour'])
        self.assertEqual(result['results'][-1]['value']['cancelStarts'],33);self.assertEqual(self.closed,[True])

    def test_startup_error_is_not_masked_by_cleanup_failures(self):
        class Server:
            def __init__(self,*args,**kwargs):pass
            def sample(self):raise ValueError('sample failure')
            def close(self):raise OSError('close failure')
        with mock.patch.object(sustain.r,'Server',Server):
            with self.assertRaisesRegex(ValueError,'sample failure'):sustain.main()
        result=self.result();self.assertEqual(result['error']['type'],'ValueError')
        self.assertEqual([row['stage'] for row in result['cleanupErrors']],['finalSample','serverClose'])
        self.assertFalse(result['complete']);self.assertIn('finishedAt',result)


if __name__=='__main__':unittest.main()
