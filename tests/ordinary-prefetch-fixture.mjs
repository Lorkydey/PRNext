import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture } from './support.mjs';

export async function ordinaryPrefetchFixture() {
  const fixture = await appFixture();
  try {
    for (const name of ['app', 'pages', 'components', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': 'export default { cacheComponents: false };',
      'app/layout.jsx': 'export default function Layout({children}) { return <html><body>{children}</body></html>; }',
      'app/page.jsx': "import Links from './links'; export default function Page() { return <><h1>Ordinary App prefetch</h1><Links/></>; }",
      'app/links.jsx': `'use client';
        import {useEffect} from 'react'; import Link from 'next/link';
        export default function Links() {
          useEffect(() => { window.__ordinaryPrefetchReady = true; }, []);
          return <nav>
            <Link href="/target/private" prefetch={true}>Explicit prefetch</Link>
            <Link href="/target/auto">Default prefetch</Link>
            <Link href="/target/off" prefetch={false}>Disabled prefetch</Link>
          </nav>;
        }`,
      'app/target/[id]/page.jsx': `import {cookies} from 'next/headers';
        export const dynamic = 'force-dynamic';
        export default async function Page({params}) {
          const {id} = await params, visitor = (await cookies()).get('visitor')?.value || 'guest';
          return <main><h1>{'Target '+id}</h1><p data-testid="visitor">{visitor}</p></main>;
        }`,
      'app/static-links.jsx': `'use client';import {useEffect} from 'react';import Link from 'next/link';
        export default function StaticLinks({kind}) {useEffect(()=>{window.__ordinaryStaticReady=true},[]);
          return <main><h1>{'SSG '+kind+' prefetch'}</h1><Link href={'/target/'+kind} prefetch={true}>{'Open '+kind}</Link></main>}`,
      'app/ssg-protected/page.jsx': "import StaticLinks from '../static-links';export default function Page(){return <StaticLinks kind='protected'/>}",
      'app/ssg-public/page.jsx': "import StaticLinks from '../static-links';export default function Page(){return <StaticLinks kind='public'/>}",
      'app/target/protected/page.jsx': 'export default function Page(){return <p data-testid="static-protected">ORDINARY_SSG_PROTECTED_CANARY</p>}',
      'app/target/public/page.jsx': 'export default function Page(){return <p data-testid="static-public">Public SSG destination</p>}',
      'app/denied/page.jsx': 'export default function Page(){return <p data-testid="static-denied">Access denied</p>}',
      'proxy.js': `import {NextResponse} from 'next/server';export function proxy(request){
        if(request.nextUrl.pathname==='/target/protected'&&request.cookies.get('ssg-access')?.value!=='allowed')return NextResponse.redirect(new URL('/denied',request.url));
        return NextResponse.next()}`,
    };
    for (const [name, source] of Object.entries(files)) {
      const filename = path.join(fixture.root, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, source);
    }
    return { ...fixture, build: () => build(fixture.root) };
  } catch (error) { await fixture.remove(); throw error; }
}
