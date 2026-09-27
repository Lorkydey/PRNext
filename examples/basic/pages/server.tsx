import { createHash } from 'node:crypto';
import Link from 'next/link';
import Head from 'next/head';
import type { GetServerSideProps } from 'prnext';

type Props = { name: string; time: string; digest: string };
export const getServerSideProps: GetServerSideProps<Props> = async ({ query, res }) => {
  const name = String(query.name || 'world');
  res.setHeader('x-prnext-example', 'server');
  // This code and this marker must never enter a browser bundle.
  const serverOnlyMarker = 'PRNEXT_SERVER_ONLY_SENTINEL';
  return { props: { name, time: new Date().toISOString(), digest: createHash('sha256').update(serverOnlyMarker + name).digest('hex').slice(0, 12) } };
};

export default function Server({ name, time, digest }: Props) {
  return <main><Head><title>SSR · PRNext</title></Head><Link href="/">← PRNext</Link><h1>Hello, {name}.</h1><p>Rendered on request at <time>{time}</time>.</p><p>Node crypto digest: <code>{digest}</code></p><p>The response passes through the native Rust server.</p></main>;
}
