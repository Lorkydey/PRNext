import type { ReactNode } from 'react';
import Navigation from '../components/navigation';
import './styles.css';

export const metadata = { title: 'Rustyx · App Router', description: 'Real React Server Components, served through Rust.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><Navigation /><main>{children}</main><footer>RUST HTTP · REACT SERVER COMPONENTS · NPM</footer></body></html>;
}
