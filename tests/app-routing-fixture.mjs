import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function routingFixture({ staticOnly = false, independentRoots = false, configurationAliases = false, noMiddleware = false } = {}) {
  const fixture = await appFixture(), counts = new Map();
  const origin = createServer((request, response) => {
    const name = request.url.slice(1), count = (counts.get(name) || 0) + 1;
    counts.set(name, count); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ count }));
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  async function remove() { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); }
  try {
    for (const folder of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, folder), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources'}`,
      'components/context.jsx': `import {headers,cookies} from 'next/headers';export default async function Context({name}){await Promise.resolve();const h=await headers(),c=await cookies();return <p data-testid={name}>{[h.get('x-user')||'none',h.get('x-destination')||'none',c.get('branch')?.value||'none'].join(':')}</p>}`,
      'components/counter.jsx': `'use client';import {useState} from 'react';export default function Counter({name}){const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{name} {count}</button>}`,
      'components/inspect.jsx': `'use client';import {useSelectedLayoutSegment,useSelectedLayoutSegments,useParams} from 'next/navigation';export default function Inspect({name,slot}){return <p data-testid={name}>{JSON.stringify({one:useSelectedLayoutSegment(slot),all:useSelectedLayoutSegments(slot),params:useParams()})}</p>}`,
      'components/back.jsx': `'use client';import {useRouter} from 'next/navigation';export default function Back(){const router=useRouter();return <button onClick={()=>router.back()}>close modal</button>}`,
      'components/actions.js': `'use server';import {cookies} from 'next/headers';export async function mutate(){await fetch(${JSON.stringify(originURL + '/mutation')},{method:'POST'});return 'done'}export async function logout(){(await cookies()).delete('auth')}`,
      'components/controls.jsx': `'use client';import {useRouter} from 'next/navigation';import {mutate,logout} from './actions';export default function Controls(){const router=useRouter();return <><button onClick={()=>router.refresh()}>refresh route</button><button onClick={async()=>{await mutate()}}>mutate route</button><button onClick={async()=>{await logout()}}>logout route</button><button onClick={()=>router.push(window.location.pathname.replace(/^\\/docs(?=\\/|$)/,'')+'?step='+(Number(new URL(window.location.href).searchParams.get('step')||0)+1))}>advance history</button></>}`,
      'proxy.js': `import {NextResponse} from 'next/server';export function proxy(request){if(request.nextUrl.pathname.startsWith('/admin') && request.cookies.get('auth')?.value!=='yes')return NextResponse.redirect(new URL('/docs/login',request.url));if(request.nextUrl.pathname.startsWith('/transform')){const headers=new Headers(request.headers);headers.set('x-user','branch-user');const response=request.nextUrl.pathname==='/transform-alias'?NextResponse.rewrite(new URL('/docs/transform',request.url),{request:{headers}}):NextResponse.next({request:{headers}});response.cookies.set('branch','source');return response}if(request.nextUrl.pathname.startsWith('/photo/')){const headers=new Headers(request.headers);headers.set('x-user','destination-user');headers.set('x-destination','current');return NextResponse.next({request:{headers}})}return NextResponse.next()}export const config={matcher:['/admin/:path*','/transform/:path*','/transform-alias','/photo/:path*']}`,
      'app/layout.jsx': `import Link from 'next/link';import Inspect from '../components/inspect';import Controls from '../components/controls';${staticOnly ? '' : "export const dynamic='force-dynamic';"}export default function Root({children,modal}){return <html><body><nav><Link href="/">feed</Link> <Link href="/dashboard">dashboard</Link> <Link href="/photo/one">photo one</Link></nav><Controls/><Inspect name="root-segments"/>{children}{modal}</body></html>}`,
      'app/not-found.jsx': `export default()=> <h1>Routing missing</h1>`,
      'app/login/page.jsx': `export default()=> <h1>Login required</h1>`,
      'app/admin/page.jsx': `export default async()=> <h1>Protected admin {(await (await fetch(${JSON.stringify(originURL + '/admin')})).json()).count}</h1>`,
      'app/transform/page.jsx': `import {headers} from 'next/headers';import Context from '../../components/context';export async function generateMetadata(){return{description:'Metadata '+(await headers()).get('x-user')}}export default async()=> <><h1>Transformed {(await headers()).get('x-user')}</h1><Context name="source-context"/></>`,
      'app/page.jsx': `import Counter from '../components/counter';export default async function Feed(){const count=${staticOnly ? '0' : `(await (await fetch(${JSON.stringify(originURL + '/feed')})).json()).count`};return <main><h1>Feed</h1><p>Feed version {count}</p><Counter name="feed count"/></main>}`,
      'app/photo/[id]/page.jsx': `${staticOnly ? "export const generateStaticParams=()=>[{id:'one'}];" : ''}export default async function Photo({params}){const {id}=await params;return <h1>Canonical photo {id}</h1>}`,
      'app/@modal/default.jsx': `export default()=>null`,
      'app/@modal/(.)photo/[id]/page.jsx': `import Context from '../../../../components/context';import Back from '../../../../components/back';export default async function Modal({params}){const {id}=await params;return <aside role="dialog"><h1>Modal photo {id}</h1><Context name="destination-context"/><Back/></aside>}`,
      'app/dashboard/layout.jsx': `import Link from 'next/link';import Counter from '../../components/counter';import Inspect from '../../components/inspect';export default({children,team,analytics})=><section><h1>Dashboard</h1><Counter name="dashboard count"/><Inspect name="dashboard-segments"/><Inspect name="team-segments" slot="team"/><nav><Link href="/dashboard/settings">settings</Link> <Link href="/dashboard/team">team only</Link></nav><main>{children}</main><aside data-testid="team">{team}</aside><aside data-testid="analytics">{analytics}</aside></section>`,
      'app/dashboard/page.jsx': `import Counter from '../../components/counter';export const metadata={description:'Primary dashboard',other:{'primary-metadata':'present'}};export default()=> <><h2>Dashboard home</h2><Counter name="main count"/></>`,
      'app/dashboard/default.jsx': `export default()=> <h2>Default main</h2>`,
      'app/dashboard/settings/page.jsx': `export default()=> <h2>Settings main</h2>`,
      'app/dashboard/settings/deep/page.jsx': `export default()=> <h2>Deep settings main</h2>`,
      'app/dashboard/@team/layout.jsx': `import Counter from '../../../components/counter';export default({children})=><><Counter name="team count"/>{children}</>`,
      'app/dashboard/@team/page.jsx': `export async function generateMetadata(_,parent){return{other:{'team-metadata':'present','team-parent':(await parent).title.absolute}}}export default()=> <h2>Team home</h2>`,
      'app/dashboard/@team/settings/page.jsx': `export const metadata={title:'Team settings'};export default()=> <h2>Team settings</h2>`,
      'app/dashboard/@team/settings/deep/page.jsx': `export default()=> <h2>Deep team settings</h2>`,
      'app/dashboard/@team/team/page.jsx': `export default()=> <h2>Team only</h2>`,
      'app/dashboard/@team/default.jsx': `export default()=> <h2>Default team</h2>`,
      'app/dashboard/@analytics/page.jsx': `import Counter from '../../../components/counter';export const metadata={title:'Analytics title',other:{'analytics-metadata':'retained'}};export default async function Analytics(){const {count}=await (await fetch(${JSON.stringify(originURL + '/analytics')})).json();return <><h2>Analytics home {count}</h2><Counter name="analytics count"/></>}`,
      'app/dashboard/@analytics/default.jsx': `export default()=> <h2>Default analytics</h2>`,
      'app/dashboard/@analytics/error.jsx': `'use client';export default({error})=><h2>Analytics error {error.digest?'private':'client'}</h2>`,
      'app/dashboard/@analytics/not-found.jsx': `export default()=> <h2>Analytics missing</h2>`,
      'app/dashboard/@analytics/fail/page.jsx': `export default function Fail(){throw new Error('PRIVATE_ANALYTICS_ERROR')}`,
      'app/dashboard/@analytics/absent/page.jsx': `import {notFound} from 'next/navigation';export default function Absent(){notFound()}`,
      'app/dashboard/fail/page.jsx': `export default()=> <h2>Healthy main next to error</h2>`,
      'app/dashboard/absent/page.jsx': `export default()=> <h2>Healthy main next to missing</h2>`,
      'app/album/layout.jsx': `import Counter from '../../components/counter';export default({children,modal})=><section><Counter name="album count"/>{children}{modal}</section>`,
      'app/album/page.jsx': `import Link from 'next/link';export default()=> <main><h1>Album background</h1><Link href="/photo/two">album photo</Link></main>`,
      'app/album/@modal/default.jsx': `export default()=>null`,
      'app/album/@modal/(..)photo/[id]/page.jsx': `export default async({params})=><aside role="dialog">Album modal {(await params).id}</aside>`,
      'app/album/deep/layout.jsx': `export default({children,modal})=><section>{children}{modal}</section>`,
      'app/album/deep/page.jsx': `import Link from 'next/link';export default()=> <main><h1>Deep background</h1><Link href="/photo/three">root photo</Link></main>`,
      'app/album/deep/@modal/default.jsx': `export default()=>null`,
      'app/album/deep/@modal/(...)photo/[id]/page.jsx': `export default async({params})=><aside role="dialog">Root modal {(await params).id}</aside>`,
      'app/standalone/layout.jsx': `import Counter from '../../components/counter';export default({children})=><section><Counter name="standalone count"/>{children}</section>`,
      'app/standalone/page.jsx': `import Link from 'next/link';export default()=> <main><h1>Standalone source</h1><Link href="/photo/four">inline photo</Link></main>`,
      'app/standalone/(..)photo/[id]/page.jsx': `export default async({params})=><h1>Inline intercepted {(await params).id}</h1>`,
      'app/users/[user]/layout.jsx': `import Counter from '../../../components/counter';export default async({children,modal,params})=><section><h2>User layout {(await params).user}</h2><Counter name="user count"/>{children}{modal}</section>`,
      'app/users/[user]/page.jsx': `import Link from 'next/link';export default()=> <main><h1>User background</h1><Link href="/photo/five">user photo</Link></main>`,
      'app/users/[user]/@modal/default.jsx': `export default()=>null`,
      'app/users/[user]/@modal/(..)(..)photo/[id]/page.jsx': `import Link from 'next/link';import Inspect from '../../../../../../components/inspect';export default async({params})=><aside role="dialog"><h1>User modal {(await params).id}</h1><Inspect name="user-params"/><Link href="/photo/six">next user photo</Link></aside>`,
      'app/missing/layout.jsx': `export default({children,slot})=><section>{children}{slot}</section>`,
      'app/missing/page.jsx': `export default()=> <h2>Missing home</h2>`,
      'app/missing/deeper/page.jsx': `export default()=> <h2>Missing deeper</h2>`,
      'app/missing/@slot/page.jsx': `export default()=> <h2>Existing slot</h2>`,
      'app/(group)/nested/[...slug]/page.jsx': `import Inspect from '../../../../components/inspect';export default()=> <Inspect name="catchall-segments"/>`,
      'app/cascade/page.jsx': `import Link from 'next/link';import Counter from '../../components/counter';export default()=> <><h1>Cascade source</h1><Counter name="cascade count"/><Link href="/item/one">open item</Link></>`,
      'app/cascade/layout.jsx': `export default({children,modal})=><section>{children}{modal}</section>`,
      'app/cascade/@modal/default.jsx': `export default()=>null`,
      'app/cascade/@modal/(..)item/[id]/layout.jsx': `export default({children,zoom})=><aside data-testid="outer-modal">{children}{zoom}</aside>`,
      'app/cascade/@modal/(..)item/[id]/page.jsx': `import Link from 'next/link';import Counter from '../../../../../components/counter';export default async({params})=><><h2>Item modal {(await params).id}</h2><Counter name="item count"/><Link href="/item/one/zoom/two">open zoom</Link></>`,
      'app/cascade/@modal/(..)item/[id]/@zoom/default.jsx': `export default()=>null`,
      'app/cascade/@modal/(..)item/[id]/@zoom/(.)zoom/[zoom]/page.jsx': `import Back from '../../../../../../../../components/back';export default async({params})=><aside data-testid="inner-modal"><h3>Zoom {(await params).id}:{(await params).zoom}</h3><Back/></aside>`,
      'app/item/[id]/page.jsx': `export default async({params})=><h1>Canonical item {(await params).id}</h1>`,
      'app/item/[id]/zoom/[zoom]/page.jsx': `export default async({params})=><h1>Canonical zoom {(await params).id}:{(await params).zoom}</h1>`,
    };
    if (configurationAliases) {
      files['app/transform/page.jsx'] = files['app/transform/page.jsx'].replace("import {headers}", "import Counter from '../../components/counter';import {headers}").replace('<Context name="source-context"/>', '<Context name="source-context"/><Counter name="source count"/>');
      const rule = (source, destination, extra = {}) => ({ source, destination, ...extra });
      const rewrites = {
        beforeFiles: [rule('/config-before', '/config-step?origin=first', { has: [{ type: 'header', key: 'x-routing-phase', value: 'ready' }] }),
          rule('/config-step', '/transform?phase=before'), rule('/config-gated', '/admin'), rule('/config-restricted', '/restricted?phase=alias'),
          rule('/config-switch', '/login', { has: [{ type: 'cookie', key: 'version', value: 'next' }] }), rule('/config-switch', '/transform'),
          rule('/config-external', `${originURL}/external-proxy`)],
        afterFiles: [rule('/config-after', '/transform?phase=after'), rule('/config-public', '/transform')],
        fallback: [rule('/config-fallback', '/transform?phase=fallback')],
      };
      const redirects = [rule('/config-gated', '/login', { permanent: false, missing: [{ type: 'cookie', key: 'auth', value: 'yes' }] })];
      const headers = [{ source: '/config-before', headers: [{ key: 'x-configured-stage', value: 'before-middleware' }] }];
      files['prnext.config.mjs'] = `export default{basePath:'/docs',assetPrefix:'/resources',async headers(){return ${JSON.stringify(headers)}},async redirects(){return ${JSON.stringify(redirects)}},async rewrites(){return ${JSON.stringify(rewrites)}}}`;
      files['public/config-public'] = 'PUBLIC_FILE_MUST_NOT_BE_RESTORED_AS_A_PAGE';
      files['proxy.js'] = files['proxy.js'].replace('export function proxy(request){', `export function proxy(request){if(request.nextUrl.pathname.startsWith('/config-')){const headers=new Headers(request.headers);headers.set('x-user','configuration-user');headers.set('x-routing-phase','ready');const response=NextResponse.next({request:{headers}});response.cookies.set('branch','source');return response}`);
      files['proxy.js'] = files['proxy.js'].replace('matcher:[', "matcher:['/config-:name',");
      files['app/restricted/page.jsx'] = files['app/transform/page.jsx'];
      files['proxy.js'] = files['proxy.js'].replace('matcher:[', "matcher:['/restricted',").replace('export function proxy(request){', "export function proxy(request){if(request.nextUrl.pathname==='/restricted')return NextResponse.redirect(new URL('/docs/login',request.url));");
    }
    if (noMiddleware) delete files['proxy.js'];
    if (independentRoots) {
      for (const name of Object.keys(files)) if (name.startsWith('app/')) delete files[name];
      for (const group of ['a', 'b']) {
        files[`app/(${group})/layout.jsx`] = `import Link from 'next/link';import Counter from '../../components/counter';export const dynamic='force-dynamic';export default({children,extra})=><html><body data-root="${group}"><h1>Root ${group}</h1><Counter name="root ${group} count"/><Link href="/${group}/next">same root</Link><Link href="/${group === 'a' ? 'b' : 'a'}">other root</Link>{children}{extra}</body></html>`;
        files[`app/(${group})/@extra/default.jsx`] = `export default()=>null`;
        for (const suffix of ['', '/next']) files[`app/(${group})/${group}${suffix}/page.jsx`] = `export const metadata={title:'Page ${group}${suffix}'};export default()=> <h2>Page ${group}${suffix}</h2>`;
      }
    }
    for (const [name, source] of Object.entries(files)) {
      if (staticOnly && name.startsWith('app/') && !/^app\/(?:layout\.jsx|page\.jsx|not-found\.jsx|photo\/|@modal\/)/.test(name)) continue;
      const target = path.join(fixture.root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source);
    }
    return { ...fixture, remove, counts, build: () => promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 8 * 1024 * 1024 }) };
  } catch (error) { await remove(); throw error; }
}
