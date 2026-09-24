import type { ComponentType } from 'react';
import '../styles.css';

export default function App({ Component, pageProps }: { Component: ComponentType<any>; pageProps: any }) {
  return <Component {...pageProps} />;
}
