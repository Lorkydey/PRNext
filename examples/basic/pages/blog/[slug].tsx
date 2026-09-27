import Link from 'prnext/link';
import type { GetStaticProps } from 'prnext';

export function getStaticPaths() {
  return { paths: [{ params: { slug: 'hello' } }, { params: { slug: 'rust' } }], fallback: false };
}
export const getStaticProps: GetStaticProps<{ slug: string }> = async ({ params }) => ({ props: { slug: String(params?.slug) } });

export default function Post({ slug }: { slug: string }) {
  return <main><Link href="/">← PRNext</Link><h1>Post: {slug}</h1><p>This HTML was generated at build time and is served directly by Rust.</p></main>;
}
