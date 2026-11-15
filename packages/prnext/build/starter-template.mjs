export function starterPage(extension) {
  return `function Arrow() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>;
}

export default function Home() {
  return (
    <main className="starter">
      <div className="starter-content">
        <p className="starter-name">PRNext</p>
        <h1>Make it yours.</h1>
        <p className="starter-description">Edit <code>app/page.${extension}</code> and save to see your changes.</p>
        <nav className="starter-links" aria-label="Resources">
          <a className="starter-primary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/quickstart.md" target="_blank" rel="noopener noreferrer" aria-label="Documentation (opens in a new tab)">Documentation <Arrow /></a>
          <a href="https://github.com/Lorkydey/PRNext" target="_blank" rel="noopener noreferrer" aria-label="GitHub (opens in a new tab)">GitHub <Arrow /></a>
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
.starter { min-height: 100svh; display: grid; place-items: center; padding: 48px 28px; }
.starter-content { width: min(100%, 480px); }
.starter-name { margin: 0 0 32px; color: #999; font-size: 14px; font-weight: 500; }
.starter h1 { margin: 0 0 16px; font-size: clamp(36px, 6vw, 48px); font-weight: 500; line-height: 1.12; letter-spacing: -.045em; }
.starter-description { max-width: 39ch; margin: 0; color: #999; font-size: 15px; line-height: 1.75; text-wrap: pretty; }
.starter-description code { color: #dedede; font-size: .9em; }
.starter-links { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; margin-top: 32px; }
.starter-links a { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 10px; border-radius: 7px; color: #aaa; font-size: 13px; }
.starter-links a:hover { color: #ededed; }
.starter-links .starter-primary { padding: 10px 15px; background: #ededed; color: #111; font-weight: 500; }
.starter-links .starter-primary:hover { background: #fff; color: #111; }
.starter-links svg { width: 15px; height: 15px; }
@media (max-width: 380px) {
  .starter { padding-inline: 24px; }
  .starter-links { gap: 20px; }
}
@media (forced-colors: active) {
  .starter-links .starter-primary { background: ButtonFace; color: ButtonText; border: 1px solid ButtonText; }
  a:focus-visible { outline-color: Highlight; }
}
`;
