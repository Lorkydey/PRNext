// Development-only inspector surfaces. No styles escape the tools' shadow root.
export const devAiStyle = `
  dialog.wb-tools[data-panel=ai]{width:min(420px,calc(100vw - 32px));height:fit-content;max-height:calc(100dvh - 48px)}
  dialog.wb-tools[data-panel=ai][data-selection=true]{width:min(560px,calc(100vw - 32px))}
  [data-panel=ai] .wb-tools-content{padding:48px 20px 20px;flex:0 1 auto;max-height:calc(100dvh - 48px);overscroll-behavior:contain}
  [data-panel=ai] .wb-head{display:contents}
  [data-panel=ai] .wb-head>:not(.wb-close),[data-panel=ai] .wb-tools-nav,[data-panel=ai] .wb-tools-search,[data-panel=ai] .wb-ai-hero{display:none}
  [data-panel=ai] .wb-close{position:absolute;top:8px;right:8px;z-index:2;width:34px;min-height:34px;background:#080808;color:#999}
  [data-panel=ai] .wb-close:hover{color:#fff;background:#191919}
  [data-panel=ai] .wb-tools-feedback{padding:0 20px 16px;font-size:11px;overflow-wrap:anywhere}
  [data-panel=ai] [hidden]{display:none!important}
  .wb-ai-layout{display:block;width:100%;margin:0 auto;min-width:0}
  .wb-ai-layout>*{min-width:0}.wb-ai-has-selection{max-width:none}
  .wb-ai-connect{min-width:0}
  .wb-ai-connect>.wb-host-error{margin:8px 0 0;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
  .wb-ai-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:5px 10px;margin-bottom:16px}
  .wb-ai-heading{margin:0;font-size:14px;font-weight:550;letter-spacing:-.02em;line-height:1.4}
  .wb-ai-description{grid-column:1/-1;color:#999;font-size:11px;line-height:1.6;margin:0}
  .wb-ai-status{display:inline-flex;align-items:center;gap:6px;grid-column:2;grid-row:1;font-size:10px;white-space:nowrap;color:#999}
  .wb-ai-status i{width:5px;height:5px;border-radius:50%;background:#777;flex:none}
  .wb-ai-status[data-connected=true]{color:#a8dabd}.wb-ai-status[data-connected=true] i{background:#87d5a8}
  .wb-ai-layout[data-connected=true] .wb-ai-hero{margin-bottom:0}
  .wb-ai-setup{margin:0;min-width:0}
  .wb-ai-layout[data-connected=true] .wb-ai-setup{margin-top:0}
  .wb-ai-setup>summary{display:flex;align-items:center;gap:8px;min-height:32px;list-style:none;color:#8e8e8e;font-size:10px;cursor:pointer;user-select:none}
  .wb-ai-setup>summary::-webkit-details-marker{display:none}
  .wb-ai-setup>summary::after{content:'';width:5px;height:5px;margin-left:auto;border-right:1px solid currentColor;border-bottom:1px solid currentColor;rotate:45deg;translate:0 -2px}
  .wb-ai-setup[open]>summary::after{rotate:225deg;translate:0 1px}
  .wb-ai-setup>summary:hover{color:#ddd}
  .wb-ai-setup-content{min-width:0}
  .wb-ai-layout[data-connected=true] .wb-ai-setup-content{padding-top:0}
  .wb-ai-workspace{min-width:0;margin:0;padding:0;border:0}
  .wb-ai-ready{display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0 8px;text-align:center}
  .wb-ai-ready p{max-width:340px;margin:0;color:#888;font-size:11px;line-height:1.6;text-wrap:pretty}
  .wb .wb-ai-select{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 13px;border-radius:8px;background:#ededed;color:#0c0c0c;font-size:11px;font-weight:550}
  .wb .wb-ai-select:hover:not(:disabled){background:#d6d6d6;color:#080808}.wb-ai-select svg{width:15px;height:15px}
  .wb-host-connect{padding:0;background:transparent}
  .wb-host-heading{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px}.wb-host-heading svg{width:14px;height:14px;color:#999}
  .wb-host-heading strong{font-weight:500}.wb-host-state{display:none}
  .wb-host-command{display:flex;align-items:center;gap:8px;margin-top:8px;min-width:0;background:#111;border-radius:8px;padding:3px 3px 3px 10px}
  .wb-host-command code{min-width:0;flex:1;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#ddd}
  .wb .wb-host-copy{display:grid;place-items:center;flex:none;width:34px;padding:6px;color:#999}.wb-host-copy svg{width:14px;height:14px}
  .wb-host-note{color:#888;font-size:10px;line-height:1.6;margin:6px 0 0}
  .wb-ai-divider{margin:16px 0 8px;color:#888;font-size:10px}
  .wb-ai-clients{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;padding:3px;border-radius:10px;background:#111}
  .wb .wb-ai-client{display:flex;align-items:center;justify-content:center;gap:7px;min-width:0;min-height:40px;padding:8px 6px;border:0;border-radius:7px;background:transparent;color:#aaa}
  .wb .wb-ai-client:hover:not(:disabled){background:#1b1b1b;color:#fff}
  .wb .wb-ai-client[aria-pressed=true]{background:#262626;color:#fff}
  .wb-ai-client-logo{display:grid;place-items:center;width:20px;height:20px}.wb-ai-client-logo svg{width:20px;height:20px}
  .wb-ai-client-label{font-size:11px;font-weight:500}.wb-ai-client-check{display:none}
  .wb-ai-client:disabled{opacity:.5;cursor:default}
  .wb .wb-ai-other{display:flex;align-items:center;justify-content:center;gap:6px;margin:4px 0 0 auto;min-height:28px;padding:4px 7px;color:#888;font-size:10px}
  .wb-ai-other svg{width:13px;height:13px}.wb-ai-other[aria-pressed=true]{color:#eee;background:#191919}
  .wb-local-setup{margin-top:8px;padding:0}
  .wb-local-setup summary{display:flex;align-items:center;gap:8px;list-style:none;min-height:28px;color:#aaa;font-size:11px;cursor:pointer}
  .wb-local-setup summary::-webkit-details-marker{display:none}.wb-local-setup summary::after{content:'';width:5px;height:5px;margin-left:auto;border-right:1px solid currentColor;border-bottom:1px solid currentColor;rotate:45deg;translate:0 -2px}
  .wb-local-setup[open] summary::after{rotate:225deg;translate:0 1px}
  .wb-mcp-reveal,.wb-mcp-help-reveal{height:0;min-width:0;overflow:hidden;opacity:0}
  .wb-mcp-reveal[data-expanded=true],.wb-mcp-help-reveal[data-expanded=true]{opacity:1}
  .wb-mcp-content{min-width:0;padding-top:8px;opacity:1}.wb-mcp-content[data-swapping=true]{opacity:.35}
  .wb-local-setup .wb-mcp-controls{justify-content:space-between;align-items:center;flex-wrap:nowrap;gap:8px;margin:0;min-width:0}.wb-mcp-format{font-size:10px;color:#999}
  .wb .wb-mcp-help-toggle{display:grid;place-items:center;flex:none;width:28px;min-height:28px;padding:0;border-radius:7px;color:#999;background:transparent;font-size:11px}
  .wb .wb-mcp-help-toggle:hover,.wb .wb-mcp-help-toggle[aria-expanded=true]{background:#191919;color:#ddd}.wb-mcp-help-toggle svg{width:14px;height:14px}
  .wb-mcp-help{padding:7px 0 1px;color:#999;font-size:10px;line-height:1.6;overflow-wrap:anywhere}.wb-mcp-help p{margin:0}.wb-mcp-help a{display:inline-flex;align-items:center;gap:4px;min-height:28px;color:#c3b9f1;text-decoration:none;text-underline-offset:3px}.wb-mcp-help a:hover{text-decoration:underline}
  .wb-mcp-snippet{display:grid;grid-template-columns:minmax(0,1fr) 34px;align-items:center;gap:6px;min-width:0;margin-top:8px}
  .wb .wb-config-copy{display:grid;place-items:center;align-self:center;width:34px;height:34px;min-height:34px;padding:0;border-radius:8px;color:#999;background:transparent}.wb .wb-config-copy:hover{color:#eee;background:#191919}.wb-config-copy svg{width:14px;height:14px}
  .wb-local-setup pre.wb-mcp-code{width:100%;height:83px;min-height:83px;max-height:83px;margin:0;padding:10px;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;font:10px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:#bcbcbc;background:#101010;border-radius:8px;scrollbar-width:thin;scrollbar-color:#333 #101010}
  .wb-component-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:15px}.wb-component-identity{display:flex;align-items:center;gap:10px;min-width:0}.wb-component-identity>div{min-width:0}
  .wb-component-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#b7c3ff12;color:#c4ccff;flex:none}.wb-component-mark svg{width:20px;height:20px}
  .wb-component h3{margin:0 0 3px;font-size:14px;letter-spacing:-.02em;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wb-component-kind{display:block;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#929292;font-variant-numeric:tabular-nums}
  .wb .wb-component-reselect{display:flex;align-items:center;gap:6px;flex:none;padding:6px 8px;color:#999;font-size:10px}.wb-component-reselect svg{width:14px;height:14px}
  .wb-component-visual{display:grid;place-items:center;position:relative;min-height:135px;max-height:190px;overflow:auto;isolation:isolate;border-radius:12px;background:#101010;box-shadow:inset 0 0 0 1px #ffffff08;padding:20px}
  .wb-component-visual .wb-selection-image{display:block;max-width:100%;max-height:150px;object-fit:contain;object-position:center;margin:0;border-radius:4px}
  .wb-component-visual [hidden]{display:none!important}.wb-component-placeholder{font-size:11px;color:#888;text-align:center;overflow-wrap:anywhere}
  .wb-component-visual[data-state=error]{place-items:start;background:#e14a580b;color:#ffa2ac;min-height:90px}.wb-component-visual[data-state=error] .wb-component-placeholder{color:#ffa2ac;text-align:left;font:11px/1.65 ui-monospace,monospace}
  .wb-component-source{display:flex;align-items:center;gap:10px;min-width:0;margin:11px 0 18px}.wb-component-location{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#909090;font:10px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
  .wb-component-editor{display:inline-flex;align-items:center;min-height:28px;text-decoration:none;color:#aaa;font-size:10px;white-space:nowrap}.wb-component-editor:hover{color:#eee}.wb-component-editor[hidden]{display:none}
  .wb-component-composer{border:1px solid #303030;border-radius:12px;overflow:hidden;background:#0c0c0c}
  .wb-component-label{display:flex;flex-direction:column;gap:9px;padding:13px 13px 0;font-size:12px;color:#ccc;font-weight:500}
  .wb-component-label textarea{display:block;width:100%;min-height:78px;max-height:200px;resize:vertical;margin:0;padding:0 1px;border:0;border-radius:0;background:transparent;color:#eee;font:12px/1.65 ui-sans-serif,system-ui;outline-offset:3px;scrollbar-color:#333 #0c0c0c}
  .wb-component-label textarea::placeholder{color:#666}.wb-component-label textarea:focus-visible{outline:0}
  .wb-component-composer:focus-within{border-color:#777;box-shadow:0 0 0 1px #777}
  .wb-component-compose-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px}.wb-component-parts{font-size:9px;color:#888;overflow-wrap:anywhere}
  .wb .wb-ai-primary{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:34px;padding:7px 11px;border-radius:8px;background:#ededed;color:#0c0c0c;font-size:11px;font-weight:600}
  .wb .wb-ai-primary:hover:not(:disabled){background:#d6d6d6;color:#080808}.wb-ai-primary svg{width:14px;height:14px}.wb .wb-ai-primary:disabled{opacity:.45;cursor:wait}
  .wb-component-details{margin-top:14px}.wb-component-details summary{color:#888;font-size:10px;cursor:pointer;min-height:28px;padding:4px 0}.wb-component-details pre{max-height:180px;overflow:auto;color:#aaa;background:#111;padding:12px;border-radius:9px;margin:8px 0;scrollbar-color:#333 #111}
  .wb-component-styles{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:5px 14px;font:10px/1.5 ui-monospace,monospace;color:#aaa;margin:12px 0}
  .wb-component-styles dt{color:#777;min-width:0;overflow-wrap:anywhere}.wb-component-styles dd{margin:0;min-width:0;overflow-wrap:anywhere;text-align:right}
  .wb-ai-verify{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid #202020;margin-top:16px;padding-top:12px}.wb-ai-verify strong{font-size:11px;font-weight:500;color:#bbb}.wb-ai-verify p{color:#777;font-size:10px;margin:3px 0 0}
  .wb .wb-ai-verify-button{display:inline-flex;align-items:center;gap:7px;background:transparent;flex:none;font-size:11px;color:#bbb}.wb-ai-verify-button svg{width:13px;height:13px}
  .wb-ai-layout button:focus-visible,.wb-ai-layout summary:focus-visible,.wb-ai-layout a:focus-visible{outline:2px solid #888;outline-offset:-3px}
  @media(max-width:740px){.wb-component-visual{min-height:110px}}
  @media(max-width:500px){dialog.wb-tools[data-panel=ai],dialog.wb-tools[data-panel=ai][data-selection=true]{width:calc(100vw - 16px);height:fit-content;max-height:calc(100dvh - 32px)}[data-panel=ai] .wb-tools-content{padding:48px 14px 18px;max-height:calc(100dvh - 32px)}[data-panel=ai] .wb-tools-feedback{padding:0 14px 14px}.wb-component-compose-foot{gap:10px}.wb-component-parts{width:100%}.wb .wb-ai-primary{width:100%}.wb-ai-verify{gap:10px}.wb-ai-verify p{max-width:150px}.wb-mcp-controls{align-items:flex-start}.wb-component-reselect{font-size:0!important;gap:0!important}.wb-component-reselect svg{width:17px;height:17px}.wb-component-identity{gap:8px}.wb-component-location{font-size:9px}}
  @media(pointer:coarse){[data-panel=ai] .wb-tools-content{padding-top:60px}[data-panel=ai] .wb-close,.wb .wb-host-copy,.wb .wb-config-copy,.wb .wb-mcp-help-toggle{width:44px;min-height:44px}.wb-mcp-snippet{grid-template-columns:minmax(0,1fr) 44px}.wb-mcp-help a{min-height:44px}.wb .wb-ai-client,.wb .wb-config-copy,.wb .wb-ai-other,.wb-local-setup summary,.wb-ai-setup>summary,.wb-component-details summary,.wb-component-editor,.wb .wb-component-reselect,.wb .wb-ai-primary,.wb .wb-ai-select,.wb .wb-ai-verify-button{min-height:44px}.wb .wb-component-reselect{min-width:44px;justify-content:center}.wb-component-label textarea{font-size:16px}}
  @media(prefers-reduced-motion:no-preference){.wb .wb-ai-client,.wb .wb-ai-select,.wb-ai-setup>summary{transition:background-color 120ms,color 120ms}.wb-component-composer{transition:border-color 120ms,box-shadow 120ms}.wb-mcp-reveal,.wb-mcp-help-reveal{transition:height 220ms ease-out,opacity 160ms ease-out}.wb-mcp-content{transition:opacity 120ms ease-out}}
  @media(prefers-reduced-motion:reduce){.wb-mcp-reveal,.wb-mcp-help-reveal,.wb-mcp-content{transition:none!important}}
  @media(forced-colors:active){.wb-component-visual{border:1px solid CanvasText}.wb-ai-clients{background:Canvas}.wb .wb-ai-client{border:1px solid ButtonText}.wb .wb-ai-client[aria-pressed=true]{outline:2px solid Highlight;outline-offset:-2px}.wb-component-mark{color:ButtonText}.wb .wb-ai-primary,.wb .wb-ai-select{background:ButtonFace;color:ButtonText;border:1px solid ButtonText}.wb .wb-mcp-help-toggle[aria-expanded=true]{outline:1px solid Highlight;outline-offset:-2px}.wb-mcp-help a{color:LinkText}.wb-ai-workspace,.wb-ai-verify{border-color:CanvasText}.wb-component-composer:focus-within{border-color:Highlight;outline:2px solid Highlight}.wb-ai-layout button:focus-visible,.wb-ai-layout summary:focus-visible,.wb-ai-layout a:focus-visible{outline-color:Highlight}}
`;
