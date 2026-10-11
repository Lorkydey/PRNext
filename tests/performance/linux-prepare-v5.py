"""Prepare Linux v5 artifacts against the exact, immutable v4 source snapshot.
A Git revision alone is NOT the v4 baseline. Preparation is not test evidence.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parents[1]
def sha(file):return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()

def verify_baseline(baseline, *, allow_generated=False):
    baseline = pathlib.Path(baseline).resolve()
    reference = json.loads((baseline.parent/'reference.json').read_text(encoding='utf-8'))
    if reference.get('baseline') != 'final-v4':
        raise RuntimeError('Expected reference.json for the frozen final-v4 snapshot')
    hashes = reference.get('sourceSha256', {})
    required = {'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json',
                'packages/prnext/cli.mjs', 'crates/prnext/src/main.rs'}
    if not required.issubset(hashes):
        raise RuntimeError('Expected a full v4 source snapshot, not only runtime files')
    digest = hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if digest != reference.get('sourceTreeDigest'):
        raise RuntimeError('Immutable v4 source-tree digest mismatch')
    for name, expected in hashes.items():
        relative = pathlib.PurePosixPath(name)
        if not name or '\\' in name or relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Unsafe source path in v4 reference: '+name)
        file = baseline / relative
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(baseline) or sha(file) != expected:
            raise RuntimeError('Immutable v4 snapshot mismatch: '+name)
    if not allow_generated:
        present = {file.relative_to(baseline).as_posix() for file in baseline.rglob('*') if file.is_file() or file.is_symlink()}
        if present != set(hashes):
            raise RuntimeError('Unrecorded or missing files in v4 source snapshot: '+repr(sorted(present ^ set(hashes))[:10]))
    return reference

def unpack_baseline(archive, expected, destination):
    archive, destination = pathlib.Path(archive).resolve(), pathlib.Path(destination).resolve()
    if not expected or len(expected) != 64 or any(c not in '0123456789abcdefABCDEF' for c in expected):
        raise RuntimeError('A 64-digit --baseline-sha256 is required with --baseline-archive')
    if sha(archive) != expected.lower(): raise RuntimeError('Immutable v4 archive hash mismatch')
    if destination.exists(): raise RuntimeError('Refusing to overwrite a prior v4 snapshot')
    with tarfile.open(archive, 'r:gz') as source:
        members, names = source.getmembers(), set()
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if (not name.parts or '\\' in member.name or name.is_absolute() or '..' in name.parts
                    or not (member.isfile() or member.isdir()) or name.parts[0] not in ('reference.json', 'source')
                    or name.as_posix() in names or name.parts[0] == 'reference.json' and (len(name.parts) != 1 or not member.isfile())):
                raise RuntimeError('Unsafe v4 archive entry: '+member.name)
            names.add(name.as_posix())
        destination.mkdir(parents=True)
        source.extractall(destination, filter='data')
    verify_baseline(destination/'source')
    return destination/'source'

def verify_sources(root, hashes):
    for name, expected in hashes.items():
        if not (root/name).is_file() or sha(root/name) != expected:
            raise RuntimeError('Source changed during preparation: '+name)
def run(command,cwd,log,env=None):
    with open(log,'wb') as output:subprocess.run(command,cwd=cwd,stdout=output,stderr=subprocess.STDOUT,env={**os.environ,'NEXT_TELEMETRY_DISABLED':'1',**(env or {})},check=True)
def physical_cpus():
    found={}
    for cpu in sorted(os.sched_getaffinity(0)):
        topology=pathlib.Path('/sys/devices/system/cpu')/f'cpu{cpu}'/'topology'
        key=((topology/'physical_package_id').read_text().strip(),(topology/'core_id').read_text().strip())
        found.setdefault(key,cpu)
    if len(found)<5:raise RuntimeError('Full campaign needs five available physical cores: three for parallel idle profiles, two generators')
    return list(found.values())
def server_configs(out, app, node, cpus, nginx_executable, prefix, config):
    configs={}
    for name in ['v4','candidate']:
        for profile in ['balanced','memory','speed']:
            label=name+'-'+profile
            configs[label]={'label':label,'command':[str(out/('prnext-'+name)),'start',str(app),'--build-dir','.prnext-'+name,'--profile',profile,'--node',str(node),'--port','32300'],'cwd':str(app),'url':'http://127.0.0.1:32300','node':str(node),'cpu':cpus[0],'generatorCpus':cpus[1:3],'memoryBytes':2*1024**3}
    configs['next']={**configs['v4-balanced'],'label':'next','command':[str(node),str(app/'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p','32301'],'url':'http://127.0.0.1:32301'}
    configs['nginx']={**configs['v4-balanced'],'label':'nginx','command':[nginx_executable,'-p',str(prefix)+'/', '-c',str(config),'-g','daemon off;'],'url':'http://127.0.0.1:32302'}
    configs['nginx']['generatorCpus']=cpus[1:5]
    configs['candidate-v4-build']={**configs['candidate-balanced'],'label':'candidate-v4-build','command':list(configs['candidate-balanced']['command'])}
    configs['candidate-v4-build']['command'][configs['candidate-v4-build']['command'].index('--build-dir')+1]='.prnext-v4'
    # Static comparisons use identical candidate bytes for BOTH native binaries.
    for name in ['v4','candidate']:
        cfg=dict(configs[name+'-balanced']);cfg['label']=name+'-static';cfg['command']=list(cfg['command']);cfg['command'][cfg['command'].index('--build-dir')+1]='.prnext-candidate';cfg['generatorCpus']=cpus[1:5];configs[name+'-static']=cfg
    return configs

def main():
    p=argparse.ArgumentParser()
    baseline_group=p.add_mutually_exclusive_group(required=True)
    baseline_group.add_argument('--baseline-source', help='Full frozen source/ with sibling reference.json')
    baseline_group.add_argument('--baseline-archive', help='Local reference-v4-source.tar.gz; never downloaded implicitly')
    p.add_argument('--baseline-sha256');p.add_argument('--output',default=str(ROOT/'artifacts/performance-linux-v5'));args=p.parse_args()
    if sys.platform!='linux':raise SystemExit('Prepared for Linux only; not an emulation of Linux on Windows')
    if sys.version_info[:2] != (3,12): raise RuntimeError('Python 3.12 required; patch version is recorded')
    if args.baseline_source and args.baseline_sha256: p.error('--baseline-sha256 applies only to --baseline-archive')
    out=pathlib.Path(args.output).resolve()
    if out.exists():raise RuntimeError('Choose a new output directory to preserve earlier evidence')
    node_command=shutil.which('node')
    if not node_command: raise RuntimeError('Node 24.19.0 must already be installed')
    node=pathlib.Path(node_command).resolve()
    if subprocess.check_output([str(node),'--version'],text=True).strip()!='v24.19.0':raise RuntimeError('Node 24.19.0 required')
    if not subprocess.check_output(['rustc','--version'],text=True).startswith('rustc 1.98.0 '):raise RuntimeError('Rust 1.98.0 required')
    if subprocess.check_output(['npm','--version'],text=True).strip()!='11.12.1':raise RuntimeError('npm 11.12.1 required')
    cpus=physical_cpus()
    if args.baseline_source:
        baseline=pathlib.Path(args.baseline_source).resolve();reference=verify_baseline(baseline)
        out.mkdir(parents=True)
    else:
        baseline=unpack_baseline(args.baseline_archive,args.baseline_sha256,out/'reference-v4');reference=verify_baseline(baseline)
    logs=out/'build-logs';logs.mkdir()
    provenance={'generation':'v5','baseline':'final-v4','reference':reference,'node':subprocess.check_output([str(node),'--version'],text=True).strip(),'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'nginx':subprocess.run(['nginx','-V'],capture_output=True,text=True,check=True).stderr,'wrk':subprocess.run(['wrk','--version'],capture_output=True,text=True).stdout,'lscpu':subprocess.check_output(['lscpu'],text=True),'physicalCpus':cpus,'artifacts':{}}
    if args.baseline_archive: provenance['baselineArchive']={'path':str(pathlib.Path(args.baseline_archive).resolve()),'sha256':args.baseline_sha256.lower()}
    provenance['npm']=subprocess.check_output(['npm','--version'],text=True).strip();provenance['python']=sys.version
    provenance['kernel']=subprocess.check_output(['uname','-a'],text=True).strip();provenance['nodeSha256']=sha(node)
    provenance['candidateRevision']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    provenance['candidateGitStatus']=subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True)
    tracked=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    provenance['candidateSources']={name:sha(ROOT/name) for name in sorted(set(tracked)) if name and (ROOT/name).is_file()}
    (out/'preparation-start.json').write_text(json.dumps(provenance,indent=2))
    for name,source in [('v4',baseline),('candidate',ROOT)]:
        if not (source/'Cargo.lock').is_file():raise RuntimeError('Expected full v4/candidate source snapshot')
        run(['npm','ci'],source,logs/(name+'-npm-ci.log'))
        run(['cargo','build','--release','--locked','-p','prnext'],source,logs/(name+'-native.log'))
        binary=out/('prnext-'+name);shutil.copy2(source/'target/release/prnext',binary);provenance['artifacts'][name]={'binary':str(binary),'sha256':sha(binary),'cargoLock':sha(source/'Cargo.lock'),'npmLock':sha(source/'package-lock.json')}
    verify_baseline(baseline,allow_generated=True);verify_sources(ROOT,provenance['candidateSources'])
    app=out/'app';run([str(node),str(HERE/'fixture.mjs'),str(app)],ROOT,logs/'fixture.log')
    # Add the Pages static control to the SAME sources built by all compilers.
    (app/'pages/pages-static.jsx').write_text("export default function Page(){return <main><h1>Static reference</h1><table><tbody>{Array.from({length:100},(_,i)=><tr key={i}><td>{i}</td><td>{'row '+i}</td><td>{i*7}</td></tr>)}</tbody></table></main>}\n")
    shutil.copy2(HERE/'fixture-lock.json',app/'package-lock.json');run(['npm','ci'],app,logs/'fixture-npm-ci.log')
    for name,source in [('v4',baseline),('candidate',ROOT)]:
        run([str(node),str(source/'packages/prnext/cli.mjs'),'build',str(app)],source,logs/(name+'-app-build.log'))
        (app/'.prnext').rename(app/('.prnext-'+name))
    run([str(node),str(app/'node_modules/next/dist/bin/next'),'build'],app,logs/'next-build.log')
    # v4 and v5 share the runtime contract. Compatibility is exercised by the
    # candidate-v4-build functional run; old-v3 rejection stays in its own tests.
    provenance['next']=json.loads((app/'node_modules/next/package.json').read_text())['version']
    provenance['react']=json.loads((app/'node_modules/react/package.json').read_text())['version']
    if provenance['next']!='16.3.5':raise RuntimeError('Next 16.3.5 required')
    if provenance['react']!='19.3.0':raise RuntimeError('React 19.3.0 required')
    provenance['fixtureSources']={str(f.relative_to(app)):sha(f) for folder in ['app','pages','public'] for f in sorted((app/folder).rglob('*')) if f.is_file()}
    for name in ['v4','candidate']:
        dist=app/('.prnext-'+name);provenance['artifacts'][name]['buildFiles']={str(f.relative_to(dist)):sha(f) for f in sorted(dist.rglob('*')) if f.is_file()}
    manifest=json.loads((app/'.prnext-candidate/manifest.json').read_text());page=next(p for p in manifest['prerendered'] if p['path']=='/pages-static');asset=next(r['client'] for r in manifest['routes'] if r['pattern']=='/pages-static')
    prefix=out/'nginx';prefix.mkdir();html=app/'.prnext-candidate'/page['file']
    def quoted(path):return '"'+str(path).replace('\\','\\\\').replace('"','\\"')+'"'
    config=prefix/'nginx.conf';config.write_text(f'''worker_processes 1;
pid {quoted(prefix/'nginx.pid')};
error_log stderr warn;
events {{ worker_connections 2048; }}
http {{ access_log off; sendfile on; gzip off; gzip_static on;
  server {{ listen 127.0.0.1:32302;
    location = /pages-static {{ default_type text/html; alias {quoted(html)}; }}
    location = /payload.txt {{ default_type text/plain; alias {quoted(app/'public/payload.txt')}; }}
    location = /robots.txt {{ alias {quoted(app/'public/robots.txt')}; }}
    location /_prnext/assets/ {{ alias {quoted(app/'.prnext-candidate/assets')[:-1]+'/"'}; }}
  }}
}}
''')
    configs=server_configs(out,app,node,cpus,shutil.which('nginx'),prefix,config)
    provenance['static']={'html':str(html),'gzip':str(html)+'.gz','htmlSha256':sha(html),'gzipSha256':sha(str(html)+'.gz'),'asset':asset,'nginxConfigSha256':sha(config),'sameBuildForBothNativeStaticServers':True}
    asset_file=app/'.prnext-candidate'/asset.removeprefix('/_prnext/')
    provenance['static']['controls']=[{'route':'pages-static','html':str(html),'gzip':str(html)+'.gz'}, {'route':'payload.txt','html':str(app/'public/payload.txt'),'gzip':None}, {'route':asset.lstrip('/'),'html':str(asset_file),'gzip':str(asset_file)+'.gz'}]
    for control in provenance['static']['controls']:
        control['identitySha256']=sha(control['html']);control['gzipSha256']=sha(control['gzip']) if control['gzip'] else None
    verify_baseline(baseline,allow_generated=True);verify_sources(ROOT,provenance['candidateSources'])
    provenance['sourcesUnchangedAfterBuild']=True
    provenance['runtimeCompatibility']={'expected':'v4 build accepted by candidate','functionalConfig':'candidate-v4-build','executed':False}
    (out/'provenance.json').write_text(json.dumps(provenance,indent=2));(out/'servers.json').write_text(json.dumps(configs,indent=2))
    print(out)
if __name__=='__main__':main()
