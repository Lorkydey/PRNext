"""Record exact candidate inputs and package the immutable v3 Linux baseline."""
import datetime, hashlib, json, pathlib, subprocess, tarfile
root=pathlib.Path(__file__).resolve().parents[2];out=root/'artifacts/performance-v4'
def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def tree(folder):return {file.relative_to(folder).as_posix():sha(file) for file in sorted(folder.rglob('*')) if file.is_file()}
def main():
    files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
    sources={name:sha(root/name) for name in sorted(set(files)) if name and (root/name).is_file()}
    compiled={name:value for name,value in sources.items() if name.startswith('crates/') or name in ['Cargo.toml','Cargo.lock']}
    source_digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    node=root/'artifacts/performance/node24/node.exe';binary=out/'prnext-v4.exe'
    result={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'sourceSha256':sources,'sourceTreeDigest':source_digest(sources),'compiledRustSourceDigest':source_digest(compiled),'binarySha256':sha(binary),'nodeSha256':sha(node),'nodeVersion':subprocess.check_output([str(node),'--version'],text=True).strip(),'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'dynamicBuild':tree(root/'artifacts/performance/app/.prnext-v4-final'),'staticBuild':tree(out/'static-app/.prnext-static')}
    previous_file=out/'candidate.json'
    if previous_file.exists():
        previous=json.loads(previous_file.read_text())
        if previous['binarySha256']==result['binarySha256'] and previous['compiledRustSourceDigest']!=result['compiledRustSourceDigest']:
            raise RuntimeError('Rust sources changed under the frozen binary: rebuild and rerun verification before updating provenance')
    reference=out/'reference-v3';metadata=json.loads((reference/'reference.json').read_text())
    for name,expected in metadata['sourceSha256'].items():
        if sha(reference/'source'/name)!=expected:raise RuntimeError('Immutable v3 source changed: '+name)
    changes=[{'file':name,'before':metadata['sourceSha256'].get(name),'after':value} for name,value in sources.items() if metadata['sourceSha256'].get(name)!=value]
    changes.extend({'file':name,'before':value,'after':None} for name,value in metadata['sourceSha256'].items() if name not in sources)
    (out/'changes-from-v3.json').write_text(json.dumps(changes,indent=2))
    (out/'candidate.json').write_text(json.dumps(result,indent=2))
    archive=out/'reference-v3-source.tar.gz'
    if not archive.exists():
        with tarfile.open(archive,'w:gz') as target:
            target.add(reference/'reference.json',arcname='reference.json')
            for name,expected in metadata['sourceSha256'].items():
                file=reference/'source'/name
                assert sha(file)==expected,name
                target.add(file,arcname='source/'+name)
    (out/'reference-v3-source.sha256').write_text(sha(archive)+'  '+archive.name+'\n')
    print(json.dumps({'binary':result['binarySha256'],'rustSource':result['compiledRustSourceDigest'],'baselineArchive':sha(archive),'sourceFiles':len(sources)}))
if __name__=='__main__':main()
