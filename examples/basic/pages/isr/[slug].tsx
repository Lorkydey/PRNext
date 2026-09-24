import type { GetStaticPaths, GetStaticProps } from 'rustyx';
import Link from 'rustyx/link';
import { useRouter } from 'rustyx/router';

type Props = { slug: string; generatedAt: string; reason: string };

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: [{ params: { slug: 'welcome' } }],
  fallback: true,
});

export const getStaticProps: GetStaticProps<Props> = async ({ params, revalidateReason }) => {
  await new Promise(resolve => setTimeout(resolve, 250));
  return {
    props: { slug: String(params?.slug), generatedAt: new Date().toISOString(), reason: revalidateReason },
    revalidate: 10,
  };
};

export default function IncrementalPage(props: Props) {
  const router = useRouter();
  if (router.isFallback) return <main><h1>Preparing this page…</h1></main>;
  return <main>
    <Link href="/">← Home</Link>
    <h1>Cached page: {props.slug}</h1>
    <p>Generated at <time dateTime={props.generatedAt}>{props.generatedAt}</time>.</p>
    <p>This version is served from disk. After ten seconds, the next visit starts a refresh while the previous version remains available.</p>
    <p>Generation reason: <code>{props.reason}</code></p>
    <nav><Link href="/isr/another-page">Open another page</Link><a href={router.asPath}>Reload this page</a></nav>
  </main>;
}
