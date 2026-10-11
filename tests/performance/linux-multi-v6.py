"""Prepared Linux multi-app campaign. Requires delegated cgroup v2; not run on Windows."""
import argparse, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, time
HERE=pathlib.Path(__file__).resolve().parent
def module(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
def main():
    p=argparse.ArgumentParser();p.add_argument('--prepared',required=True);p.add_argument('--cgroup-root',required=True);args=p.parse_args()
    if sys.platform!='linux':raise SystemExit('Linux required; prepared does not mean executed')
    root=pathlib.Path(args.prepared).resolve();out=root/'multi-v6';out.mkdir()
    r=module('linux-runner');provenance=json.loads((root/'provenance.json').read_text());cpus=provenance['physicalCpus']
    if provenance.get('generation')!='v6' or provenance.get('baseline')!='final-v5' or not provenance.get('sourcesUnchangedAfterBuild'):
        raise RuntimeError('Expected immutable v5/candidate preparation')
    for variant in ['v5','candidate']:
        if r.digest(root/('prnext-'+variant))!=provenance['artifacts'][variant]['sha256']:
            raise RuntimeError('Binary changed after preparation: '+variant)
    os.sched_setaffinity(0,{cpus[2]});node=shutil.which('node');source=root/'app'
    projects=[]
    for i in range(8):
        dst=out/f'app{i}';dst.mkdir();projects.append(dst)
        for name in ['package.json','next.config.mjs','app','pages','public','.prnext-v5','.prnext-candidate','.next']:
            src=source/name
            if src.is_dir():shutil.copytree(src,dst/name,ignore=shutil.ignore_patterns('cache','.cache'))
            elif src.is_file():shutil.copy2(src,dst/name)
        (dst/'node_modules').symlink_to(source/'node_modules',target_is_directory=True)
    runs=[]
    def save(): (out/'campaign.json').write_text(json.dumps({'complete':False,'runs':runs,'linuxExecuted':True},indent=2))
    for repeat in [1,2]:
      for n,budget in [(1,512),(4,1024),(8,2048),(4,512),(8,1024)]:
       for profile in ['balanced','memory','speed','balanced-small']:
        for variant in (['v5','candidate'] if repeat==1 else ['candidate','v5']):
          label=f'r{repeat}-{n}apps-{budget}MiB-{profile}-{variant}';folder=out/label;folder.mkdir();commands=[]
          for i in range(n):
            cmd=[str(root/('prnext-'+variant)),'start',str(projects[i]),'--build-dir','.prnext-'+variant,'--node',node,'--profile','balanced' if profile=='balanced-small' else profile,'--port',str(33600+i)]
            commands.append({'command':cmd,'cwd':str(projects[i]),'environment':{'NODE_OPTIONS':'--max-semi-space-size=1'} if profile=='balanced-small' else {}})
          group=folder/'group.json';group.write_text(json.dumps({'commands':commands},indent=2))
          cfg={'command':[sys.executable,str(HERE/'multi-supervisor-v6.py'),str(group)],'cwd':str(root),'cpu':cpus[0],'generatorCpus':[cpus[1]],'memoryBytes':budget*1048576}
          result={'complete':False,'label':label,'config':cfg,'commands':commands,'binarySha256':r.digest(root/('prnext-'+variant)),'results':[],'startedAt':time.time()};server=None
          try:
            server=r.Server(cfg,args.cgroup_root,str(folder/'supervisor.log'))
            if not (server.group/'memory.swap.max').exists():raise RuntimeError('Swap controller required for a zero-swap comparison')
            assert (server.group/'memory.swap.max').read_text().strip()=='0'
            urls=[f'http://127.0.0.1:{33600+i}' for i in range(n)]
            for url in urls:
              for _ in range(150):
                try:r.request(url+'/robots.txt');break
                except Exception:time.sleep(.1)
              else:raise TimeoutError('Server readiness')
            def load(mode,seconds):
              apps=[{'url':url,'connections':(128 if mode=='noisy' else 32 if mode=='one' else max(1,32//n)) if i==0 else (0 if mode=='one' else 1 if mode=='noisy' else max(1,32//n)),**({'intervalMs':100} if mode=='noisy' and i>0 else {})} for i,url in enumerate(urls)]
              config=folder/(mode+'.json');config.write_text(json.dumps({'seconds':seconds,'apps':apps}))
              command=['taskset','-c',str(cpus[1]),node,str(HERE/'multi-load-v6.mjs'),str(config)]
              with (folder/(mode+'.jsonl')).open('xb') as log:done=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=seconds+90)
              lines=[json.loads(line) for line in (folder/(mode+'.jsonl')).read_text().splitlines() if line.startswith('{')];assert lines and lines[-1]['type']=='final'
              return {'exitCode':done.returncode,'command':command,**lines[-1]}
            phases=[('warmup',5),('all',20)] if (n,budget) in [(4,512),(8,1024)] else [('warmup',5),('all',20),('one',40),('noisy',20)]
            for mode,seconds in phases:
              result['results'].append({'phase':mode,**r.measured(server,lambda:load(mode,seconds),str(folder/'resources.jsonl'))})
            result['complete']=True
          except BaseException as error:result['error']=repr(error)
          finally:
            if server is not None:
              result['beforeCleanup']=server.sample();result['afterCleanup']=server.close()
            result['finishedAt']=time.time();(folder/'result.json').write_text(json.dumps(result,indent=2))
          runs.append({'label':label,'complete':result['complete']});save()
    (out/'campaign.json').write_text(json.dumps({'complete':True,'runs':runs,'linuxExecuted':True},indent=2))
if __name__=='__main__':main()
