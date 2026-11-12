import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {githubName,canonicalName,validVersion} from '../scripts/release-github-package.mjs';

const options={};for(let i=2;i<process.argv.length;i++){const name=process.argv[i];assert.ok(['--archive','--version','--npm-cli','--report','--browser'].includes(name));options[name]=name==='--browser'?true:process.argv[++i];}
const archive=path.resolve(options['--archive']),version=validVersion(options['--version']);
const npmCli=path.resolve(options['--npm-cli']);const root=await mkdtemp(path.join(tmpdir(),'prnext-github consumer-'));
const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH};for(const key of ['PRNEXT_BINARY','NODE_AUTH_TOKEN','GITHUB_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','ACTIONS_ID_TOKEN_REQUEST_URL'])delete env[key];
let server,browser,log='',origin;const result={passed:false,version,platform:process.platform,checks:[]};
async function put(name,text){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
async function run(args){let output='';const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-20000);});const [code,signal]=await once(child,'exit');assert.equal(code,0,`Consumer command failed (${signal||code}): ${output}`);return output;}
try{
  await put('package.json',JSON.stringify({name:'prnext-github-consumer',private:true,type:'module',dependencies:{[githubName]:'file:'+archive,react:'19.3.1','react-dom':'19.3.1','react-server-dom-webpack':'19.3.1'}}));
  await run([npmCli,'install','--include=optional','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/']);
  const cli=path.join(root,'node_modules',githubName,'cli.mjs');
  assert.match(await run([cli,'--version']),new RegExp(version.replaceAll('.','\\.')));assert.match(await run([cli,'--help']),/prnext build/);result.checks.push('CLI version and help in a path with spaces');
  await stat(path.join(root,'node_modules/.bin',process.platform==='win32'?'prnext.cmd':'prnext'));
  await put('identity.mjs',`import assert from 'node:assert/strict';import {createRequire} from 'node:module';import * as wrapper from '${githubName}';import * as official from '${canonicalName}';const require=createRequire(import.meta.url);assert.equal(wrapper.build,official.build);assert.equal(wrapper.route,official.route);assert.equal(require('${githubName}/server').NextResponse,require('${canonicalName}/server').NextResponse);`);
  await run([path.join(root,'identity.mjs')]);result.checks.push('Shared CLI and framework API identity');
  await put('app/layout.jsx',`export const metadata={title:'GitHub package integration'};export default function Layout({children}){return <html><body>{children}</body></html>}`);
  await put('app/page.jsx',`import Link from '${githubName}/link';import {route} from '${githubName}';import Client from './client';export default function Page(){return <main><h1>GitHub package SSR</h1><Link href={route('/about')}>About</Link><Client/></main>}`);
  await put('app/client.jsx',`'use client';import {useState} from 'react';import {usePathname} from '${githubName}/navigation';export default function Client(){const [count,setCount]=useState(0);return <><button onClick={()=>setCount(n=>n+1)}>Clicks {count}</button><p>{usePathname()}</p></>}`);
  await put('app/about/page.jsx',`export default function About(){return <h1>GitHub package about</h1>}`);
  await put('app/api/check/route.js',`import {NextResponse} from '${githubName}/server';export async function POST(request){const input=await request.json();return NextResponse.json({ok:input.test==='bridge'},{status:201})}`);
  await run([cli,'build',root]);result.checks.push('Production build through GitHub import paths');
  server=spawn(process.execPath,[cli,'start',root,'--port','0','--hostname','127.0.0.1'],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{log=(log+data).slice(-16000);const match=/http:\/\/127\.0\.0\.1:\d+/.exec(log);if(match)origin=match[0];});
  const deadline=performance.now()+30000;while(!origin&&performance.now()<deadline&&server.exitCode===null)await new Promise(resolve=>setTimeout(resolve,50));assert.ok(origin,'Consumer server did not start: '+log);
  const response=await fetch(origin);assert.equal(response.status,200);assert.match(await response.text(),/GitHub package SSR/);result.checks.push('Native production SSR');
  const post=await fetch(origin+'/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"test":"bridge"}'});assert.equal(post.status,201);assert.deepEqual(await post.json(),{ok:true});result.checks.push('POST through the GitHub server export');
  if(options['--browser']){
    const {chromium}=await import('@playwright/test');browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.getByRole('button',{name:'Clicks 0',exact:true}).click();await page.getByRole('button',{name:'Clicks 1',exact:true}).waitFor();await page.evaluate(()=>{window.__githubPackageDocument=true;});await page.getByRole('link',{name:'About',exact:true}).click();await page.getByRole('heading',{name:'GitHub package about',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__githubPackageDocument),true);assert.deepEqual(errors,[]);result.checks.push('Hydration, click, client navigation and zero page errors');
  }
  result.passed=true;console.log(JSON.stringify(result));
}catch(error){result.error=error.message;throw error;}finally{
  await browser?.close();
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');let timer;const finished=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),7000);})]);clearTimeout(timer);if(!finished){server.kill('SIGKILL');await exited;}}
  if(options['--report'])await writeFile(path.resolve(options['--report']),JSON.stringify(result,null,2)+'\n');
  assert.ok(path.basename(root).startsWith('prnext-github consumer-'));assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});
}
