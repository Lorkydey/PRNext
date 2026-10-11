"""Prepare exact before/after/Next artifacts and byte-identical Nginx controls.
Requires an immutable v3 source snapshot; a Git revision alone is NOT v3.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parents[1]
def sha(file):return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()
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
def main():
    p=argparse.ArgumentParser();p.add_argument('--baseline-source',required=True);p.add_argument('--output',default=str(ROOT/'artifacts/performance-linux'));args=p.parse_args()
    if sys.platform!='linux':raise SystemExit('Prepared for Linux only; not an emulation of Linux on Windows')
    baseline=pathlib.Path(args.baseline_source).resolve();out=pathlib.Path(args.output).resolve()
    reference=json.loads((baseline.parent/'reference.json').read_text())
    for name,expected in reference['sourceSha256'].items():
        file=baseline/name
        if not file.is_file() or sha(file)!=expected:raise RuntimeError('Immutable v3 snapshot mismatch: '+name)
    if out.exists():raise RuntimeError('Choose a new output directory to preserve earlier evidence')
    node=pathlib.Path(shutil.which('node')).resolve()
    if subprocess.check_output([str(node),'--version'],text=True).strip()!='v24.19.0':raise RuntimeError('Node 24.19.0 required')
    if not subprocess.check_output(['rustc','--version'],text=True).startswith('rustc 1.98.0 '):raise RuntimeError('Rust 1.98.0 required')
    cpus=physical_cpus();out.mkdir(parents=True);logs=out/'build-logs';logs.mkdir()
    provenance={'reference':reference,'node':subprocess.check_output([str(node),'--version'],text=True).strip(),'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'nginx':subprocess.run(['nginx','-V'],capture_output=True,text=True,check=True).stderr,'wrk':subprocess.run(['wrk','--version'],capture_output=True,text=True).stdout,'lscpu':subprocess.check_output(['lscpu'],text=True),'physicalCpus':cpus,'artifacts':{}}
    provenance['npm']=subprocess.check_output(['npm','--version'],text=True).strip();provenance['python']=sys.version
    provenance['kernel']=subprocess.check_output(['uname','-a'],text=True).strip();provenance['nodeSha256']=sha(node)
    provenance['candidateRevision']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    provenance['candidateGitStatus']=subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True)
    tracked=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    provenance['candidateSources']={name:sha(ROOT/name) for name in sorted(set(tracked)) if name and (ROOT/name).is_file()}
    for name,source in [('v3',baseline),('candidate',ROOT)]:
        if not (source/'Cargo.lock').is_file():raise RuntimeError('Expected full v3/candidate source snapshot')
        run(['npm','ci'],source,logs/(name+'-npm-ci.log'))
        run(['cargo','build','--release','--locked','-p','prnext'],source,logs/(name+'-native.log'))
        binary=out/('prnext-'+name);shutil.copy2(source/'target/release/prnext',binary);provenance['artifacts'][name]={'binary':str(binary),'sha256':sha(binary),'cargoLock':sha(source/'Cargo.lock'),'npmLock':sha(source/'package-lock.json')}
    app=out/'app';run([str(node),str(HERE/'fixture.mjs'),str(app)],ROOT,logs/'fixture.log')
    # Add the Pages static control to the SAME sources built by all compilers.
    (app/'pages/pages-static.jsx').write_text("export default function Page(){return <main><h1>Static reference</h1><table><tbody>{Array.from({length:100},(_,i)=><tr key={i}><td>{i}</td><td>{'row '+i}</td><td>{i*7}</td></tr>)}</tbody></table></main>}\n")
    shutil.copy2(HERE/'fixture-lock.json',app/'package-lock.json');run(['npm','ci'],app,logs/'fixture-npm-ci.log')
    for name,source in [('v3',baseline),('candidate',ROOT)]:
        run([str(node),str(source/'packages/prnext/cli.mjs'),'build',str(app)],source,logs/(name+'-app-build.log'))
        (app/'.prnext').rename(app/('.prnext-'+name))
    run([str(node),str(app/'node_modules/next/dist/bin/next'),'build'],app,logs/'next-build.log')
    old_command=[str(out/'prnext-candidate'),'start',str(app),'--build-dir','.prnext-v3','--node',str(node),'--port','32309']
    rejected=subprocess.run(old_command,capture_output=True,text=True,timeout=15)
    provenance['actualOldArtifactRejection']={'command':old_command,'exitCode':rejected.returncode,'stdout':rejected.stdout,'stderr':rejected.stderr}
    if rejected.returncode==0 or 'prnext build' not in rejected.stderr:raise RuntimeError('The actual old v3 build must be refused with a rebuild command')
    provenance['next']=json.loads((app/'node_modules/next/package.json').read_text())['version']
    provenance['react']=json.loads((app/'node_modules/react/package.json').read_text())['version']
    if provenance['next']!='16.3.5':raise RuntimeError('Next 16.3.5 required')
    provenance['fixtureSources']={str(f.relative_to(app)):sha(f) for folder in ['app','pages','public'] for f in sorted((app/folder).rglob('*')) if f.is_file()}
    for name in ['v3','candidate']:
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
    configs={}
    for name in ['v3','candidate']:
        for profile in ['balanced','memory','speed']:
            label=name+'-'+profile
            configs[label]={'label':label,'command':[str(out/('prnext-'+name)),'start',str(app),'--build-dir','.prnext-'+name,'--profile',profile,'--node',str(node),'--port','32300'],'cwd':str(app),'url':'http://127.0.0.1:32300','node':str(node),'cpu':cpus[0],'generatorCpus':cpus[1:3],'memoryBytes':2*1024**3}
    configs['next']={**configs['v3-balanced'],'label':'next','command':[str(node),str(app/'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p','32301'],'url':'http://127.0.0.1:32301'}
    configs['nginx']={**configs['v3-balanced'],'label':'nginx','command':[shutil.which('nginx'),'-p',str(prefix)+'/', '-c',str(config),'-g','daemon off;'],'url':'http://127.0.0.1:32302'}
    configs['nginx']['generatorCpus']=cpus[1:5]
    # Static comparisons use identical candidate bytes for BOTH native binaries.
    for name in ['v3','candidate']:
        cfg=dict(configs[name+'-balanced']);cfg['command']=list(cfg['command']);cfg['command'][cfg['command'].index('--build-dir')+1]='.prnext-candidate';cfg['generatorCpus']=cpus[1:5];configs[name+'-static']=cfg
    provenance['static']={'html':str(html),'gzip':str(html)+'.gz','htmlSha256':sha(html),'gzipSha256':sha(str(html)+'.gz'),'asset':asset,'nginxConfigSha256':sha(config),'sameBuildForBothNativeStaticServers':True}
    asset_file=app/'.prnext-candidate'/asset.removeprefix('/_prnext/')
    provenance['static']['controls']=[{'route':'pages-static','html':str(html),'gzip':str(html)+'.gz'}, {'route':'payload.txt','html':str(app/'public/payload.txt'),'gzip':None}, {'route':asset.lstrip('/'),'html':str(asset_file),'gzip':str(asset_file)+'.gz'}]
    for control in provenance['static']['controls']:
        control['identitySha256']=sha(control['html']);control['gzipSha256']=sha(control['gzip']) if control['gzip'] else None
    (out/'provenance.json').write_text(json.dumps(provenance,indent=2));(out/'servers.json').write_text(json.dumps(configs,indent=2))
    print(out)
if __name__=='__main__':main()
