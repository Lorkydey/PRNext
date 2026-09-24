import { notFound } from 'next/navigation';
import Counter from '../../../components/counter';

export default async function Item({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ tag?: string | string[] }> }) {
  const { slug } = await params;
  if (slug === 'missing') notFound();
  const { tag } = await searchParams;
  return <><h1>Item: {slug}</h1><p data-testid="tags">{Array.isArray(tag) ? tag.join(', ') : tag || 'no tags'}</p><Counter initial={10} /></>;
}
