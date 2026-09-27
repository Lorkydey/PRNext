'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useParams } from 'next/navigation';

export default function Navigation() {
  const [count, setCount] = useState(0);
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams();
  return <header><Link className="wordmark" href="/">prnext<span>✳</span></Link><nav><Link href="/">Home</Link><Link href="/about">About</Link><Link href="/items/alpha?tag=one&tag=two">Item</Link><Link href="/actions">Actions</Link><Link href="/cache">Cache</Link><Link href="/static/welcome">Static + ISR</Link><Link href="/stream">Streaming</Link><Link href="/redirect">Redirect</Link><Link href="/items/missing">Missing item</Link><Link href="/failure">Server error</Link><Link href="/client-failure">Client error</Link></nav><button onClick={() => setCount(value => value + 1)}>Layout count: {count}</button><button onClick={() => router.refresh()}>Refresh data</button><span data-testid="pathname">{pathname}</span><span data-testid="params">{JSON.stringify(params)}</span></header>;
}
