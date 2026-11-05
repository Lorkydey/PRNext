import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {health, nativeHealthPath} from './persistent/health.mjs';

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return {port:instance.address().port, buildId:'candidate'};
}
const config = {hostname:'example.test', port:443, healthPath:nativeHealthPath};
const ready = res => res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({schemaVersion:1,status:'ready',buildId:'candidate'}));

test('native health consumes a complete bounded protocol response without following redirects', async t => {
  let value = 'ready', seen = [];
  const generation = await server(t, (req,res) => {
    seen.push([req.url,req.headers.host]);
    if (value === 'ready') return ready(res);
    if (value === 'redirect') return res.writeHead(302,{location:'/login'}).end();
    if (value === 'missing') return res.writeHead(200,{'content-type':'text/html'}).end('<h1>Login</h1>');
    if (value === 'version') return res.writeHead(200,{'content-type':'application/json'}).end('{"schemaVersion":2,"status":"ready"}');
    if (value === 'draining') return res.writeHead(200,{'content-type':'application/json'}).end('{"schemaVersion":1,"status":"draining"}');
    if (value === 'different') return res.writeHead(200,{'content-type':'application/json'}).end('{"schemaVersion":1,"status":"ready","buildId":"old"}');
    if (value === 'encoded') return res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'}).end('compressed');
    if (value === 'large') return res.writeHead(200,{'content-type':'application/json'}).end(' '.repeat(4097));
    if (value === 'chunked') { res.writeHead(200,{'content-type':'application/json'}); res.write(' '.repeat(4097)); return res.end(); }
    if (value === 'truncated') { res.writeHead(200,{'content-type':'application/json','content-length':100}); res.flushHeaders(); res.write('{'); return setImmediate(()=>res.destroy()); }
    if (value === 'slow') { res.writeHead(200,{'content-type':'application/json'}); return res.flushHeaders(); }
  });
  await health(generation,config,1000);
  assert.deepEqual(seen,[[nativeHealthPath,'example.test:443']]);
  for (const [mode,error] of [['redirect',/HTTP 302/],['missing',/application\/json/],['version',/report ready/],['draining',/report ready/],['different',/different build/],['encoded',/encoded body/],['large',/exceeds 4096/],['chunked',/exceeds 4096/],['truncated',/incomplete|aborted|reset/i],['slow',/abort/i]]) {
    value=mode; await assert.rejects(health(generation,config,mode==='slow'?40:1000),error,mode);
  }
  assert.equal(seen.filter(([url])=>url==='/login').length,0);
});

test('application health is an additional complete HTTP200 probe with its own bounded body', async t => {
  let mode='good',seen=[];
  const generation=await server(t,(req,res)=>{
    seen.push(req.url);
    if(req.url===nativeHealthPath)return ready(res);
    if(mode==='good')return res.end('healthy');
    if(mode==='json')return res.writeHead(200,{'content-type':'application/json'}).end('{"database":"ok"}');
    if(mode==='bad')return res.writeHead(500).end('unavailable');
    if(mode==='redirect')return res.writeHead(302,{location:'/login'}).end();
    if(mode==='large')return res.end('x'.repeat(65537));
    res.write('partial');
  });
  const configured={...config,healthPath:'/api/health'};
  await health(generation,configured,1000);
  assert.deepEqual(seen,[nativeHealthPath,'/api/health']);
  mode='json'; await health(generation,configured,1000);
  for(const [value,error]of [['bad',/HTTP 500/],['redirect',/HTTP 302/],['large',/exceeds 65536/],['slow',/abort/i]]){
    mode=value;await assert.rejects(health(generation,configured,value==='slow'?40:1000),error);
  }
});
