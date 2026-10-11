"""Diagnostic reproduction: saturate a seeded Pages JSON cache lookup."""
import importlib.util,json,pathlib,shutil,sys,time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('campaign',HERE/'campaign-v6.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.g.r.psutil.Process().cpu_affinity([0,1])
folder=c.OUT/(sys.argv[1] if len(sys.argv)>1 else 'pages-admission-probe');folder.mkdir();app=folder/'app';app.mkdir()
(app/'public').mkdir();(app/'public/robots.txt').write_text('ready')
shutil.copytree(c.OUT/'reference-v5/dynamicBuild',app/'.prnext')
manifest=app/'.prnext/manifest.json';data=json.loads(manifest.read_text())
data['pagesErrors']={}
data['routes'].append({'id':'test-seed','pattern':'/seed','kind':'page','module':'server/page-builtin-error-500.mjs','ssg':True,'fallback':False})
data['prerendered'].append({'routeId':'test-seed','path':'/seed','file':'static/test-seed.html','dataFile':'static/test-seed.json','status':200,'revalidate':False,'generatedAt':int(time.time()*1000),'headers':{'content-type':'text/html; charset=utf-8'}})
manifest.write_text(json.dumps(data),encoding='utf-8');(app/'.prnext/static/test-seed.html').write_text('<p>seed</p>');(app/'.prnext/static/test-seed.json').write_text('{"pageProps":{"seed":true},"__N_SSG":true}')
binary=c.OUT/'candidates'/(sys.argv[2] if len(sys.argv)>2 else 'final-fixed')/'prnext.exe';command=[str(binary),'start',str(app),'--node',str(c.NODE),'--port','33800']
server=c.g.Group([{'command':command,'cwd':str(app),'environment':{'PRNEXT_FILE_WORK_CONCURRENCY':'1','PRNEXT_FILE_QUEUE':'0'}}],folder/'server',6,512)
result={'complete':False,'startedAt':time.time(),'binarySha256':c.sha(binary),'command':command,'syntheticSeededManifest':True,'diagnosticNotThroughput':True}
try:
 c.ready(['http://127.0.0.1:33800']);url=f'http://127.0.0.1:33800/_prnext/data/{data["buildId"]}/seed.json'
 code="const url="+json.dumps(url)+"; const results=await Promise.all(Array.from({length:128},async()=>{const r=await fetch(url);await r.arrayBuffer();return [r.status,r.headers.get('retry-after'),r.headers.get('cache-control')]}));console.log(JSON.stringify(results));"
 script=folder/'client.mjs';script.write_text(code,encoding='utf-8')
 client=c.g.r.Server([str(c.NODE),str(script)],str(c.ROOT),str(folder/'client.json'),[0,1],production=False)
 try:result['exitCode']=client.process.wait(timeout=20)
 finally:client.close()
 replies=json.loads((folder/'client.json').read_text());result['replies']=replies;result['statuses']={str(s):sum(r[0]==s for r in replies) for s in sorted({r[0] for r in replies})};result['complete']=True
finally:
 server.close();result['finishedAt']=time.time();(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(result.get('statuses'))
