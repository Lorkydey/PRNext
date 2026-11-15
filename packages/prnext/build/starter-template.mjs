export function starterPage(extension) {
  return `import ConnectAI from './connect-ai';

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
        <p className="starter-edit">Or edit <code>app/page.${extension}</code> directly.</p>
      </div>
    </main>
  );
}
`;
}

export function starterConnection() {
  return `'use client';

export default function ConnectAI() {
  return (
    <a className="starter-primary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/troubleshooting.md#connect-the-existing-development-mcp" target="_blank" rel="noopener noreferrer" onClick={event => {
      if (process.env.NODE_ENV !== 'development') return;
      const request = new CustomEvent('prnext:devtools:open-ai', { cancelable: true });
      if (!window.dispatchEvent(request)) event.preventDefault();
    }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></svg>
      Connect AI
    </a>
  );
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
a:focus-visible { outline: 2px solid #ededed; outline-offset: 5px; }
.starter { min-height: 100svh; display: grid; place-items: center; padding: 48px 24px; }
.starter-content { width: min(100%, 520px); text-align: center; }
.starter h1 { margin: 0; font-size: clamp(32px, 5vw, 44px); font-weight: 500; line-height: 1.15; letter-spacing: -.045em; text-wrap: balance; }
.starter-description { margin: 18px 0 0; color: #999; font-size: 15px; line-height: 1.7; }
.starter-links { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 24px; margin-top: 30px; }
.starter-links a { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; padding: 11px 0; border: 0; border-radius: 8px; font-size: 13px; font-weight: 500; line-height: 1.5; }
.starter-links .starter-primary { padding-inline: 18px; background: #ededed; color: #111; }
.starter-links .starter-primary:hover { background: #fff; color: #111; }
.starter-links .starter-secondary { color: #aaa; }
.starter-links .starter-secondary:hover { color: #ededed; }
.starter-links svg { width: 16px; height: 16px; flex: none; }
.starter-edit { margin: 30px 0 0; color: #888; font-size: 13px; line-height: 1.7; }
.starter-edit code { color: #ccc; font-size: 12px; }
@media (forced-colors: active) {
  .starter-links .starter-primary { background: ButtonFace; color: ButtonText; }
  .starter-links .starter-secondary { color: LinkText; }
  a:focus-visible { outline-color: Highlight; }
}
`;
