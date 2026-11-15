// A server-rendered welcome page: local brand asset, CSS and ordinary links.
export function starterPage(extension) {
  return `function Arrow() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>;
}

export default function Home() {
  return (
    <div className="welcome">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="welcome-header">
        <a className="welcome-brand" href="https://prnext.dev" target="_blank" rel="noopener noreferrer" aria-label="PRNext website (opens in a new tab)">
          <img src="/prnext-mark.png" width="32" height="32" alt="" />
          <span>PRNext</span>
          <span className="welcome-tag">Starter</span>
        </a>
        <a className="welcome-repository" href="https://github.com/Lorkydey/PRNext" target="_blank" rel="noopener noreferrer" aria-label="PRNext on GitHub (opens in a new tab)">GitHub <Arrow /></a>
      </header>

      <main id="main">
        <section className="welcome-hero" aria-labelledby="welcome-title">
          <div className="welcome-mark" aria-hidden="true">
            <span className="welcome-orbit" />
            <img src="/prnext-mark.png" width="160" height="160" alt="" fetchPriority="high" />
          </div>
          <p className="welcome-ready"><span />Your app is ready</p>
          <h1 id="welcome-title">Your next idea.<br /><span>Starts here.</span></h1>
          <p className="welcome-description">Your PRNext app is up and running.<br />Make this canvas your own.</p>
          <div className="welcome-actions">
            <a className="welcome-button welcome-primary" href="https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/quickstart.md" target="_blank" rel="noopener noreferrer" aria-label="Read the docs (opens in a new tab)">Read the docs <Arrow /></a>
            <a className="welcome-button welcome-secondary" href="https://prnext.dev" target="_blank" rel="noopener noreferrer" aria-label="Explore PRNext (opens in a new tab)">Explore PRNext <Arrow /></a>
          </div>
        </section>

        <section className="welcome-steps" aria-label="Your next steps">
          <div className="welcome-step welcome-edit">
            <p className="welcome-step-label"><span>01</span> Make it yours</p>
            <h2><code>app/page.${extension}</code></h2>
            <p>Open this file, make a change, and save.</p>
          </div>
          <div className="welcome-step">
            <p className="welcome-step-label"><span>02</span> Build your app</p>
            <h2>Ready for production?</h2>
            <code className="welcome-command"><span aria-hidden="true">$</span> npm run build</code>
          </div>
          <div className="welcome-step">
            <p className="welcome-step-label"><span>03</span> Take it live</p>
            <h2>Run your production build.</h2>
            <code className="welcome-command"><span aria-hidden="true">$</span> npm start</code>
          </div>
        </section>
      </main>

      <footer className="welcome-footer">
        <p>React on the surface. Rust underneath.</p>
        <p>Built with <a href="https://prnext.dev" target="_blank" rel="noopener noreferrer" aria-label="PRNext website (opens in a new tab)">PRNext <Arrow /></a></p>
      </footer>
    </div>
  );
}
`;
}

export const starterStyles = `:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #08080b;
  color: #f2f1f6;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
body { margin: 0; }
a { color: inherit; text-decoration: none; }
button, a { -webkit-tap-highlight-color: transparent; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
::selection { background: #7960ad66; color: #fff; }
a:focus-visible { outline: 2px solid #c5b4f3; outline-offset: 5px; }
.welcome { position: relative; isolation: isolate; min-height: 100svh; display: flex; flex-direction: column; }
.welcome::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse 640px 440px at 50% 20%, #7655b51c, transparent 75%), linear-gradient(#ffffff04 1px, transparent 1px), linear-gradient(90deg, #ffffff04 1px, transparent 1px);
  background-size: auto, 64px 64px, 64px 64px;
  mask-image: linear-gradient(#000, #0009 65%, transparent);
}
.welcome-header, .welcome-footer { width: min(1120px, 100%); margin-inline: auto; padding-inline: 32px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.welcome-header { padding-block: 24px; }
.welcome-brand { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-size: 18px; font-weight: 650; letter-spacing: -.04em; border-radius: 8px; }
.welcome-brand img { display: block; object-fit: contain; }
.welcome-tag { margin-inline-start: 6px; padding: 3px 7px; border: 1px solid #33303d; border-radius: 5px; color: #b4adbf; font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .03em; }
.welcome-repository { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; font-size: 13px; color: #b4afbf; border-radius: 6px; }
.welcome svg { width: 16px; height: 16px; flex: none; }
.welcome-repository svg { width: 14px; height: 14px; }
.welcome-repository:hover, .welcome-footer a:hover { color: #fff; }
.welcome main { width: min(1040px, 100%); margin-inline: auto; padding: 0 32px; flex: 1; }
.welcome-hero { padding: 34px 0 54px; text-align: center; }
.welcome-mark { position: relative; isolation: isolate; display: grid; place-items: center; width: 136px; height: 136px; margin: 0 auto 28px; border: 1px solid #37303f; border-radius: 34px; background: #0b0a10; box-shadow: 0 20px 60px #0008, 0 0 72px #8660c51a, inset 0 1px 0 #ffffff08; }
.welcome-mark > img { display: block; width: 112px; height: 112px; object-fit: contain; }
.welcome-orbit { position: absolute; inset: -1px; padding: 1px; border-radius: inherit; overflow: hidden; pointer-events: none; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; }
.welcome-orbit::before { content: ''; position: absolute; top: 50%; left: 50%; width: 200%; aspect-ratio: 1; background: conic-gradient(transparent 0deg 245deg, #9172c52b 280deg, #b49bd0b3 320deg, #e0d1f5 350deg, transparent 360deg); transform: translate(-50%, -50%) rotate(30deg); }
.welcome-ready { display: inline-flex; align-items: center; gap: 7px; margin: 0 0 19px; color: #b1a9c1; font-size: 12px; line-height: 1.5; }
.welcome-ready > span { width: 5px; height: 5px; border-radius: 50%; background: #bca4e6; box-shadow: 0 0 10px #b69bdf55; }
.welcome h1 { margin: 0; font-size: clamp(42px, 6.4vw, 76px); line-height: 1.04; letter-spacing: -.065em; font-weight: 650; text-wrap: balance; }
.welcome h1 > span { color: #b4a1d3; background: linear-gradient(110deg, #e0d7ee 5%, #b39bd4 55%, #897b9f); background-clip: text; -webkit-text-fill-color: transparent; }
.welcome-description { margin: 23px auto 0; max-width: 42ch; color: #a6a0b1; font-size: 16px; line-height: 1.65; text-wrap: pretty; }
.welcome-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; margin-top: 27px; }
.welcome-button { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; gap: 12px; padding: 11px 17px; border: 1px solid transparent; border-radius: 10px; font-size: 13px; line-height: 1.5; font-weight: 550; }
.welcome-primary { background: #eeebf2; color: #15121a; box-shadow: inset 0 1px 0 #fff, 0 2px 8px #0004; }
.welcome-primary:hover { background: #fff; }
.welcome-secondary { background: #101015; border-color: #3e354b; color: #ddd5e8; }
.welcome-secondary:hover { background: #17131e; border-color: #7c6a93; }
.welcome-steps { display: grid; grid-template-columns: 1.25fr 1fr 1fr; border: 1px solid #29252f; border-radius: 16px; background: #101015bd; box-shadow: inset 0 1px 0 #ffffff03; }
.welcome-step { min-width: 0; padding: 23px 25px 25px; }
.welcome-step + .welcome-step { border-inline-start: 1px solid #29252f; }
.welcome-step-label { display: flex; align-items: center; gap: 10px; margin: 0 0 17px; color: #a39bae; font-size: 11px; line-height: 1.5; }
.welcome-step-label > span { color: #b7a4ce; font: 10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
.welcome h2 { margin: 0 0 8px; font-size: 13px; line-height: 1.5; font-weight: 500; color: #ddd7e6; }
.welcome-edit h2 { font-size: 15px; }
.welcome-step > p:last-child { margin: 0; color: #a39baa; font-size: 12px; line-height: 1.6; text-wrap: pretty; }
.welcome-command { color: #c3b8ce; font-size: 12px; line-height: 1.6; }
.welcome-command > span { margin-inline-end: 6px; color: #a39baa; }
.welcome-footer { padding-block: 36px 25px; color: #a39baa; font-size: 11px; line-height: 1.6; }
.welcome-footer p { margin: 0; }
.welcome-footer a { display: inline-flex; align-items: center; gap: 5px; min-height: 44px; border-radius: 4px; color: #d1c8dd; }
.welcome-footer svg { width: 12px; height: 12px; }
.skip-link { position: absolute; inset-block-start: 12px; inset-inline-start: 12px; z-index: 5; padding: 10px 16px; border-radius: 8px; background: #eee; color: #111; transform: translateY(-160%); }
.skip-link:focus { transform: none; }
@media (max-width: 700px) {
  .welcome-header, .welcome-footer { padding-inline: 24px; }
  .welcome main { padding-inline: 24px; }
  .welcome-hero { padding-top: 28px; padding-bottom: 42px; }
  .welcome-mark { width: 112px; height: 112px; border-radius: 28px; margin-bottom: 24px; }
  .welcome-mark > img { width: 94px; height: 94px; }
  .welcome-steps { grid-template-columns: 1fr; }
  .welcome-step { padding: 21px 23px; }
  .welcome-step + .welcome-step { border-inline-start: 0; border-block-start: 1px solid #29252f; }
  .welcome-step-label { margin-bottom: 10px; }
  .welcome-footer { flex-direction: column; align-items: flex-start; gap: 0; padding-block: 25px 20px; }
}
@media (max-width: 380px) {
  .welcome-header, .welcome-footer, .welcome main { padding-inline: 20px; }
  .welcome-tag { display: none; }
  .welcome h1 { font-size: 40px; }
  .welcome-description { font-size: 15px; }
  .welcome-actions { flex-direction: column; }
}
@media (prefers-reduced-motion: no-preference) {
  .welcome-orbit::before { animation: welcome-orbit 8s linear infinite; }
  .welcome-button, .welcome-repository, .welcome-footer a { transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out; }
  @keyframes welcome-orbit { to { transform: translate(-50%, -50%) rotate(390deg); } }
}
@media (forced-colors: active) {
  :root { background: Canvas; color: CanvasText; }
  .welcome::before, .welcome-orbit, .welcome-ready > span { display: none; }
  .welcome h1 > span { background: none; color: CanvasText; -webkit-text-fill-color: currentColor; }
  .welcome-mark { forced-color-adjust: none; background: #080808; border-color: #777; box-shadow: none; }
  .welcome-brand img { forced-color-adjust: none; background: #080808; border-radius: 6px; }
  .welcome-steps, .welcome-step + .welcome-step, .welcome-tag { border-color: CanvasText; }
  .welcome-button { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  a:focus-visible { outline-color: Highlight; }
}
`;
