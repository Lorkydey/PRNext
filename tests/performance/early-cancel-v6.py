"""HTTP cancellation while waiting for a file slot, before the admission deadline.
Run after all performance campaigns, alongside no other load.
"""
import hashlib,importlib.util,json,pathlib,time,urllib.request
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
folder=c.OUT/'early-cancel-http';app=c.OUT/'static-app';binary=c.OUT/'candidates/final-http/prnext.exe'
env={'PRNEXT_FILE_CONCURRENCY':'1','PRNEXT_FILE_QUEUE':'16','PRNEXT_FILE_WAIT_MS':'5000','PRNEXT_METRICS_FILE':str(folder/'metrics.jsonl')}
command=[str(binary),'start',str(app),'--build-dir','.prnext-static','--node',str(c.NODE),'--port','33780']
server=c.g.Group([{'command':command,'cwd':str(app),'environment':env}],folder,10,512)
result={'complete':False,'command':command,'environment':env,'binarySha256':c.sha(binary)}
try:
 c.ready(['http://127.0.0.1:33780'])
 client=c.g.r.Server([str(c.NODE),str(HERE/'static-burst-v6.mjs'),'http://127.0.0.1:33780','32','200'],str(c.ROOT),str(folder/'client.json'),[8,9],production=False)
 try:assert client.process.wait(timeout=10)==0
 finally:client.close()
 result['client']=json.loads((folder/'client.json').read_text());assert result['client']['unexpectedErrors']==result['client']['invalid503']==0
 result['recovery']=c.g.r.get('http://127.0.0.1:33780/payload.txt');result['recovery'].pop('body');assert result['recovery']['status']==200
 digest=hashlib.sha256();size=0
 direct=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with direct.open('http://127.0.0.1:33780/large-v6.bin',timeout=10) as response:
  assert response.status==200
  while chunk:=response.read(256*1024):digest.update(chunk);size+=len(chunk)
 expected=app/'public/large-v6.bin'
 result['largeFile']={'receivedBytes':size,'sha256':digest.hexdigest(),'expectedSha256':c.sha(expected)}
 assert size==expected.stat().st_size and digest.hexdigest()==result['largeFile']['expectedSha256']
 time.sleep(2)
 rows=[json.loads(line) for line in (folder/'metrics.jsonl').read_text().splitlines()];last=rows[-1];gate=last['fileAdmission']
 assert gate['cancelledWaits']>0 and gate['active']==gate['waiting']==gate['waitingHeaderBytes']==0,gate
 assert gate['timedOut']==0,gate
 assert last['fileWorkAdmission']['active']==last['fileWorkAdmission']['waiting']==0
 result['metrics']=last;result['complete']=True
finally:
 server.close();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print('early cancellation',result['complete'])
