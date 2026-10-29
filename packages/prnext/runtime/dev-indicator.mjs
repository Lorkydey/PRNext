import logo from './dev-logo.mjs';
import { createLazyDevTool, registerDevToolLoaders } from './dev-lazy-tool.mjs';
import { popoutIcon } from './dev-popout.mjs';
import { deviceIcons } from './dev-ui-icons.mjs';
import { createDevPosition } from './dev-position.mjs';
import { createDevIssueMotion } from './dev-issue-motion.mjs';

const loadDevTool = registerDevToolLoaders({
  workbench: () => import('./dev-workbench.mjs'),
  inspector: () => import('./dev-tools-panel.mjs'),
});

// This module is imported only by the development browser entry. No framework
// contexts, application CSS, network requests or additional SSE streams.
export function createDevIndicator({ position = 'bottom-left', snapshot, showIssues, capture, tools }) {
  const host = document.createElement('prnext-dev-tools');
  host.id = '__prnext_dev_tools__';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed;bottom:max(18px,env(safe-area-inset-bottom));left:max(18px,env(safe-area-inset-left));width:44px;height:44px;--issue-rgb:240,92,102;--issue-alpha:.5;--origin-x:22px;--origin-y:calc(100% - 22px);--flip-x:1;--flip-y:1;--panel-from:8px;z-index:2147483646;color-scheme:dark;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ededf0;text-align:left;direction:ltr}
    :host([data-position^=top]){top:max(18px,env(safe-area-inset-top));bottom:auto;--origin-y:22px;--flip-y:-1;--panel-from:-8px}:host([data-position$=right]){right:max(18px,env(safe-area-inset-right));left:auto;--origin-x:calc(100% - 22px);--flip-x:-1}
    *,*::before,*::after{box-sizing:border-box}button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent;cursor:pointer}button:focus-visible{outline:1px solid #858585;outline-offset:-2px}button:disabled{cursor:default}svg{width:16px;height:16px;flex:none}
    .trigger{position:relative;z-index:3;display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid #303030;border-radius:999px;background:#080808;box-shadow:0 2px 5px #0006,0 8px 22px #0004,inset 0 1px 0 #ffffff06;user-select:none;cursor:grab}:host([data-dragging=true]) .trigger{cursor:grabbing;scale:1.06;border-color:#777;box-shadow:0 10px 24px #0008}
    .trigger:hover{border-color:#555;background:#101010}.trigger[aria-expanded=true]{border-color:transparent;background:transparent;box-shadow:none}.trigger img{width:28px;height:28px;border-radius:50%;pointer-events:none;filter:grayscale(1) contrast(1.25)}
    .bubble{position:absolute;bottom:0;left:0;z-index:1;pointer-events:none;filter:drop-shadow(0 12px 22px #0008) drop-shadow(0 2px 5px #0006)}.bubble-mask{width:100%;height:100%;clip-path:circle(22px at var(--origin-x) var(--origin-y))}.bubble-mask[data-open=true]{clip-path:circle(var(--bubble-radius) at var(--origin-x) var(--origin-y))}.bubble svg{display:block;width:100%;height:100%;transform:scale(var(--flip-x),var(--flip-y));transform-origin:center}.bubble path{fill:#080808;stroke:#292929;stroke-width:1}
    .ring{position:absolute;inset:3px;pointer-events:none}.ring svg{display:block;width:100%;height:100%;overflow:visible}.ring circle{fill:none;stroke:transparent;stroke-width:1.5;stroke-linecap:round;stroke-dasharray:0 50 0 50;transform:rotate(-113.4deg);transform-origin:center}
    .trigger[data-busy=true] .ring circle{stroke:#b3c1ff;stroke-dasharray:25 0 25 50}.trigger[data-issue-severity=error] .ring circle{stroke:rgba(var(--issue-rgb),var(--issue-alpha));stroke-dasharray:13 37 13 37}.trigger[data-issue-severity=critical] .ring circle{stroke:rgba(var(--issue-rgb),var(--issue-alpha));stroke-dasharray:50 0 50 0}
    .issue-motion{position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;z-index:4;pointer-events:none;visibility:hidden;opacity:var(--issue-alpha)}.issue-motion[data-running=true]{visibility:visible}.issue-motion-path,.issue-motion-ring,.issue-motion-streak{stroke:rgb(var(--issue-rgb))}
    :host([data-issue-transfer]) .trigger[data-issue-severity=error] .ring circle,:host([data-issue-transfer]) .trigger[data-issue-severity=critical] .ring circle{transition:none}
    :host([data-issue-transfer=moving]) .trigger[data-issue-severity=error] .ring circle,:host([data-issue-transfer=moving]) .trigger[data-issue-severity=critical] .ring circle,:host([data-issue-transfer=open]) .trigger[data-issue-severity=error] .ring circle,:host([data-issue-transfer=open]) .trigger[data-issue-severity=critical] .ring circle{stroke:transparent}
    :host([data-issue-transfer=moving]) .action-issues{border-color:transparent}
    .panel{position:absolute;bottom:36px;left:0;width:264px;max-width:calc(100vw - 36px);max-height:calc(100dvh - 100px);overflow:auto;overscroll-behavior:contain;padding:8px 8px 12px;border:0;border-radius:20px;background:transparent;scrollbar-color:#333 #080808;transform-origin:var(--origin-x) bottom}
    :host([data-position^=top]) .bubble{top:0;bottom:auto}:host([data-position^=top]) .panel{top:36px;bottom:auto;transform-origin:var(--origin-x) top}:host([data-position$=right]) .bubble,:host([data-position$=right]) .panel{right:0;left:auto}
    .corner-hints{position:fixed;inset:0;pointer-events:none;z-index:0}.corner-hint{position:absolute;width:44px;height:44px;bottom:max(18px,env(safe-area-inset-bottom));left:max(18px,env(safe-area-inset-left));border:1px dashed #ffffff35;border-radius:50%;background:#08080888}.corner-hint[data-corner^=top]{top:max(18px,env(safe-area-inset-top));bottom:auto}.corner-hint[data-corner$=right]{right:max(18px,env(safe-area-inset-right));left:auto}.corner-hint[data-active=true]{border-style:solid;border-color:#aaa;background:#ffffff16;scale:1.1}
    :host([hidden]),[hidden]{display:none!important}.panel{z-index:2}.panel:not([data-open=true]){opacity:0;pointer-events:none}
    .panel:focus{outline:none}.trigger:focus-visible{outline-offset:-4px}.action:focus-visible{background:#171717}
    .action{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;border:0;padding:9px 10px;border-radius:11px;background:transparent;text-decoration:none;text-align:left;font-size:12px}.action:hover:not(:disabled){background:#161616}.action:disabled{color:#a1a1a1}.action .hint{margin-left:auto;color:#a1a1a1;font-size:11px}.divider{height:1px;margin:6px 8px;background:#202020}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    .action-issues{border:1px solid rgba(var(--issue-rgb),var(--issue-alpha));padding:8px 9px}.action-issues .hint{color:rgb(var(--issue-rgb))}
    .action-split{display:flex;align-items:center}.action-split .action{flex:1;min-width:0}.detach{display:grid;place-items:center;flex:none;width:32px;min-height:36px;border:0;border-radius:8px;background:transparent;color:#aaa;padding:4px}.detach:hover{background:#161616;color:#fff}.detach svg{width:14px;height:14px}
    .devices{display:flex;gap:3px;padding:4px;background:#111;border-radius:11px;margin:6px 4px}.device-choice{position:relative;display:grid;place-items:center;flex:1;min-width:0;min-height:34px;padding:6px 0;border:0;border-radius:8px;background:transparent;color:#aaa}.device-choice:hover{background:#1c1c1c;color:#fff}.device-choice[aria-pressed=true]{background:#222;color:#fff}.devices .detach{width:32px;min-height:34px}.device-choice::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 8px);left:0;background:#1b1b1b;color:#eee;padding:6px 9px;border-radius:7px;font-size:11px;white-space:nowrap;box-shadow:0 3px 14px #0005;opacity:0;visibility:hidden;pointer-events:none;z-index:4}.device-choice:hover::after,.device-choice:focus-visible::after{opacity:1;visibility:visible}
    @media(prefers-reduced-motion:no-preference){.trigger{transition:background-color 150ms,border-color 150ms,box-shadow 150ms,transform 150ms,scale 180ms}.trigger:active{transform:scale(.96)}.ring circle{transition:stroke 160ms ease-out,stroke-dasharray 160ms ease-out}.corner-hint{transition:background-color 150ms,border-color 150ms,scale 180ms}.bubble-mask{transition:clip-path 260ms cubic-bezier(.3,0,.3,1)}.bubble-mask[data-open=true]{transition-duration:360ms;transition-timing-function:cubic-bezier(.16,1,.3,1)}.panel{transition:opacity 110ms ease-out,transform 230ms cubic-bezier(.16,1,.3,1)}.panel:not([data-open=true]){transform:translateY(var(--panel-from)) scale(.97)}.panel[data-open=true]{transition:opacity 120ms ease-out 60ms,transform 180ms cubic-bezier(.16,1,.3,1) 60ms}:host([data-position^=top]) .bubble-mask{transition-duration:180ms}:host([data-position^=top]) .bubble-mask[data-open=true]{transition-duration:220ms}:host([data-position^=top]) .panel{transition:opacity 90ms ease-out,transform 180ms cubic-bezier(.16,1,.3,1)}:host([data-position^=top]) .panel[data-open=true]{transition:opacity 90ms ease-out,transform 140ms cubic-bezier(.16,1,.3,1)}.trigger[data-busy=true] .ring{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}}
    @media(pointer:coarse){.action,.device-choice,.devices .detach{min-height:44px}.devices .detach{width:44px}}
    @media(forced-colors:active){.trigger,.action-issues{border-color:ButtonText}.bubble path{fill:Canvas;stroke:ButtonText}.trigger[data-busy=true] .ring circle,.trigger[data-issue-severity=error] .ring circle,.trigger[data-issue-severity=critical] .ring circle{stroke:CanvasText}.issue-motion{opacity:1}.issue-motion-path,.issue-motion-ring,.issue-motion-streak{stroke:CanvasText}button:focus-visible{outline:2px solid Highlight;outline-offset:-3px}}
  `;
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'trigger';
  trigger.setAttribute('aria-label', 'Open PRNext developer tools');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', 'tools');
  const mark = document.createElement('img'); mark.src = logo; mark.alt = ''; mark.draggable = false;
  const ring = document.createElement('span'); ring.className = 'ring'; ring.setAttribute('aria-hidden', 'true');
  const ringSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');ringSvg.setAttribute('viewBox','0 0 36 36');
  const ringCircle=document.createElementNS('http://www.w3.org/2000/svg','circle');
  for(const[name,value]of Object.entries({cx:'18',cy:'18',r:'17.25',pathLength:'100'}))ringCircle.setAttribute(name,value);
  ringSvg.append(ringCircle);ring.append(ringSvg);
  trigger.append(mark, ring);
  const panel = document.createElement('section');
  panel.id = 'tools'; panel.className = 'panel'; panel.hidden = true; panel.inert = true; panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'PRNext developer tools');
  const bubble=document.createElement('div');bubble.className='bubble';bubble.hidden=true;bubble.setAttribute('aria-hidden','true');
  const mask=document.createElement('div');mask.className='bubble-mask';
  const surface=document.createElementNS('http://www.w3.org/2000/svg','svg');surface.setAttribute('preserveAspectRatio','none');
  const shape=document.createElementNS('http://www.w3.org/2000/svg','path');surface.append(shape);mask.append(surface);bubble.append(mask);
  function measureBubble(){
    if(panel.hidden)return;
    const width=panel.offsetWidth,height=panel.offsetHeight;
    bubble.style.width=width+'px';bubble.style.height=(height+36)+'px';bubble.style.setProperty('--bubble-radius',Math.ceil(Math.hypot(width-22,height+14)+2)+'px');surface.setAttribute('viewBox',`0 0 ${width} ${height+36}`);
    // One contour: rounded menu, curved shoulder, and the logo's circular foot.
    shape.setAttribute('d',`M20.5 .5H${width-20.5}Q${width-.5} .5 ${width-.5} 20.5V${height-20}Q${width-.5} ${height} ${width-20.5} ${height}H64Q44 ${height} 44 ${height+14}A21.75 21.75 0 0 1 .5 ${height+14}V20.5Q.5 .5 20.5 .5Z`);
    issueMotion?.refresh();
  }
  // Only constant icon markup goes through innerHTML. Labels use textContent.
  const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  function action(label, drawing, handler) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'action';
    button.innerHTML = icon(drawing); const text = document.createElement('span'); text.textContent = label;
    button.append(text); button.onclick = handler; panel.append(button); return button;
  }
  const issues = action('View issues', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5m0 3.5h.01"/>', () => { close(false); showIssues(); });
  issues.classList.add('action-issues');
  const issueCount = document.createElement('span'); issueCount.className = 'hint'; issues.append(issueCount);
  action('Reload page', '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>', () => location.reload());
  let workbench;
  const toolError=error=>{feedback.textContent='Could not open development tool. Try again.';console.error(error);};
  const getWorkbench = () => workbench ||= createLazyDevTool(async()=>{
    const {createDevWorkbench}=await loadDevTool('workbench');
    return createDevWorkbench({shadow,capture,tools,restoreFocus:()=>trigger.focus()});
  },{onError:toolError,reserve(method,args){
    if(!['popConsole','popPreview'].includes(method))return;
    try{return window.open('about:blank','_blank',`popup=yes,width=${method==='popConsole'?860:args[0]==='tablet'?1000:560},height=${method==='popConsole'?520:960},resizable=yes,scrollbars=yes`);}catch{return null;}
  }});
  function detachButton(label,handler) {
    const button=document.createElement('button');button.type='button';button.className='detach';button.innerHTML=popoutIcon;
    button.setAttribute('aria-label',label);button.title=label;button.onclick=handler;return button;
  }
  const consoleAction=action('Client console', '<path d="m5 7 5 5-5 5m8 0h6"/>', () => { close(false); getWorkbench().showConsole(); });
  const consoleRow=document.createElement('div');consoleRow.className='action-split';consoleAction.replaceWith(consoleRow);
  consoleRow.append(consoleAction,detachButton('Open console in new window',()=>{close(false);getWorkbench().popConsole();}));
  let inspector;
  const getInspector = () => inspector ||= createLazyDevTool(async()=>{
    const {createDevToolsPanel}=await loadDevTool('inspector');
    return createDevToolsPanel({shadow,tools,restoreFocus:()=>trigger.focus()});
  },{onError:toolError});
  if (tools) {
    action('Inspect','<path d="M3 12h4l3-8 4 16 3-8h4"/>',()=>{close(false);getInspector().open('requests');});
    action('Select element for AI','<path d="m4 3 7 17 2-7 7-2L4 3Z"/>',()=>{close(false);getInspector().pick();});
  }
  const devices = document.createElement('div'); devices.className = 'devices'; devices.setAttribute('role','group'); devices.setAttribute('aria-label','Preview device');
  let selectedDevice='desktop',previewSelected=false;
  const deviceChoices=new Map();
  const currentDevice=()=>previewSelected?workbench?.previewState().device||selectedDevice:selectedDevice;
  function updateDevices(){
    const current=currentDevice();
    for(const [value,button] of deviceChoices)button.setAttribute('aria-pressed',String(value===current));
    devicePopout.title=`Open ${current} in new window`;
  }
  for (const [value,label,width] of [
    ['desktop','Desktop','Responsive'],['phone','Phone','390px'],['tablet','Tablet','768px'],
  ]) {
    const button = document.createElement('button'); button.type = 'button'; button.className='device-choice'; button.innerHTML = deviceIcons[value];
    button.setAttribute('aria-label',label);button.setAttribute('aria-description',width);button.dataset.tooltip=`${label} · ${width}`;
    button.onclick = () => { selectedDevice=value;previewSelected=true;close(false);getWorkbench().openPreview(value);updateDevices(); };
    deviceChoices.set(value,button);devices.append(button);
  }
  const devicePopout=detachButton('Open device preview in new window',()=>{const value=currentDevice();close(false);getWorkbench().popPreview(value);});
  devices.append(devicePopout);updateDevices();
  panel.append(devices);
  const divider = document.createElement('div'); divider.className = 'divider'; panel.append(divider);
  action('Hide until reload', '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.5 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.5M6.3 6.3A22 22 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.5-1.1"/>', () => {
    close(false);issueMotion.closeImmediately(); workbench?.hide(); inspector?.hide(); host.hidden = true; restorePageFocus();
  });
  const live = document.createElement('span'); live.className = 'sr-only'; live.setAttribute('role', 'status');
  const feedback = document.createElement('span'); feedback.className = 'sr-only'; feedback.setAttribute('role', 'status');
  shadow.append(style,bubble,panel,trigger,live,feedback); document.body.append(host);
  const issueMotion = createDevIssueMotion({ host, shadow, ringSvg, issues, panel });
  const geometry=new ResizeObserver(measureBubble);geometry.observe(panel);
  let opened = false, timer, previousSummary, previousPageFocus = document.activeElement;
  function restorePageFocus() {
    if (previousPageFocus?.isConnected && previousPageFocus !== document.body && previousPageFocus !== host) previousPageFocus.focus();
    else { const body = document.body, old = body.getAttribute('tabindex'); body.tabIndex = -1; body.focus(); if (old === null) body.removeAttribute('tabindex'); else body.setAttribute('tabindex', old); }
  }
  function close(restore) {
    opened = false; clearTimeout(timer); trigger.setAttribute('aria-expanded', 'false');
    issueMotion.update({severity:trigger.dataset.issueSeverity,open:false});
    panel.dataset.open = 'false';mask.dataset.open='false';panel.inert = true; panel.setAttribute('aria-hidden', 'true');
    if (restore) trigger.focus();
    timer = setTimeout(() => { if (!opened) {panel.hidden=true;bubble.hidden=true;} }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280);
  }
  function update() {
    // App Router's global error boundary can replace the document body.
    if (!host.isConnected && document.body) document.body.append(host);
    const info = snapshot();
    const count = info.issues || 0;
    const severity=count?(info.criticalIssues>0?'critical':'error'):'none';
    const status = count ? 'error' : info.connection !== 'connected' ? 'reconnecting' : info.building ? 'building' : 'ready';
    const label = count ? `${count} ${count === 1 ? 'issue' : 'issues'}` : status === 'building' ? 'Compiling…' : status === 'reconnecting' ? 'Connecting…' : 'Ready';
    if (count === 0 && shadow.activeElement === issues) panel.focus();
    issues.hidden = count === 0; issueCount.textContent = String(count);
    trigger.dataset.busy = String(info.building && !count); trigger.title = `PRNext · ${label}`;
    trigger.dataset.issueSeverity=severity;
    issueMotion.update({severity,open:opened&&!panel.hidden});
    if(count)trigger.setAttribute('aria-description',severity==='critical'?'Critical error. Open issues to view details.':'Non-blocking issue. Open issues to view details.');else trigger.removeAttribute('aria-description');
    trigger.setAttribute('aria-label', 'Open PRNext developer tools' + (count ? ` (${label})` : ''));
    const summary=count?`${label}. ${severity==='critical'?'Critical error':'Non-blocking issue'}`:label;
    if (previousSummary !== summary) { live.textContent = `PRNext: ${summary}`; previousSummary = summary; }
  }
  trigger.onclick = () => {
    if (opened) { close(true); return; }
    opened = true; clearTimeout(timer); feedback.textContent = '';
    update();updateDevices(); panel.hidden = false;bubble.hidden=false;panel.inert = false;measureBubble();
    panel.removeAttribute('aria-hidden'); trigger.setAttribute('aria-expanded', 'true');
    mask.getBoundingClientRect();panel.dataset.open='true';mask.dataset.open='true';panel.focus();
    issueMotion.update({severity:trigger.dataset.issueSeverity,open:true});
  };
  const placement = createDevPosition({ host, trigger, position, announce: text => { feedback.textContent = text; }, onDrag() {
    close(false);issueMotion.closeImmediately(); panel.hidden = true; bubble.hidden = true;
  } });
  const controller = new AbortController(), options = { capture: true, signal: controller.signal };
  document.addEventListener('pointerdown', event => { if (opened && !event.composedPath().some(node => node === panel || node === trigger)) close(false); }, options);
  document.addEventListener('focusin', event => {
    if (!event.composedPath().includes(host)) { previousPageFocus = event.target; if (opened) close(false); }
  }, options);
  shadow.addEventListener('focusin', event => { if (opened && !panel.contains(event.target) && event.target !== trigger) close(false); }, {signal:controller.signal});
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(true); } });
  globalThis.addEventListener('popstate', update, { signal: controller.signal });
  update();
  const contextListener = event => { close(false); getInspector().open('ai', event.detail); };
  if (tools) globalThis.addEventListener('prnext:devtools:context', contextListener, {signal:controller.signal});
  return { update, dispose() { clearTimeout(timer);issueMotion.dispose();placement.dispose();geometry.disconnect();controller.abort();workbench?.dispose();inspector?.dispose();host.remove(); } };
}
