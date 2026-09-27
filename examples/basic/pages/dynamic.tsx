import { useState } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Link from 'next/link';

const Checklist = dynamic(() => import('../components/lazy-checklist'), {
  loading: () => <p role="status">Opening your checklist…</p>,
});

export default function DynamicPage() {
  const [open, setOpen] = useState(false);
  return <main>
    <Head><title>On demand · PRNext</title></Head>
    <Link href="/">← PRNext</Link>
    <h1>A little less.<br /><span>Until you need more.</span></h1>
    <p className="intro">Open your packing checklist when you need it. It loads after you click.</p>
    <button className="counter" aria-expanded={open} aria-controls="packing-checklist" onClick={() => setOpen(value => !value)}>
      {open ? 'Close checklist' : 'Open checklist'}
    </button>
    <div id="packing-checklist" aria-live="polite">
      {open && <Checklist title="Ready for a day out?" />}
    </div>
  </main>;
}
