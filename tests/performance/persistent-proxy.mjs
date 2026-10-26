// Linux process-tree CPU/RSS + paired HTTP load on isolated static apps.
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {freePort} from '../support.mjs';
import {initializeHome,rpc} from '../../packages/prnext/runtime/persistent/common.mjs';
const execute=promisify(execFile),repo=fileURLToPath(new URL('../../',import.meta.url));
const [baseline,oldBinary,destination]=process.argv.slice(2).map(p=>path.resolve(p));
assert.equal(process.platform,'linux');await mkdir(destination,{recursive:true});const out=await mkdtemp(path.join(destination,'proxy-'));
const apps=[],records=[];
try{
  for(const [label,source,binary]of [['baseline',baseline,oldBinary],['candidate',repo,process.env.PRNEXT_BINARY||path.join(repo,'target/release/prnext')]]){
    const root=path.join(out,label),home=path.join(out,label+'-manager');await mkdir(path.join(root,'dist'),{recursive:true});
    await writeFile(path.join(root,'dist/index.html'),'<!doctype html><h1>Proxy payload</h1>'+('ordinary static content '.repeat(50)));
    const env={...process.env,PRNEXT_PM_HOME:home,PRNEXT_BINARY:binary};
    const cli=async(...args)=>(await execute(process.execPath,[path.join(source,'packages/prnext/cli.mjs'),...args],{cwd:source,env,timeout:90000})).stdout;
    await cli('build',root,'--adapter','static','--from','dist');const port=await freePort();
    const app={label,cli,home,url:`http://127.0.0.1:${port}`,root};apps.push(app);
    await cli('pstart',root,'--name','perf','--port',String(port),'--workers','1');
    const response=await fetch(app.url);assert.equal(response.status,200);assert.match(await response.text(),/Proxy payload/);
  }
  const clock=Number((await execute('getconf',['CLK_TCK'])).stdout.trim());
  async function snapshot(app){
    const owner=await rpc(await initializeHome(app.home),{command:'ping'});
    const status=JSON.parse(await app.cli('pstatus','--json'));const pids=new Set([owner.pid,owner.daemonPid,...status.apps.flatMap(a=>[a.pid,a.proxyPid]).filter(Boolean)]);
    const stats=[];for(const name of await readdir('/proc'))if(/^\d+$/.test(name))try{
      const pid=Number(name),stat=await readFile('/proc/'+name+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      stats.push({pid,parent:Number(fields[1]),ticks:Number(fields[11])+Number(fields[12])});
    }catch{}
    let changed=true;while(changed){changed=false;for(const s of stats)if(pids.has(s.parent)&&!pids.has(s.pid)){pids.add(s.pid);changed=true;}}
    let rssKiB=0;for(const pid of pids)try{rssKiB+=Number(/^VmRSS:\s+(\d+)/m.exec(await readFile(`/proc/${pid}/status`,'utf8'))?.[1]||0);}catch{}
    return {pids:[...pids],ticks:stats.filter(s=>pids.has(s.pid)).reduce((n,s)=>n+s.ticks,0),rssKiB};
  }
  for(let round=0;round<3;round++)for(const app of round%2?[...apps].reverse():apps){
    const before=await snapshot(app);
    const load=JSON.parse((await execute(process.execPath,[path.join(repo,'tests/performance/load.mjs'),app.url,'6','32'],{timeout:45000})).stdout);
    const after=await snapshot(app);assert.equal(load.errors,0);
    records.push({label:app.label,round,load,before,after,serverCpuSeconds:(after.ticks-before.ticks)/clock});
    await writeFile(path.join(out,'results.json'),JSON.stringify({node:process.version,clock,records},null,2));console.log(JSON.stringify(records.at(-1)));
  }
}finally{for(const app of apps){await app.cli('pstop','--all').catch(()=>{});await app.cli('pdown').catch(()=>{});}}
console.log('Results: '+path.join(out,'results.json'));
