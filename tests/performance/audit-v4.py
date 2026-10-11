"""Strict completion/provenance/link audit; prepared tests are never counted."""
import hashlib,json,pathlib,sys,html.parser,urllib.parse,datetime
ROOT=pathlib.Path(__file__).resolve().parents[2];BASE=ROOT/'artifacts/performance-v4'
def read(file):return json.loads(file.read_text(encoding='utf-8-sig'))
def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
errors=[];checks=[]
def require(value,message):
    (checks if value else errors).append(message)
candidate=read(BASE/'candidate.json');reference=read(BASE/'reference-v3/reference.json');summary=read(BASE/'summary.json')
require(sha(BASE/'prnext-v4.exe')==candidate['binarySha256'],'final native hash')
require(sha(BASE/'reference-v3/prnext-final.exe')==reference['binarySha256'],'reference native hash')
require(sha(ROOT/'artifacts/performance/node24/node.exe')==candidate['nodeSha256'],'pinned Node executable')
require(read(ROOT/'artifacts/performance/app/node_modules/next/package.json')['version']=='16.3.5','pinned Next fixture')
old_audit=read(BASE/'reference-v3/report-audit.json')
for name,field in [('report.html','reportSha256'),('summary.json','summarySha256'),('validation-final.json','validationFinalSha256')]:
    require(sha(BASE/'reference-v3'/name)==old_audit[field],'original v3 proof '+name)
evidence=read(BASE/'reference-v3/implementation-evidence.json')
for name,files in evidence['snapshots'].items():
    folder=ROOT/'artifacts/performance/app'/name
    for relative,size,digest in files:
        file=folder/relative
        require(file.exists() and file.stat().st_size==size and sha(file)==digest,'original application build '+name+'/'+relative)
for name,expected in reference['sourceSha256'].items():
    require(sha(BASE/'reference-v3/source'/name)==expected,'frozen v3 source '+name)
for name,expected in candidate['sourceSha256'].items():
    require((ROOT/name).is_file() and sha(ROOT/name)==expected,'candidate source '+name)
for field,folder in [('dynamicBuild',ROOT/'artifacts/performance/app/.prnext-v4-final'),('staticBuild',BASE/'static-app/.prnext-static')]:
    actual={f.relative_to(folder).as_posix():sha(f) for f in folder.rglob('*') if f.is_file()}
    require(actual==candidate[field],field+' exact bytes')
perf=summary['performance'];require(len(perf)==37,'37 final comparison groups')
for row in perf:
    require(row['runs']==(6 if row['kind']=='multi' else 3),'repetitions '+str((row['kind'],row['route'],row['connections'],row['version'],row['profile'])))
    require(row['errors']==0,'HTTP errors '+str((row['kind'],row['route'],row['version'],row['profile'])))
require(len(summary['multiPairs'])==6,'six simultaneous pairs')
require(len(summary['idle'])==18 and all(r['firstMs']['n']==3 for r in summary['idle']),'three 1/5/15 minute idle cycles for all profiles/versions')
require(len(summary['startupIdle'])==6,'six zero-traffic startups')
require(len(summary['wake'])==18 and all(r['firstMs']['n']==3 for r in summary['wake']),'54 deadline wake probes')
require(len(summary['staticIdle'])==2 and all(r['runs']==3 for r in summary['staticIdle']),'three static idle cycles per version')
require(len(summary['dynamicCaps'])==4 and all(r['runs']==3 and r['errors']==0 for r in summary['dynamicCaps']),'same-binary SSR ceiling control, four ceilings and three rounds')
require(len(summary['inputs'])==57 and all(r['state']=='complet' for r in summary['inputs']),'all 57 input campaigns complete with expected hashes')
require(all(r['state']=='réussi' and r['remainingProcesses']==0 for r in summary['tests']),'eight final suites and no remaining test descendants')
soak=read(BASE/'soak/result.json');require(soak.get('complete') is True,'final soak complete')
require(soak['mixedLoadSha256']==sha(ROOT/'tests/performance/mixed-load.mjs'),'corrected mixed generator hash')
if 'load' in soak:
    value=soak['load']['value']
    require(value['durationSeconds']>=3600 and value['elapsedSeconds']>=3600,'actual one-hour mixed load')
    require(value['errors']==value['validationErrors']==value['exitCode']==0,'soak errors and cookie/per-route freshness')
    require(value['plannedDisconnects']==value['cancelStarts'] and value['plannedDisconnects']>=1888,'all planned cancellation clients completed')
require(summary['soak']['state']=='complet','soak included only when complete')
resume=soak['resume']['value'];require(resume['status']==200 and resume['freshness'] and resume['isolation'],'fresh isolated successful response after the hour and 310 second rest')
require(not any(p['name']=='node.exe' for p in soak['idleAfter']['after']['processDetail']),'Node retired after endurance idle')
require(all(summary['soak']['idleMetricsLast']['workers'][key]==0 for key in ['activeJobs','queuedJobs','activityProtectedHosts']),'all sampled idle gauges returned to zero before wake')
etw=read(BASE/'etw/analysis.json')
require(etw['complete'] and etw['lossless'] and len(etw['traces'])==4,'four complete ETW diagnoses without lost events')
for trace in etw['traces']:
    require(trace['httpErrors']==0,'diagnostic HTTP errors '+trace['label'])
    for name,digest in trace['inputsSha256'].items():require(sha(BASE/'etw'/name)==digest,'trace input '+name)
visual=read(BASE/'report-qa/result.json')
require(visual['complete'] and not visual['pageErrors'] and visual['reportSha256']==sha(ROOT/'artifacts/performance/report.html'),'desktop/mobile rendering of the exact delivered report')
require(visual['mobileWidths']['document']<=visual['mobileWidths']['viewport'],'no mobile page overflow')
cleanup=read(BASE/'cleanup.json');require(cleanup['complete'] and not cleanup['remainingBenchmarkProcesses'],'no remaining scoped benchmark process or WPR recording')
harness=read(BASE/'tests/harness-final.json');require(harness['complete'] and all(r['exitCode']==0 for r in harness['results']),'final cross-platform harness and stale-response regression tests')
for name,digest in harness['sourceSha256'].items():require(sha(ROOT/name)==digest,'final checked helper '+name)
require(read(BASE/'preflight/result.json').get('complete') is True,'old-artifact rejection, stream and cancellation preflight')
controls=read(BASE/'static-controls/result.json');require(controls.get('complete') is True and len(controls['controls'])==6,'both binaries pass three wire-byte controls')
for row in controls['controls']:require(row['exitCode']==0,'wire control '+row['variant']+' '+row['validationCommand'][-1])
functional=list((BASE/'functional-final').glob('*.json'));require(len(functional)==7,'all seven configurations rechecked for same-user repeated freshness')
for file in functional:
    value=read(file);require(value.get('complete') is True,'functional '+file.stem)
    for row in value['checks']:
        require(row['exitCode']==0 and row['sha256']==sha(ROOT/'tests/performance'/row['script']),'functional script '+file.stem+' '+row['script'])
        if row['script']=='validate.mjs':require(json.loads(row['stdout'])['uniqueResponses']==288,'288 unique repeated responses '+file.stem)
class Links(html.parser.HTMLParser):
    def __init__(self):super().__init__();self.base=None;self.links=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='base':self.base=attrs.get('href')
        elif tag in ['a','img']:
            value=attrs.get('href' if tag=='a' else 'src')
            if value:self.links.append(value)
link_count=0
for file in [BASE/'report.html',ROOT/'artifacts/performance/report.html',BASE/'reference-v3-report.html']:
    text=file.read_text(encoding='utf-8');require('\ufffd' not in text and 'Ã©' not in text and 'â€™' not in text,'UTF-8 '+file.name)
    parser=Links();parser.feed(text);folder=file.parent/pathlib.Path(parser.base or '.')
    for link in parser.links:
        part=urllib.parse.urlsplit(link)
        if part.scheme or not part.path:continue
        path=folder/urllib.parse.unquote(part.path);link_count+=1
        require(path.exists(),'local link '+str(file.relative_to(ROOT))+' -> '+link)
result={'complete':not errors,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passedChecks':len(checks),'localLinks':link_count,'errors':errors,'candidateBinarySha256':candidate['binarySha256'],'candidateSourceTreeDigest':candidate['sourceTreeDigest'],'linuxExecuted':False}
(BASE/'report-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=True));sys.exit(bool(errors))
