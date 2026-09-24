import { Suspense } from 'react';
import Counter from '../../components/counter';

export const metadata = { title: 'Streaming' };
export const dynamic = 'force-dynamic';

async function DelayedPanel({ milliseconds, label }: { milliseconds: number; label: string }) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
  return <section><h2>{label}</h2><p>This section arrived after {milliseconds} ms.</p><Counter /></section>;
}

export default function StreamingPage() {
  return <>
    <p className="eyebrow">PROGRESSIVE RENDERING</p>
    <h1>Ready parts.<br /><span>Right away.</span></h1>
    <p className="intro">The layout stays interactive while these two server components finish. Try its counter before both sections appear.</p>
    <Suspense fallback={<p role="status">Loading the first section…</p>}>
      <DelayedPanel milliseconds={700} label="First section ready" />
    </Suspense>
    <Suspense fallback={<p role="status">Loading the second section…</p>}>
      <DelayedPanel milliseconds={1400} label="Second section ready" />
    </Suspense>
  </>;
}
