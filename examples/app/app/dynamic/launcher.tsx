'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';

const Checklist = dynamic(() => import('./checklist'), {
  loading: () => <p role="status">Opening your checklist…</p>,
});

export default function ChecklistLauncher() {
  const [open, setOpen] = useState(false);
  return <section className="counter-panel">
    <button aria-expanded={open} aria-controls="packing-checklist" onClick={() => setOpen(value => !value)}>
      {open ? 'Close checklist' : 'Open checklist'}
    </button>
    <div id="packing-checklist" aria-live="polite">
      {open && <Checklist title="Ready for a day out?" />}
    </div>
  </section>;
}
