import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import Counter from '../components/counter';
import { getServerData } from '../lib/server-data';

export default async function Home() {
  const [data, requestHeaders, cookieStore] = await Promise.all([getServerData(), headers(), cookies()]);
  return <><p className="eyebrow">APP ROUTER / REACT FLIGHT</p><h1>Server power.<br /><span>Client interaction.</span></h1><p className="intro">This async page runs on the server. Its data arrives through React's real Server Component protocol.</p><p data-testid="server-time">{data.timestamp}</p><p>Server digest: <code>{data.digest}</code></p><p data-testid="request-header">{requestHeaders.get('x-example') || 'no custom header'}</p><p data-testid="cookie-theme">{cookieStore.get('theme')?.value || 'default theme'}</p><Counter /><Link href="/about">Navigate without losing the layout counter →</Link></>;
}
