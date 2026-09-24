import { useRouter } from 'rustyx/router';
import Link from 'rustyx/link';

export default function Docs() {
  const { query } = useRouter();
  const parts = Array.isArray(query.slug) ? query.slug : [];
  return <main><Link href="/">← Rustyx</Link><h1>Documentation</h1><p data-testid="segments">{parts.join(' / ') || 'Index'}</p></main>;
}
