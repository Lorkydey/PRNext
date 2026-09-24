import localFont from 'next/font/local';
import { Inter, Roboto_Mono } from 'next/font/google';
import rustyxFont from 'rustyx/font/local';
import { Geist } from 'rustyx/font/google';

const body = localFont({ src: './body.woff2', variable: '--font-body', fallback: ['sans-serif'] });
const remote = Inter({ subsets: ['latin'], axes: ['opsz'], variable: '--font-inter' });
const mono = Roboto_Mono({ weight: ['400', '700'], preload: false });
const local = rustyxFont({ src: [{ path: './regular.ttf', weight: '400' }], adjustFontFallback: false });
const geist = Geist({ subsets: ['latin'] });
export default function FontTypes() {
  return <div className={`${body.variable} ${remote.variable} ${geist.className}`}>
    <p className={mono.className} style={local.style}>Font</p>
  </div>;
}
