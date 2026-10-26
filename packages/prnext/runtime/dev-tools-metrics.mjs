import {readdir,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

// Lazy tails of the existing bounded inspector format. The directory is created
// inside this development session, never accepted from an HTTP/tool argument.
export function createDevMetricsCollector(directory,{since=Date.now()}={}){
  const seen=new Set();let running,last=0;
  return async function collect(record){
    if(running)return running;if(Date.now()-last<700)return;
    running=(async()=>{
      const container=await lstat(directory).catch(()=>null);if(!container?.isDirectory()||container.isSymbolicLink())return;
      const names=(await readdir(directory)).filter(name=>/^(?:worker-\d+-\d+|native-\d+)\.jsonl(?:\.1)?$/.test(name));
      const files=(await Promise.all(names.slice(-64).map(async name=>({name,info:await lstat(path.join(directory,name)).catch(()=>null)})))).filter(file=>file.info?.isFile()&&!file.info.isSymbolicLink()).sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs).slice(0,4);
      for(const file of files){
        let handle;try{
          handle=await open(path.join(directory,file.name),constants.O_RDONLY|(constants.O_NOFOLLOW||0));const stat=await handle.stat();if(!stat.isFile()||stat.ino!==file.info.ino)continue;
          const bytes=Buffer.alloc(Math.min(stat.size,65536)),start=Math.max(0,stat.size-bytes.length);await handle.read(bytes,0,bytes.length,start);
          const lines=bytes.toString('utf8').split('\n');if(start)lines.shift();
          for(const line of lines){if(line.length>4096||!line)continue;
            let event;try{event=JSON.parse(line);}catch{continue;}
            if(!Number.isFinite(event.time)||event.time<since||!['http','fetch'].includes(event.type))continue;
            const id=file.name+':'+line;if(seen.has(id))continue;seen.add(id);
            record({time:event.time,path:event.type==='fetch'?event.destination:event.route,route:event.route,method:event.method||'GET',status:event.status,duration:event.durationMs,kind:event.type,source:'server',failed:!!event.error||event.status>=400});
          }
        }catch{/* Inspection must not break development. */}finally{await handle?.close().catch(()=>{});}
      }
      if(seen.size>2000){const keep=[...seen].slice(-1000);seen.clear();for(const id of keep)seen.add(id);}
    })().catch(()=>{}).finally(()=>{last=Date.now();running=undefined;});return running;
  };
}
