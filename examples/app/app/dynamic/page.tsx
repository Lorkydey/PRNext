import Link from 'next/link';
import ChecklistLauncher from './launcher';

export const metadata = { title: 'On demand · Rustyx' };

export default function DynamicPage() {
  return <>
    <p className="eyebrow">READY WHEN YOU ARE</p>
    <h1>A little less.<br /><span>Until you need more.</span></h1>
    <p className="intro">Open your packing checklist when you need it. It loads after you click.</p>
    <ChecklistLauncher />
    <Link href="/">← Home</Link>
  </>;
}
