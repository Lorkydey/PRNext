"""Update the local IDE report while preserving exact V5 bytes and link targets."""
import datetime, hashlib, html, json, pathlib, re
from urllib.parse import unquote, urlsplit

ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/performance-v6'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    assert json.loads((OUT/'final-audit.json').read_text())['complete']
    source=OUT/'report.html';target=ROOT/'artifacts/performance/report.html'
    previous=target.with_name('report-v5-before-v6.html')
    expected=json.loads((ROOT/'artifacts/performance-v5/local-report-publication.json').read_text())['targetSha256']
    publication=OUT/'report-publication.json'
    old=json.loads(publication.read_text()) if publication.exists() else None
    if old:
        assert sha(target)==old['targetSha256'],'Active report changed outside this publisher'
        assert sha(previous)==expected
    else:
        assert sha(target)==expected,'Active V5 report changed; inspect before replacing it'
        assert not previous.exists()
    text=source.read_text(encoding='utf-8');links=[];anchors=set(re.findall(r'\bid="([^"]+)"',text))
    def rewrite(match):
        raw=match.group(1);href=html.unescape(raw);url=urlsplit(href)
        if href.startswith('#'):
            assert unquote(url.fragment) in anchors,href
            return match.group(0)
        if url.scheme or url.netloc:return match.group(0)
        original=(source.parent/unquote(url.path)).resolve()
        # The preserved V5 report is about to be created in the same operation.
        assert original.is_file() or original==previous.resolve(),str(original)
        new='../performance-v6/'+href
        resolved=(target.parent/unquote(urlsplit(new).path)).resolve()
        assert resolved==original,(href,new)
        links.append({'original':href,'active':new,'target':str(resolved)})
        return 'href="'+html.escape(new,quote=True)+'"'
    rewritten=re.sub(r'href="([^"]+)"',rewrite,text)
    if not previous.exists():
        with previous.open('xb') as output:output.write(target.read_bytes())
    assert sha(previous)==expected
    if old:
        revision=OUT/f'report-publication-revision-{len(list(OUT.glob("report-publication-revision-*.json")))+1}.json'
        with revision.open('x',encoding='utf-8') as output:json.dump(old,output,indent=2)
    target.write_text(rewritten,encoding='utf-8')
    record={'complete':True,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope':'Local IDE HTML only; no release or deployment','sourceSha256':sha(source),'targetSha256':sha(target),
            'preservedV5Sha256':sha(previous),'rewrittenLinks':len(links),'links':links,'scriptSha256':sha(pathlib.Path(__file__))}
    if old:record['supersedes']=revision.name
    with publication.open('w' if old else 'x',encoding='utf-8') as output:json.dump(record,output,indent=2)
    print(json.dumps({'complete':True,'links':len(links),'targetSha256':record['targetSha256']}))

if __name__=='__main__':main()
