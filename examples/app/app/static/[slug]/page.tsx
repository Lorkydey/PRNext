import Link from 'next/link';

export const revalidate = 10;

export function generateStaticParams() {
  return [{ slug: 'welcome' }];
}

export default async function StaticPage({ params }: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const generatedAt = new Date().toISOString();
  return <>
    <p className="eyebrow">APP ROUTER / STATIC GENERATION</p>
    <h1>Static page: {slug}</h1>
    <p>Generated at <time dateTime={generatedAt}>{generatedAt}</time>.</p>
    <p>In production, Rust serves this page and its Flight data from disk. After ten seconds, a visit starts a background refresh. Reload again to see the new generation.</p>
    <p>The welcome page is generated at build time. Other slugs are generated on their first visit.</p>
    <Link href="/static/another-page">Open another static page →</Link>
  </>;
}
