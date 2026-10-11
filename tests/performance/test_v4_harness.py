"""Cross-platform harness checks; these do NOT execute Linux/cgroup workloads."""
import hashlib, importlib.util, io, json, pathlib, subprocess, sys, tarfile, tempfile, unittest
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('linux_runner',HERE/'linux-runner.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
report_spec=importlib.util.spec_from_file_location('report',HERE/'report-v4.py');report=importlib.util.module_from_spec(report_spec);report_spec.loader.exec_module(report)
class HarnessTests(unittest.TestCase):
    def test_multi_totals_only_include_complete_pairs_from_the_same_round(self):
        rows=[]
        for label,count,cpu,rps in [('multi-1-v3-0',100,1,10),('multi-1-v3-1',300,6,30),('multi-2-v3-0',999,999,999)]:
            value={'phase':'measure','cpuSeconds':cpu,'rssMedianMiB':8,'rustVirtualAllocatedMiB':100,'samples':[{'threads':4}],'value':{'count':count,'rps':rps,'generatorCpuPercent':20,'errors':0}}
            rows.append((report.BASE/(label+'.json'),{'label':label,'variant':'v3','results':[value]}))
        result=report.multi_summary(rows)
        self.assertEqual(len(result),1);self.assertEqual(result[0]['repeat'],1)
        self.assertEqual(result[0]['sumRps'],40);self.assertEqual(result[0]['cpuMsPerResponse'],17.5)
        self.assertEqual(result[0]['sumMedianRssMiB'],16)

    def test_reports_exclude_incomplete_or_mismatched_results_without_hiding_errors(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=pathlib.Path(temp);original=report.BASE;report.BASE=folder
            try:
                for name,complete,digest in [('valid',True,'expected'),('unfinished',False,'expected'),('wrong-binary',True,'wrong')]:
                    (folder/(name+'.json')).write_text(json.dumps({'variant':'candidate','complete':complete,'sha256':digest,'results':[{'value':{'errors':2 if not complete else 0}}]}))
                (folder/'truncated.json').write_text('{')
                statuses=[];accepted=report.load_campaigns(folder,{'candidate':'expected'},statuses)
                self.assertEqual([file.stem for file,_ in accepted],['valid']);self.assertEqual(len(statuses),4)
                self.assertEqual(next(row['errors'] for row in statuses if row['file']=='unfinished.json'),2)
            finally:report.BASE=original
    def test_accounting_fields_keep_cumulative_cpu_and_memory_events(self):
        self.assertEqual(runner.fields('usage_usec 1200000\nuser_usec 900000\nsystem_usec 300000\nnr_throttled 2\n'),{'usage_usec':1200000,'user_usec':900000,'system_usec':300000,'nr_throttled':2})
        self.assertEqual(runner.fields('Name:\tnode\nVmRSS:\t2048 kB\nThreads:\t17\n'),{'VmRSS':2048,'Threads':17})
    def archive(self,entries):
        temp=tempfile.TemporaryDirectory();folder=pathlib.Path(temp.name);archive=folder/'reference.tar.gz'
        with tarfile.open(archive,'w:gz') as output:
            for name,data,kind in entries:
                member=tarfile.TarInfo(name);member.type=kind
                if kind==tarfile.REGTYPE:member.size=len(data);output.addfile(member,io.BytesIO(data))
                else:member.linkname='../outside';output.addfile(member)
        return temp,folder,archive
    def unpack(self,archive,destination,digest=None):
        return subprocess.run([sys.executable,str(HERE/'unpack-reference.py'),str(archive),digest or hashlib.sha256(archive.read_bytes()).hexdigest(),str(destination)],capture_output=True,text=True)
    def test_real_archive_roundtrip_and_hash_failure(self):
        temp,folder,archive=self.archive([('reference.json',b'{}',tarfile.REGTYPE),('source/Cargo.lock',b'pinned',tarfile.REGTYPE)])
        with temp:
            self.assertNotEqual(self.unpack(archive,folder/'bad','0'*64).returncode,0);self.assertFalse((folder/'bad').exists())
            done=self.unpack(archive,folder/'good');self.assertEqual(done.returncode,0,done.stderr);self.assertEqual((folder/'good/source/Cargo.lock').read_bytes(),b'pinned')
            self.assertNotEqual(self.unpack(archive,folder/'good').returncode,0)
    def test_traversal_symlinks_and_unexpected_roots_are_rejected(self):
        for name,kind in [('source/../../outside',tarfile.REGTYPE),('/tmp/outside',tarfile.REGTYPE),('source/link',tarfile.SYMTYPE),('other/file',tarfile.REGTYPE)]:
            with self.subTest(name=name):
                temp,folder,archive=self.archive([(name,b'x',kind)])
                with temp:
                    self.assertNotEqual(self.unpack(archive,folder/'out').returncode,0);self.assertFalse((folder/'out').exists())
if __name__=='__main__':unittest.main()
