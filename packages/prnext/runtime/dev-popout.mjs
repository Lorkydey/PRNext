// Created synchronously from a user click; never opens a background popup.
export function createToolWindow({ owner, title, width, height, onClose, reservedWindow }) {
  let popup=reservedWindow;
  try { if(popup===undefined)popup = owner.open('about:blank', '_blank', `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes`); }
  catch { return null; }
  if (!popup) return null;
  let finished = false, timer;
  function cleanup() {
    if (finished) return;
    finished = true; owner.clearInterval(timer);
    owner.removeEventListener('pagehide', close);
    onClose?.();
  }
  function close() { try { if (!popup.closed) popup.close(); } finally { cleanup(); } }
  try {
    // The UI uses the retained window reference; it needs no reverse opener.
    popup.opener = null;
    const document = popup.document;
    document.title = title; document.documentElement.lang = 'en';
    const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';document.head.append(viewport);
    document.body.style.cssText = 'margin:0;background:#080808;color-scheme:dark';
    const host = document.createElement('prnext-dev-window'), shadow = host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = `:host{display:block;color-scheme:dark}*,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}svg{width:16px;height:16px;flex:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`;
    shadow.append(style); document.body.replaceChildren(host);
    popup.addEventListener('pagehide', cleanup, {once:true});
    owner.addEventListener('pagehide', close, {once:true});
    timer = owner.setInterval(() => { if (popup.closed) cleanup(); }, 500);
    return { window:popup, shadow, close, focus() { try { popup.focus(); } catch {} } };
  } catch { close(); return null; }
}

export const popoutIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7L11 13"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>';
export const dockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14H3V7m0 7L13 4"/><path d="M3 18v1a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1"/></svg>';
