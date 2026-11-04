import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { repositoryRoot, binary } from './support.mjs';

export const counterSource = (label = 'Original', { renderError = false, eventError = false } = {}) => `'use client';import{useState}from'react';import styles from'./counter.module.css';export default function Counter(){const[count,setCount]=useState(0);${renderError ? 'throw new Error("render refresh failure");' : ''}return <button data-testid="counter" className={styles.counter} onClick={()=>{${eventError ? 'throw new Error("event refresh failure");' : 'setCount(count+1);'}}}>${label} {count}</button>}`;

export function developmentOrigin(line) {
  if (!line.startsWith('PRNext development ')) return;
  const match = line.length <= 512 && /^PRNext development \u00b7 (http:\/\/127\.0\.0\.1:([1-9]\d{0,4})) \u00b7 on-demand routes$/.exec(line);
  if (!match || Number(match[2]) > 65535) throw new Error('Invalid development readiness banner');
  return match[1];
}

// Exercise the public stdio transport, including its real session lifecycle.
// The CLI reads this fixture's private capability; never expose protocol bodies
// or stderr in test errors, since tool results can contain local source/context.
async function connectDevAssistant(root) {
  const child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'mcp',root],{cwd:repositoryRoot,env:{...process.env,PRNEXT_BINARY:binary},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const pending=new Map();let serial=0,closing,ended=false;
  const closed=new Promise(resolve=>child.once('close',resolve));
  const fail=message=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error(message));}pending.clear();};
  child.stderr.resume();child.stdin.on('error',()=>fail('The local MCP test input closed.'));child.once('error',()=>fail('The local MCP test process could not start.'));child.once('close',()=>{ended=true;fail('The local MCP test process closed.');});
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{fail('The local MCP test process returned an invalid protocol message.');return;}const job=pending.get(message.id);if(!job)return;pending.delete(message.id);clearTimeout(job.timer);if(message.error)job.reject(Error('The local MCP test request was rejected.'));else job.resolve(message.result);});
  const request=(method,params)=>new Promise((resolve,reject)=>{if(ended)return reject(Error('The local MCP test process is closed.'));const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('The local MCP test request timed out: '+method));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){pending.delete(id);clearTimeout(timer);reject(Error('The local MCP test request could not be written.'));}});});
  const close=()=>closing||=(async()=>{if(!ended){child.stdin.end();const timer=setTimeout(()=>child.kill('SIGTERM'),3000);await closed;clearTimeout(timer);}lines.close();})();
  const call=async(name,args={})=>{const result=await request('tools/call',{name,arguments:args});if(result?.isError)throw Error('The local MCP test tool failed: '+name);return result.structuredContent;};
  try{
    const initialization=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'PRNext browser test',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');await request('tools/list',{});
    for(let attempt=0;attempt<100;attempt++){if((await call('dev_connection')).connected)return{call,close,initialization};await delay(20);}
    throw Error('The real local MCP session did not become connected.');
  }catch(error){await close();throw error;}
}

export async function devFixture({config, files: additionalFiles = {},args=[],env={}} = {}) {
  const root = await mkdtemp(path.join(repositoryRoot, '.prnext-hmr-test-'));
  const aiSessions=new Set();
  const files = {
    'package.json': '{"name":"prnext-dev-test","type":"module"}',
    'postcss.config.json': '{"plugins":[]}',
    'prnext.config.mjs': config || `export default{basePath:'/docs'}`,
    'components/Counter.jsx': counterSource(),
    'components/counter.module.css': '.counter{color:rgb(12,34,56)}',
    'pages/pages.jsx': `import Counter from'../components/Counter';export const getServerSideProps=()=>({props:{value:'page-server-one'}});export default function Page({value}){return <><h1>Pages refresh</h1><Counter/><p data-testid="server">{value}</p></>}`,
    'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/app/page.jsx': `import Counter from'../../components/Counter';export const dynamic='force-dynamic';export default function Page(){return <><h1>App refresh</h1><Counter/><p data-testid="server">app-server-one</p></>}`,
    ...additionalFiles,
  };
  for (const [file, source] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), source); }
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', root, '--port', '0',...args], {
    cwd: repositoryRoot, env: { ...process.env, ...env, NODE_ENV: 'development', PRNEXT_BINARY: binary }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', url, startupError, bannerLine = '', discardLine = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output = (output + chunk).slice(-80_000);
    if (url || startupError) return;
    const parts = chunk.split('\n');
    for (let index = 0; index < parts.length; index++) {
      const complete = index < parts.length - 1, part = parts[index];
      if (!discardLine) {
        if (bannerLine.length + part.length > 512) {
          if ((bannerLine + part.slice(0, 32)).startsWith('PRNext development ')) startupError = new Error('Invalid development readiness banner');
          bannerLine = ''; discardLine = true;
        } else bannerLine += part;
      }
      if (complete) {
        if (!discardLine) {
          try { url = developmentOrigin(bannerLine.replace(/\r$/, '')); } catch (error) { startupError = error; }
        }
        bannerLine = ''; discardLine = false;
      }
      if (url || startupError) break;
    }
  });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-80_000); });
  child.once('error', error => { startupError = new Error(`dev spawn failed: ${error.message}`); });
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    }
  };
  const close = async () => {
    await Promise.allSettled([...aiSessions].map(session=>session.close()));
    await stop();
    // Windows may retain a terminated grandchild's working-directory handle
    // briefly. Keep cleanup bounded, as for the independent-app fixtures.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode) throw new Error(`dev exited: ${output}`);
      if (!url) { await delay(50); continue; }
      try {
        const response = await fetch(url + '/docs/pages');
        if (response.ok) {await response.text();return { root, url, child, close, stop, output: () => output,
          connectAI:async()=>{const session=await connectDevAssistant(root);aiSessions.add(session);return session;},
          write: (file, source) => writeFile(path.join(root, file), source),
          read: file => readFile(path.join(root, file), 'utf8'),
        };}
      } catch {}
      await delay(50);
    }
    throw new Error(`dev did not start: ${output}`);
  } catch (error) { await close(); throw error; }
}
