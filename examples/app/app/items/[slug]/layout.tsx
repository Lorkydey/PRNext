import type { ReactNode } from 'react';
export default async function ItemLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <section data-testid="nested-layout"><p className="eyebrow">NESTED LAYOUT / {slug}</p>{children}</section>;
}
