import { useRouter } from '@thomas.f/prnext/router';
import Link from '@thomas.f/prnext/link';

export default function Docs() {
  const { query } = useRouter();
  const parts = Array.isArray(query.slug) ? query.slug : [];
  return <main><Link href="/">← PRNext</Link><h1>Documentation</h1><p data-testid="segments">{parts.join(' / ') || 'Index'}</p></main>;
}
