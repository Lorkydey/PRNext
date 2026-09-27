import { useState } from 'react';
import clsx from 'clsx';
import Link from 'prnext/link';
import Head from 'prnext/head';

export default function Home() {
  const [count, setCount] = useState(0);
  return <>
    <Head><title>PRNext — Rust meets React</title><meta name="description" content="Rust HTTP. React UI. Your npm ecosystem." /></Head>
    <main>
      <header><a className="wordmark" href="/">prnext<span>✳</span></a><span className="badge">0.1 / ALPHA</span></header>
      <div className="eyebrow"><i /> BUILT WITH RUST. MADE FOR REACT.</div>
      <h1>A native core.<br /><span>A familiar world.</span></h1>
      <p className="intro">Keep your components. Keep your npm packages.<br />Let Rust handle the HTTP.</p>
      <div className="terminal"><span>$</span> prnext dev <b>▌</b></div>
      <section className="grid">
        <article><span className="number">01 / NATIVE</span><h2>Rust at the door.</h2><p>Async HTTP, compressed assets, static pages and bounded workers. An architecture you can measure.</p><code>axum + tokio</code></article>
        <article><span className="number">02 / COMPATIBLE</span><h2>Your React. Your npm.</h2><p>This page uses React hooks, TypeScript and the real clsx npm package. Click to check hydration.</p><button className={clsx('counter', count > 0 && 'active')} onClick={() => setCount(value => value + 1)}>Count: {count} <span>↗</span></button></article>
        <article><span className="number">03 / EXPLORE</span><h2>See the moving parts.</h2><nav><Link href="/server?name=PRNext">Server rendering <span>↗</span></Link><Link href="/blog/hello">Static generation <span>↗</span></Link><Link href="/isr/welcome">Incremental generation <span>↗</span></Link><Link href="/docs/routing/dynamic">Catch-all routing <span>↗</span></Link><a href="/api/hello">JSON API <span>↗</span></a></nav></article>
      </section>
      <footer><span>PRNext is an independent, experimental framework.</span><span>RUST CORE / JAVASCRIPT RUNTIME</span></footer>
    </main>
  </>;
}
