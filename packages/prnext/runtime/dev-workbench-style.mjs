// Shared by embedded and detached tools; neutral surfaces match the logo menu.
export const workbenchStyle = `
  .wb{color-scheme:dark;color:#ededed;font:12px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;box-sizing:border-box}
  .wb *,.wb *::before,.wb *::after{box-sizing:border-box}
  .wb button,.wb input,.wb select{font:inherit;color:inherit}
  .wb button,.wb select{cursor:pointer}
  .wb button{border:0;border-radius:8px;background:transparent;padding:6px 10px;min-height:34px;white-space:nowrap}
  .wb button:hover{background:#191919}.wb button[aria-pressed=true]{background:#232323;color:#fff}
  .wb button:focus-visible,.wb input:focus-visible,.wb select:focus-visible,.wb summary:focus-visible,.wb [tabindex]:focus-visible{outline:1px solid #929292;outline-offset:-2px}
  .wb svg{width:16px;height:16px;flex:none}
  .wb .wb-close{display:grid;place-items:center;width:34px;padding:0}.wb .wb-push{margin-left:auto}
  .wb .wb-popout,.wb .wb-icon{display:grid;place-items:center;width:34px;padding:6px;color:#aaa}
  .wb .wb-popout:hover,.wb .wb-icon:hover{color:#fff}.wb button[aria-pressed=true]{color:#fff}
  .wb-popup-feedback{padding:6px 10px;color:#e9c58b;font-size:11px}
  .wb-console{position:fixed;left:18px;bottom:74px;width:min(820px,calc(100vw - 36px));height:min(350px,calc(100dvh - 110px));min-height:180px;display:flex;flex-direction:column;background:#080808;border:1px solid #292929;border-radius:14px;box-shadow:0 12px 40px #0008;overflow:hidden;container-type:inline-size}
  .wb-head,.wb-filters{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid #202020;flex:none;min-width:0}
  .wb-filters{flex-direction:column;align-items:stretch;gap:8px;padding:10px}.wb-title{font-weight:600}
  .wb .wb-pause{position:relative}.wb-pause svg{grid-area:1/1}.wb-pause .wb-resume-icon{opacity:0;scale:.25;filter:blur(4px)}
  .wb-pause[aria-pressed=true] .wb-pause-icon{opacity:0;scale:.25;filter:blur(4px)}.wb-pause[aria-pressed=true] .wb-resume-icon{opacity:1;scale:1;filter:blur(0)}
  .wb-search-row,.wb-filter-row,.wb-filter-options,.wb-console-utilities{display:flex;align-items:center;gap:6px;min-width:0}
  .wb-search{position:relative;flex:1;min-width:0}.wb-search>svg{position:absolute;left:10px;top:50%;translate:0 -50%;width:14px;height:14px;color:#888;pointer-events:none}
  .wb-filters input{display:block;width:100%;min-width:0;border:1px solid #292929;border-radius:8px;padding:6px 9px 6px 30px;background:#111;min-height:34px}
  .wb-console-utilities{flex:none;gap:2px}.wb-console-utilities button{min-width:48px;color:#aaa}.wb-console-utilities button:hover{color:#ededed}
  .wb-filter-options{flex:1;flex-wrap:wrap}.wb-filter-row{justify-content:space-between;gap:10px}
  .wb-filters select{border:1px solid #292929;border-radius:8px;padding:6px;background:#111;max-width:110px;min-height:34px}.wb-copy{font-size:11px}
  .wb-logs{overflow:auto;overscroll-behavior:contain;flex:1;min-height:0;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;scrollbar-color:#333 #080808}
  .wb-line{display:grid;grid-template-columns:65px 43px minmax(0,1fr);gap:10px;padding:7px 12px;border-bottom:1px solid #ffffff08}
  .wb-line time,.wb-level{color:#999}.wb-line pre{margin:0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
  .wb-line[data-level=error]{background:#ce3c4a0e;color:#ffa2ac}.wb-line[data-level=warn]{background:#e6b45a0a;color:#e9c58b}
  .wb-line[data-level=error] .wb-level{color:#ffa2ac}.wb-line[data-level=warn] .wb-level{color:#e9c58b}
  .wb-empty{padding:24px;text-align:center;color:#999}.wb-foot{display:flex;gap:10px;flex-wrap:wrap;padding:6px 12px;color:#999;border-top:1px solid #202020;font-size:11px}
  .wb-entry{border-bottom:1px solid #ffffff08}.wb-entry summary{list-style:none;cursor:pointer;border:0;grid-template-columns:65px 43px minmax(0,1fr) 14px}
  .wb-entry summary::-webkit-details-marker{display:none}.wb-message{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .wb-entry[open] .wb-message{-webkit-line-clamp:1}.wb-entry-caret svg{width:13px;height:16px;color:#888}.wb-entry[open] .wb-entry-caret svg{rotate:180deg}.wb-entry:hover{background:#ffffff04}
  .wb-entry-actions{display:flex;gap:6px;padding:6px 12px 8px 130px}.wb-entry-actions button{display:inline-flex;align-items:center;gap:6px;font:11px/1.5 ui-sans-serif,system-ui;background:#161616}.wb-entry-actions svg{width:13px;height:13px}
  .wb-entry-full{margin:0;padding:0 12px 12px 130px;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
  .wb-ai{display:flex;align-items:stretch;flex:none;margin-left:auto;border-radius:8px;background:#191919}
  .wb-ai button{display:flex;align-items:center;justify-content:center;gap:7px;font-weight:600}.wb-ai button:disabled{opacity:.5;cursor:default}
  .wb-ai-main{border-radius:8px 0 0 8px!important}.wb-ai-toggle{width:28px;padding:4px!important;border-radius:0 8px 8px 0!important}.wb-ai svg{width:14px;height:14px}
  .wb-ai-menu{position:fixed;inset:auto;margin:0;min-width:220px;max-width:calc(100vw - 16px);padding:5px;border:1px solid #292929;border-radius:11px;background:#080808;color:#ededed;box-shadow:0 10px 30px #0008;z-index:2147483647}
  .wb-ai-menu button{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;text-align:left;font-size:12px}.wb-ai-menu button:disabled{opacity:.45;cursor:default}.wb-ai-menu::backdrop{background:transparent}
  dialog.wb-preview{position:fixed;inset:12px;width:calc(100vw - 24px);height:calc(100dvh - 24px);max-width:none;max-height:none;padding:0;margin:0;border:0;border-radius:12px;background:#080808;box-shadow:0 12px 40px #0008;overflow:hidden;overscroll-behavior:contain}
  dialog.wb-preview[open]{display:flex;flex-direction:column}dialog.wb-preview::backdrop{background:#000b}
  .wb-preview-head{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:10px 12px;border-bottom:1px solid #202020;flex:none}
  .wb-devices{display:flex;gap:2px;padding:3px;background:#111;border-radius:11px}
  .wb-devices .wb-device{position:relative;display:grid;place-items:center;width:34px;height:34px;padding:0;border-radius:8px;color:#999}
  .wb-device[aria-pressed=true]{background:#272727;color:#fff;box-shadow:inset 0 0 0 1px #ffffff15}
  .wb-tooltip{position:fixed;inset:auto;margin:0;width:max-content;max-width:calc(100vw - 16px);padding:7px 10px;gap:9px;align-items:center;background:#111;color:#ededed;border:1px solid #ffffff12;border-radius:8px;box-shadow:0 4px 16px #0007;font-size:11px;line-height:16px;opacity:0;translate:0 -3px;overflow-wrap:anywhere;z-index:2147483647}
  .wb-tooltip:popover-open{display:flex}.wb-tooltip:not(:popover-open){display:none}.wb-tooltip::backdrop{background:transparent;pointer-events:none}
  .wb-tooltip[data-side=top]{translate:0 3px}.wb-tooltip[data-open=true]{opacity:1;translate:0 0}
  .wb-tooltip-label{font-weight:550;min-width:0}.wb-tooltip-detail{min-width:0;color:#929292;font:10px/16px ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}
  .wb-dimensions{font:11px ui-monospace,monospace;color:#999;font-variant-numeric:tabular-nums}
  .wb-preview-actions{display:flex;align-items:center;gap:2px;margin-left:auto;flex:none}
  .wb .wb-frame-toggle{display:flex;align-items:center;justify-content:center;gap:6px;width:auto;padding:6px 9px}
  .wb-preview .wb-console{position:relative;left:auto;bottom:auto;width:100%;height:min(300px,42dvh);min-height:140px;flex:none;border:0;border-top:1px solid #292929;border-radius:0;box-shadow:none}
  .wb-preview-note{display:flex;align-items:center;padding:7px 12px;color:#aaa;font-size:11px;border-top:1px solid #202020}
  .wb-preview-note span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wb-stage{position:relative;flex:1;min-height:0;overflow:hidden;background:#080808}
  .wb-frame-wrap{position:absolute;background:#101010;isolation:isolate;box-shadow:none}
  .wb-frame-wrap[data-frame=true]::before{content:'';position:absolute;inset:0;z-index:3;border:1px solid #303030;border-radius:inherit;pointer-events:none}
  .wb-frame-wrap[data-frame=false]{box-shadow:none;background:transparent}
  .wb-screen{position:absolute;overflow:hidden;isolation:isolate;z-index:1;line-height:0;background:#080808;border:0;outline:0;box-shadow:none}
  .wb-frame{position:absolute;left:0;top:0;display:block;border:0;border-radius:0;outline:0;box-shadow:none;transform-origin:top left;background:transparent}
  .wb .wb-frame:focus-visible{outline:0}
  .wb-device-top,.wb-device-home{position:absolute;pointer-events:none;z-index:2}
  .wb-frame-wrap[data-frame=false] .wb-device-top,.wb-frame-wrap[data-frame=false] .wb-device-home{display:none}
  .wb-device-top{left:50%;top:calc(4px * var(--s));translate:-50% 0;width:calc(68px * var(--s));height:calc(4px * var(--s));background:transparent}
  .wb-device-top::before,.wb-device-top::after{content:'';position:absolute;border-radius:999px;background:#292929}
  .wb-device-top::before{left:calc(7px * var(--s));top:calc(1px * var(--s));width:calc(42px * var(--s));height:calc(2px * var(--s))}
  .wb-device-top::after{right:calc(7px * var(--s));top:0;width:calc(4px * var(--s));height:calc(4px * var(--s));background:#222}
  .wb-device-home{bottom:calc(4px * var(--s));left:50%;translate:-50% 0;width:calc(88px * var(--s));height:calc(3px * var(--s));border-radius:99px;background:#555}
  .wb-frame-wrap[data-device=tablet] .wb-device-top{width:calc(4px * var(--s));height:calc(4px * var(--s));top:calc(7px * var(--s));border-radius:50%;background:#292929}
  .wb-frame-wrap[data-device=tablet] .wb-device-top::before,.wb-frame-wrap[data-device=tablet] .wb-device-top::after{display:none}
  .wb-frame-wrap[data-device=tablet] .wb-device-home{display:none}
  .wb-frame-wrap[data-device=phone][data-rotated=true] .wb-device-top{left:calc(4px * var(--s));top:50%;translate:0 -50%;width:calc(4px * var(--s));height:calc(68px * var(--s))}
  .wb-frame-wrap[data-device=phone][data-rotated=true] .wb-device-top::before{left:calc(1px * var(--s));top:calc(19px * var(--s));width:calc(2px * var(--s));height:calc(42px * var(--s))}
  .wb-frame-wrap[data-device=phone][data-rotated=true] .wb-device-top::after{left:0;right:auto;top:calc(7px * var(--s));bottom:auto}
  .wb-frame-wrap[data-device=phone][data-rotated=true] .wb-device-home{bottom:auto;left:auto;right:calc(4px * var(--s));top:50%;translate:0 -50%;width:calc(3px * var(--s));height:calc(88px * var(--s))}
  .wb-frame-wrap[data-device=tablet][data-rotated=true] .wb-device-top{left:calc(7px * var(--s));top:50%;translate:0 -50%}
  .wb-frame-wrap[data-frame=true][data-device=desktop] .wb-device-top{left:0;top:0;translate:0;width:100%;height:calc(32px * var(--s));display:flex;align-items:center;gap:calc(5px * var(--s));padding:0 calc(12px * var(--s));border-radius:inherit;background:transparent}
  .wb-frame-wrap[data-device=desktop] .wb-device-top::before,.wb-frame-wrap[data-device=desktop] .wb-device-top::after{display:none}
  .wb-device-top i{display:none}.wb-frame-wrap[data-device=desktop] .wb-device-top i{display:block;width:calc(6px * var(--s));height:calc(6px * var(--s));border-radius:50%;background:#555}
  .wb-frame-wrap[data-device=desktop] .wb-device-home{display:none}
  .wb .wb-resize{position:absolute;right:-17px;top:50%;translate:0 -50%;width:26px;height:64px;padding:0;border-radius:8px;cursor:ew-resize;background:transparent!important;touch-action:none;display:grid;place-items:center;z-index:3}
  .wb-resize::before{content:'';width:3px;height:38px;border-radius:3px;background:#666}.wb-stage[data-resizing=true] iframe{pointer-events:none}.wb-stage[data-resizing=true]{cursor:ew-resize}
  dialog.wb-tools{inset:0;margin:auto;width:min(920px,calc(100vw - 32px));height:min(680px,calc(100dvh - 48px));max-width:none;max-height:none;padding:0;border:0;border-radius:14px;background:#080808;color:#ededed;box-shadow:0 18px 60px #000a;overflow:hidden;overscroll-behavior:contain}
  dialog.wb-tools[open]{display:flex;flex-direction:column}dialog.wb-tools::backdrop{background:#000b}
  .wb-tools-nav{display:flex;gap:3px;padding:7px 10px;overflow:auto;flex:none;border-bottom:1px solid #202020}.wb-tools-nav button{color:#aaa}.wb-tools-nav [aria-current=page]{background:#202020;color:#fff}
  .wb-editor-link{display:inline-flex;align-items:center;min-height:34px;padding:6px 10px;border-radius:8px;background:#191919;color:#ededed;text-decoration:none}.wb-editor-link:focus-visible{outline:1px solid #929292;outline-offset:-2px}
  .wb-mcp-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px}.wb-mcp-controls select{border:1px solid #292929;border-radius:7px;padding:7px 9px;background:#111;min-height:34px;max-width:100%}
  .wb-tools-search{margin:12px 14px 0;padding:8px 10px;background:#111;border:1px solid #292929;border-radius:8px;flex:none;min-width:0}
  .wb-tools-content{padding:14px;overflow:auto;min-height:0;flex:1;scrollbar-color:#333 #080808}.wb-tools-feedback{padding:8px 14px;font-size:12px;color:#ccc;flex:none}.wb-tools-feedback:empty{display:none}
  .wb-muted{color:#999;font-size:11px}.wb-truncate{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}.wb-tools-labels{padding:6px 10px;color:#999;font-size:11px}
  .wb-request-grid{display:grid;grid-template-columns:minmax(0,1fr) 65px 80px 60px;align-items:center;gap:12px}.wb-request{border-bottom:1px solid #ffffff09}.wb-request summary{list-style:none;cursor:pointer;padding:10px}.wb-request summary::-webkit-details-marker{display:none}.wb-request-path{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px ui-monospace,monospace}.wb-request-path b{font-weight:600;color:#aaa;margin-right:8px}.wb-error-text{color:#ffa2ac}.wb-request-info{padding:0 10px 12px}.wb-request-info pre,.wb-source-code{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace}
  .wb-tools-pair{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:5px 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.wb-tools-section{padding:8px 0 18px}.wb-tools-section+.wb-tools-section{border-top:1px solid #202020}.wb-tools-section h3{margin:4px 0 14px;font:600 13px/1.5 ui-sans-serif,system-ui}.wb-tools-section p{margin:8px 0 14px}
  .wb-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:6px 0 20px}.wb-metric{display:flex;flex-direction:column;gap:5px}.wb-metric strong{font-size:22px;font-weight:550;font-variant-numeric:tabular-nums}.wb-build{padding:8px 0;border-bottom:1px solid #ffffff09}.wb-build summary{display:flex;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.wb-build summary::-webkit-details-marker{display:none}.wb-build[open] summary{margin-bottom:12px}.wb-phase{display:grid;grid-template-columns:85px minmax(0,1fr) 70px;align-items:center;gap:10px;font-size:11px;padding:5px 0}.wb-phase-meter{height:4px;border-radius:4px;background:#202020;overflow:hidden}.wb-phase-meter::before{content:'';display:block;width:var(--amount);height:100%;border-radius:inherit;background:#999}
  .wb-cache-summary{display:flex;flex-wrap:wrap;gap:12px;padding-bottom:12px}.wb-cache-summary .wb-tools-pair{gap:8px}.wb-route{border-bottom:1px solid #ffffff09}.wb-route summary{display:flex;align-items:center;gap:12px;padding:12px 4px;cursor:pointer;list-style:none}.wb-route summary::-webkit-details-marker{display:none}.wb-route summary code{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px}.wb-route-actions{padding:0 4px 14px}.wb-route-param{display:inline-flex;flex-direction:column;gap:5px;margin:0 8px 12px 0;color:#aaa;font-size:11px;max-width:100%}.wb-route-param input{background:#111;border:1px solid #292929;border-radius:7px;padding:7px 9px;min-width:0;color:#eee}.wb-button-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.wb-button-row button,.wb-tools-section>button{background:#191919}.wb-context-source{display:block;overflow-wrap:anywhere}.wb-selection-text{color:#aaa;max-height:80px;overflow:auto;font-size:11px}.wb-selection-image{display:block;max-width:100%;max-height:180px;object-fit:contain;object-position:left;margin:10px 0;border-radius:6px}.wb-instruction{display:flex;flex-direction:column;gap:8px;margin:12px 0;font-size:11px;color:#aaa}.wb-instruction textarea{resize:vertical;min-height:70px;font:12px/1.5 ui-sans-serif,system-ui;background:#111;color:#eee;border:1px solid #292929;border-radius:8px;padding:9px}.wb-instruction textarea:focus-visible{outline:1px solid #929292;outline-offset:-2px}.wb-mcp-config{margin-top:10px}.wb-mcp-config summary{cursor:pointer;color:#999;font-size:11px}.wb-mcp-config pre{overflow:auto;font:11px/1.6 ui-monospace,monospace;background:#111;padding:10px;border-radius:8px}
  @media(max-width:500px){dialog.wb-tools{width:calc(100vw - 16px);height:calc(100dvh - 32px)}.wb-tools-content{padding:10px}.wb-tools-nav{padding:6px;gap:0}.wb-tools-nav button{padding:6px 8px}.wb-request-grid{grid-template-columns:minmax(0,1fr) 48px 58px;gap:5px}.wb-request-grid>:last-child{display:none}.wb-request-grid{font-size:11px}.wb-metrics{gap:8px}.wb-metric strong{font-size:17px}.wb-route summary{gap:8px}.wb-route summary>.wb-muted:last-child{display:none}}
  @media(min-width:1000px){dialog.wb-preview:has(>.wb-console:not([hidden])){display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,40%);grid-template-rows:auto minmax(0,1fr) auto}.wb-preview-head{grid-column:1/-1}.wb-stage{grid-column:1;grid-row:2}.wb-preview-note{grid-column:1;grid-row:3}.wb-preview .wb-console{grid-column:2;grid-row:2/4;height:100%;min-height:0;border-top:0;border-left:1px solid #292929}}
  @media(max-width:640px){.wb-preview-head{gap:6px;padding:7px 8px}.wb-dimensions{margin-left:auto}.wb-preview-actions{width:100%;justify-content:flex-end}.wb-preview-actions .wb-preview-reload{margin-right:auto}.wb .wb-frame-toggle{width:34px;padding:6px}.wb-frame-toggle span{display:none}}
  @media(max-width:500px){.wb-console{left:8px;bottom:70px;width:calc(100vw - 16px)}.wb-line,.wb-entry summary{grid-template-columns:38px minmax(0,1fr) 14px;gap:8px}.wb-line time{display:none}.wb-entry-actions,.wb-entry-full{padding-left:12px}.wb-copy{max-width:70px}}
  @container(max-width:359px){.wb-filter-row{gap:6px}.wb-ai-main [data-copy-label]{display:none}.wb-ai .wb-ai-main{min-width:34px;padding:6px}.wb-filter-options{gap:6px}.wb-filters select{flex:1;min-width:0;max-width:none}.wb-console-utilities button{padding:6px 8px}}
  @media(pointer:coarse){.wb button,.wb input,.wb select{min-height:44px}.wb .wb-close,.wb .wb-icon,.wb .wb-popout,.wb-devices .wb-device{width:44px}.wb-frame-toggle span{display:none}}
  @media(prefers-reduced-motion:no-preference){.wb button{transition:background-color 120ms,color 120ms}.wb-pause svg{transition:opacity 180ms cubic-bezier(.2,0,0,1),scale 180ms cubic-bezier(.2,0,0,1),filter 180ms cubic-bezier(.2,0,0,1)}.wb-tooltip{transition:opacity 100ms ease-out,translate 100ms ease-out}.wb-console{animation:wb-enter 130ms ease-out}@keyframes wb-enter{from{opacity:0;translate:0 4px}to{opacity:1;translate:0 0}}}
  @media(forced-colors:active){.wb-console,dialog.wb-preview,.wb input,.wb select{border-color:ButtonText}.wb-frame-wrap[data-frame=true]::before{border-color:CanvasText}.wb-frame-wrap[data-frame=false] .wb-screen{outline:1px solid CanvasText;outline-offset:-1px}.wb-device-top::before,.wb-device-top::after,.wb-device-home,.wb-frame-wrap[data-device=tablet] .wb-device-top,.wb-frame-wrap[data-device=desktop] .wb-device-top i{background:CanvasText}.wb-device[aria-pressed=true]{outline:1px solid Highlight}.wb button:focus-visible,.wb input:focus-visible,.wb select:focus-visible,.wb summary:focus-visible,.wb [tabindex]:focus-visible{outline:2px solid Highlight;outline-offset:-3px}}
`;
