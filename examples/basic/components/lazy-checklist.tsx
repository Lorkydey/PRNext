import { useState } from 'react';

const items = ['Tickets', 'Headphones', 'Water bottle'];

export default function Checklist({ title }: { title: string }) {
  const [packed, setPacked] = useState<string[]>([]);
  return <section>
    <h2>{title}</h2>
    {items.map(item => <label key={item} style={{ display: 'block', margin: '12px 0' }}>
      <input type="checkbox" checked={packed.includes(item)} onChange={() => setPacked(current =>
        current.includes(item) ? current.filter(value => value !== item) : [...current, item],
      )} /> {item}
    </label>)}
    <p>{packed.length === items.length ? 'All packed. Enjoy your day!' : `${packed.length} of ${items.length} packed`}</p>
  </section>;
}
