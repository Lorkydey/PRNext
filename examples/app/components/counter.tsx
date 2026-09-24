'use client';
import { useState } from 'react';
import clsx from 'clsx';
import { useSearchParams } from 'next/navigation';

export default function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  const search = useSearchParams();
  return <section className={clsx('counter-panel', count > initial && 'active')}><p>A client component, rendered on the server and hydrated in your browser.</p><button onClick={() => setCount(value => value + 1)}>Page count: {count}</button><p data-testid="search-param">{search.get('view') || 'default'}</p></section>;
}
