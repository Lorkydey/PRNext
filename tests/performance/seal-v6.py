"""Archive the final measurement/report tools and hash retained evidence.

Run only after audit and report QA. Never overwrites a snapshot or manifest.
Production, baseline and fixture files are covered by their immutable maps;
this manifest covers the raw runs, including unsuccessful earlier attempts.
"""
import datetime, hashlib, json, os, pathlib, re, shutil, sys

ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/performance-v6'

def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        while chunk:=source.read(1024*1024):digest.update(chunk)
    return digest.hexdigest()

def read(path):return json.loads(path.read_text(encoding='utf-8'))

def main():
    if os.name=='nt':
        sys.path.insert(0,str(ROOT/'artifacts/performance/python'))
        import psutil
        psutil.Process().cpu_affinity([0,1])
    assert read(OUT/'final-audit.json')['complete']
    qa_folder=sys.argv[1] if len(sys.argv)>1 else 'report-qa-final'
    assert re.fullmatch(r'report-qa(?:-[a-z0-9]+)*',qa_folder)
    qa=read(OUT/qa_folder/'result.json')
    assert qa['complete'] and qa['reportSha256']==sha(OUT/'report.html')
    assert read(OUT/'report-publication.json')['complete']
    destination=OUT/'harness-final';destination.mkdir()
    sources=[p for p in (ROOT/'tests/performance').rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    sources += [ROOT/p for p in ['README.md','packages/prnext/README.md','.github/workflows/performance-linux-v6.yml','tests/file-admission.test.mjs','tests/pages-io-admission.test.mjs']]
    copied={}
    for source in sorted(set(sources)):
        name=source.relative_to(ROOT).as_posix();target=destination/name
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
        assert sha(source)==sha(target);copied[name]=sha(target)
    for source in [OUT/'functional-http.py']:
        target=destination/source.name;shutil.copy2(source,target);copied['artifacts/performance-v6/'+source.name]=sha(target)
    (destination/'snapshot.json').write_text(json.dumps({'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':copied,'scope':'Final harness/docs snapshot; frozen candidate source and historical harness snapshots remain separate.'},indent=2),encoding='utf-8')
    excluded={'apps','static-app','reference-v5','candidates','harness','harness-final','pages-admission-probe','pages-admission-probe-2','pages-admission-probe-3','pages-admission-probe-final'}
    entries={}
    for directory,folders,files in os.walk(OUT):
        if pathlib.Path(directory)==OUT:folders[:]=[name for name in folders if name not in excluded]
        folders[:]=[name for name in folders if name not in {'__pycache__','node_modules'}]
        for name in sorted(files):
            path=pathlib.Path(directory)/name;rel=path.relative_to(OUT)
            if path.suffix.lower() not in {'.json','.jsonl','.log','.txt','.html','.diff','.sha256','.png','.py'}:continue
            entries[rel.as_posix()]={'bytes':path.stat().st_size,'sha256':sha(path)}
    # Retain diagnostic evidence, excluding copied application/dependency trees.
    for folder in OUT.glob('pages-admission-probe*'):
        for path in folder.rglob('*'):
            if not path.is_file() or 'app' in path.relative_to(folder).parts:continue
            if path.suffix.lower() not in {'.json','.jsonl','.log','.mjs'}:continue
            entries[path.relative_to(OUT).as_posix()]={'bytes':path.stat().st_size,'sha256':sha(path)}
    for name in ['reference-v5/reference.json','candidates/final-http/source.json','reference-v5-source.tar.gz','harness/snapshot.json','harness-final/snapshot.json','fileWorkAdmission']:
        path=OUT/name;entries[name]={'bytes':path.stat().st_size,'sha256':sha(path)}
    for pattern in ['*/source.json','*/rejected.json','*/prnext.exe']:
        for path in (OUT/'candidates').glob(pattern):
            entries[path.relative_to(OUT).as_posix()]={'bytes':path.stat().st_size,'sha256':sha(path)}
    active=ROOT/'artifacts/performance/report.html'
    record={'complete':True,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'candidate':read(OUT/'candidate-provenance-http.json')['binarySha256'],
            'files':entries,'activeReportSha256':sha(active),'v5ReportSha256':sha(ROOT/'artifacts/performance/report-v5-before-v6.html'),
            'harnessFiles':len(copied),'reportQa':qa_folder+'/result.json','linuxExecuted':False,'releasePublished':False,'deployed':False,
            'scope':'Includes raw successful/failed measurements and reports. Production sources, binaries and application fixtures are verified by final-audit.json and their source maps. This manifest excludes itself.'}
    with (OUT/'delivery-manifest.json').open('x',encoding='utf-8') as output:json.dump(record,output,indent=2)
    print(json.dumps({'manifest':'delivery-manifest.json','evidenceFiles':len(entries),'harnessFiles':len(copied)}))

if __name__=='__main__':main()
