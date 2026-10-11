// Identical application sources for Next and PRNext; never caches dynamic output.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const files = {
  'package.json': JSON.stringify({name:'prnext-performance-fixture',private:true,type:'module',dependencies:{next:'16.3.5',react:'19.3.0','react-dom':'19.3.0'}}),
  'next.config.mjs': 'export default {};',
  'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
  'app/ssr/page.jsx': `import {cookies} from 'next/headers'; import {randomUUID} from 'node:crypto'; export const dynamic='force-dynamic'; export default async function Page(){const user=(await cookies()).get('user')?.value||'anonymous'; const nonce=randomUUID();return <main><p>{'user:'+user}</p><p>{'nonce:'+nonce}</p><table><tbody>{Array.from({length:100},(_,i)=><tr key={i}><td>{i}</td><td>{'row '+i}</td><td>{i*7}</td></tr>)}</tbody></table></main>}`,
  'app/stream/page.jsx': `import {Suspense} from 'react';import {cookies} from 'next/headers';import {randomUUID} from 'node:crypto';export const dynamic='force-dynamic';async function Slow({user,nonce,ms}){await new Promise(r=>setTimeout(r,ms));return <p>{'completed:'+user+':'+nonce}</p>}export default async function Page({searchParams}){const user=(await cookies()).get('user')?.value||'anonymous',nonce=randomUUID(),q=await searchParams;return <main><p>{'user:'+user}</p><p>{'nonce:'+nonce}</p><Suspense fallback={<p>pending-stream</p>}><Slow user={user} nonce={nonce} ms={q.delay?Math.min(10000,Number(q.delay)):40}/></Suspense></main>}`,
  'pages/api/json.js': `import {randomUUID} from 'node:crypto'; export default function handler(req,res){res.setHeader('Cache-Control','private, no-store');res.setHeader('x-worker-pid',String(process.pid));res.json({user:req.cookies.user||'anonymous',nonce:randomUUID(),rows:Array.from({length:16},(_,i)=>({id:i,value:'value '+i}))})}`,
  'app/static/page.jsx': `export default function Page(){return <main><h1>Static reference</h1><table><tbody>{Array.from({length:100},(_,i)=><tr key={i}><td>{i}</td><td>{'row '+i}</td><td>{i*7}</td></tr>)}</tbody></table></main>}`,
  'public/robots.txt':'User-agent: *\nDisallow:\n',
  'public/payload.txt': 'PRNext static public payload.\n'.repeat(1024),
};
for(const [name,source] of Object.entries(files)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
console.log(root);
