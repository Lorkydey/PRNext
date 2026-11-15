export function starterPage() {
  return `import ConnectAI, { EditPageLink } from './connect-ai';

function Arrow() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>;
}

export default function Home() {
  return (
    <main className="starter">
      <div className="starter-content">
        <h1>Make your first change.</h1>
        <p className="starter-description">Connect your AI to start building.</p>
        <nav className="starter-links" aria-label="Resources">
          <ConnectAI />
          <a className="starter-secondary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/quickstart.md" target="_blank" rel="noopener noreferrer" aria-label="Read the docs (opens in a new tab)">Read the docs <Arrow /></a>
        </nav>
        <p className="starter-edit">Or edit <EditPageLink /> directly.</p>
      </div>
    </main>
  );
}
`;
}

export function starterConnection(extension = 'tsx') {
  return `'use client';

import { useEffect, useState } from 'react';

export default function ConnectAI() {
  return (
    <a className="starter-primary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/troubleshooting.md#connect-the-existing-development-mcp" target="_blank" rel="noopener noreferrer" onClick={event => {
      if (process.env.NODE_ENV !== 'development') return;
      const request = new CustomEvent('prnext:devtools:open-ai', { cancelable: true });
      if (!window.dispatchEvent(request)) event.preventDefault();
    }}>
      <span className="starter-ai-border" aria-hidden="true" />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></svg>
      Connect AI
    </a>
  );
}

export function EditPageLink() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { setEnabled(process.env.NODE_ENV === 'development'); }, []);
  return <button type="button" className="starter-source" disabled={!enabled} aria-label="Open app/page.${extension} in your editor" onClick={() => {
    if (process.env.NODE_ENV !== 'development') return;
    window.dispatchEvent(new CustomEvent('prnext:devtools:open-file', {
      detail: { file: 'app/page.${extension}' }, cancelable: true,
    }));
  }}><code>app/page.${extension}</code></button>;
}
`;
}

export const starterStyles = `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0a0a0a;
  color: #ededed;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
body { margin: 0; }
a { color: inherit; text-decoration: none; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
a:focus-visible, .starter-source:focus-visible { outline: 2px solid #ededed; outline-offset: 5px; }
.starter { min-height: 100svh; display: grid; place-items: center; padding: 48px 24px; }
.starter-content { width: min(100%, 520px); text-align: center; }
.starter h1 { margin: 0; font-size: clamp(32px, 5vw, 44px); font-weight: 500; line-height: 1.15; letter-spacing: -.045em; text-wrap: balance; }
.starter-description { margin: 18px 0 0; color: #999; font-size: 15px; line-height: 1.7; }
.starter-links { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 24px; margin-top: 30px; }
.starter-links a { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; padding: 11px 0; border: 0; border-radius: 8px; background: none; color: #aaa; font-size: 13px; font-weight: 500; line-height: 1.5; }
.starter-links a:hover { color: #ededed; }
.starter-links .starter-primary { position: relative; isolation: isolate; padding-inline: 18px; box-shadow: inset 0 0 0 1px #ffffff1c; }
.starter-ai-border { display: none; position: absolute; inset: 0; padding: 1px; border-radius: inherit; overflow: hidden; pointer-events: none; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; }
.starter-ai-border::before { content: ''; position: absolute; top: 50%; left: 50%; width: 200%; aspect-ratio: 1; background: conic-gradient(transparent 0deg 245deg, oklch(.72 .14 305 / .2) 275deg, oklch(.74 .13 270 / .85) 315deg, oklch(.82 .10 230) 341deg, oklch(.94 .04 210) 350deg, transparent 360deg); transform: translate(-50%, -50%) rotate(30deg); }
@supports (mask-composite: exclude) or (-webkit-mask-composite: xor) { .starter-ai-border { display: block; } }
.starter-links svg { width: 16px; height: 16px; flex: none; }
.starter-edit { margin: 30px 0 0; color: #888; font-size: 13px; line-height: 1.7; }
.starter-edit code { color: #ccc; font-size: 12px; }
.starter-source { border: 0; padding: 2px 3px; border-radius: 2px; background: none; color: inherit; font: inherit; }
.starter-source:enabled { cursor: pointer; text-decoration: underline; text-decoration-color: #555; text-underline-offset: 3px; }
.starter-source:enabled:hover { text-decoration-color: #ccc; }
.starter-source:disabled { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .starter-ai-border::before { animation: starter-ai-orbit 5.2s linear infinite; }
  @keyframes starter-ai-orbit { from { transform: translate(-50%, -50%) rotate(30deg); } to { transform: translate(-50%, -50%) rotate(390deg); } }
}
@media (forced-colors: active) {
  .starter-links a { color: LinkText; }
  .starter-links .starter-primary { box-shadow: none; outline: 1px solid LinkText; }
  .starter-ai-border { display: none; }
  a:focus-visible, .starter-links .starter-primary:focus-visible, .starter-source:focus-visible { outline: 2px solid Highlight; }
}
`;
