export function starterPage(extension) {
  return `function Arrow() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>;
}

export default function Home() {
  return (
    <main className="starter">
      <div className="starter-content">
        <h1>PRNext</h1>
        <p className="starter-description">Your app is ready.</p>
        <div className="starter-edit">
          <p className="starter-file"><span>Start with</span><code>app/page.${extension}</code></p>
          <p className="starter-hint">Save your file. See your changes.</p>
        </div>
        <nav className="starter-links" aria-label="Resources">
          <a className="starter-primary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/quickstart.md" target="_blank" rel="noopener noreferrer" aria-label="Read the docs (opens in a new tab)">Read the docs <Arrow /></a>
          <a className="starter-secondary" href="https://github.com/Lorkydey/PRNext" target="_blank" rel="noopener noreferrer" aria-label="GitHub (opens in a new tab)">GitHub <Arrow /></a>
        </nav>
      </div>
    </main>
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
.starter-content { width: min(100%, 380px); text-align: center; }
.starter h1 { margin: 0; font-size: clamp(64px, 10vw, 88px); font-weight: 650; line-height: 1; letter-spacing: -.075em; }
.starter-description { margin: 16px 0 0; color: #999; font-size: 15px; line-height: 1.6; }
.starter-edit { margin-top: 36px; }
.starter-file { display: flex; justify-content: center; align-items: baseline; flex-wrap: wrap; gap: 10px; margin: 0; padding: 15px 16px; border: 1px solid #282828; border-radius: 10px; background: #101010; font-size: 13px; line-height: 1.5; }
.starter-file span { color: #999; }
.starter-file code { color: #ededed; font-size: 13px; }
.starter-hint { margin: 12px 0 0; color: #888; font-size: 12px; line-height: 1.6; }
.starter-links { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 28px; }
.starter-links a { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px; border: 1px solid transparent; border-radius: 8px; font-size: 13px; font-weight: 500; line-height: 1.5; }
.starter-links .starter-primary { background: #ededed; color: #111; }
.starter-links .starter-primary:hover { background: #fff; color: #111; }
.starter-links .starter-secondary { background: #101010; border-color: #303030; color: #ccc; }
.starter-links .starter-secondary:hover { background: #191919; border-color: #555; color: #ededed; }
.starter-links svg { width: 14px; height: 14px; flex: none; }
@media (forced-colors: active) {
  .starter-links .starter-primary, .starter-links .starter-secondary { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  .starter-file { border-color: CanvasText; }
  a:focus-visible { outline-color: Highlight; }
}
`;
