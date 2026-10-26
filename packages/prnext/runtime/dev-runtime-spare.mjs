// One prewarmed process becomes exactly one immutable development generation.
// It is owned by the CLI, never shared across builds or production projects.
import net from 'node:net';
import {timingSafeEqual} from 'node:crypto';
import {realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=await realpath(process.cwd()),token=process.env.PRNEXT_DEV_SPARE_TOKEN;
delete process.env.PRNEXT_DEV_SPARE_TOKEN;
if(!token)throw Error('Private development parent required');
const announce=value=>process.stdout.write(JSON.stringify(value)+'\n');
const spareHeartbeat=setInterval(()=>process.stdout.write('alive\n'),1000);spareHeartbeat.unref();
// Warm framework dependencies only; no application module or data function runs.
const require=createRequire(path.join(root,'package.json'));
try{require('react');require('react-dom/server.node');}catch{/* Actual bootstrap reports missing peers. */}
let armed,starting,ready;
const controls=new Map();
globalThis.__PRNEXT_DEV_WORKER_PULSE__=line=>{for(const[socket,watch]of controls)if(watch&&!socket.destroyed)socket.write(line);};
const broker=net.createServer(socket=>{
  socket.setNoDelay(true);socket.setTimeout(10000,()=>socket.destroy());let source='';
  socket.on('data',chunk=>{
    source+=chunk;if(Buffer.byteLength(source)>8192){socket.destroy();return;}
    if(!source.includes('\n'))return;socket.removeAllListeners('data');
    void(async()=>{
      const input=JSON.parse(source.trim()),supplied=Buffer.from(input.token||''),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||!armed||input.project!==root||input.dist!==armed.dist)throw Error('Invalid generation capability');
      if(!starting)starting=(async()=>{
        const manifest=JSON.parse(await readFile(path.join(armed.dist,'manifest.json'),'utf8'));
        if(manifest.dev!==true)throw Error('Development build required');
        for(const key of ['PRNEXT_CACHE_URL','PRNEXT_CACHE_TOKEN'])delete process.env[key];
        if(input.cache){process.env.PRNEXT_CACHE_URL=input.cache.url;process.env.PRNEXT_CACHE_TOKEN=input.cache.token;}
        process.env.PRNEXT_WORKER_SOCKET=String(Math.max(1,Math.min(512,input.lanes||1)));
        process.env.PRNEXT_WORKER_TOKEN=token;process.env.PRNEXT_WORKER_ACTIVITY='1';
        clearInterval(spareHeartbeat);
        process.argv=[process.execPath,path.join(armed.dist,'runtime/worker.mjs'),root,armed.dist];
        const announced=new Promise(resolve=>{globalThis.__PRNEXT_DEV_WORKER_READY__=resolve;});
        await import(pathToFileURL(process.argv[1]).href);ready=await announced;
        return ready;
      })().catch(()=>process.exit(1));
      const info=await starting;if(!socket.destroyed){
        socket.setTimeout(0);controls.set(socket,input.watch===true);socket.write(JSON.stringify(info)+'\n');
        let command='';socket.on('data',chunk=>{command+=chunk;if(command.length>16){socket.destroy();return;}if(command==='retire\n')process.stdin.emit('end');});
      }
    })().catch(()=>socket.destroy());
  });
  socket.on('error',()=>{});
  socket.on('close',()=>{const owned=controls.delete(socket);if(owned&&!controls.size&&ready)process.stdin.emit('end');});
});
broker.maxConnections=16;
broker.listen(0,'127.0.0.1',()=>{broker.unref();announce({type:'warm',port:broker.address().port});});
let control='';const arm=chunk=>{control+=chunk;if(control.length>8192)process.exit(1);if(!control.includes('\n'))return;process.stdin.off('data',arm);
  let message;try{message=JSON.parse(control.trim());}catch{process.exit(1);}if(message?.type!=='arm'||armed)process.exit(1);
  void realpath(message.dist).then(dist=>{if(!dist.startsWith(root+path.sep))throw Error('Generation outside project');armed={dist};announce({type:'armed'});}).catch(()=>process.exit(1));
};process.stdin.on('data',arm);
// Parent lifetime is guarded even while this is still an unused spare.
process.stdin.resume();process.stdin.once('end',()=>{broker.close();if(!starting)process.exit();});
