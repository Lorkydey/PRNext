import Link from 'next/link';

export const metadata = { title: 'About · Rustyx' };
export default async function About() {
  await Promise.resolve();
  return <><p className="eyebrow">SERVER COMPONENT / ROUTE GROUP</p><h1>Same layout.<br /><span>New server tree.</span></h1><p>The route group does not appear in the URL. The counter in the header keeps its value during client navigation.</p><Link href="/">← Home</Link></>;
}
