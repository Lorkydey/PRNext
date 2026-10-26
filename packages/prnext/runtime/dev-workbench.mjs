// Development UI only. The responsive preview is a second, same-origin page
// with a real viewport, not a CSS width applied to the running application.
import { createToolWindow, popoutIcon, dockIcon } from './dev-popout.mjs';
import { version } from '../package.json';
import { deviceIcons, copyIcon, chevronIcon, svg } from './dev-ui-icons.mjs';
import { consolePrompt } from './dev-console-copy.mjs';
import { workbenchStyle } from './dev-workbench-style.mjs';
import { createDevTooltips } from './dev-tooltip.mjs';
import { createPreviewTouch } from './dev-preview-touch.mjs';

function contactCursor(pressed) {
  const radius = pressed ? 8 : 10;
  const image = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="${radius}" fill="white" fill-opacity="${pressed ? .35 : .16}" stroke="black" stroke-opacity=".4" stroke-width="3"/><circle cx="16" cy="16" r="${radius}" fill="none" stroke="white" stroke-opacity=".85" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(image)}") 16 16, auto`;
}
const contactCursorStyle = `:root,:root *{cursor:${contactCursor(false)}!important}:root:active,:root:active *{cursor:${contactCursor(true)}!important}`;

export function createDevWorkbench({ shadow, capture, tools, restoreFocus, sourceURL = () => globalThis.location.href, detached, dock, closeWindow }) {
  const document = shadow.ownerDocument, view = document.defaultView;
  const requestAnimationFrame = view.requestAnimationFrame.bind(view), cancelAnimationFrame = view.cancelAnimationFrame.bind(view);
  const location = { get href() { return sourceURL(); }, get origin() { return new URL(sourceURL()).origin; } };
  const style = document.createElement('style');
  style.textContent = workbenchStyle +
    (detached === 'console' ? '.wb-console{inset:0;width:100vw;height:100dvh;max-height:none;border:0;border-radius:0;box-shadow:none}' : '') +
    (detached === 'preview' ? 'dialog.wb-preview{inset:0;width:100vw;height:100dvh;border:0;border-radius:0;box-shadow:none}' : '');
  shadow.append(style);
  const tooltips=createDevTooltips(shadow);
  const controller = new AbortController(), events = {signal: controller.signal};
  function element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function button(label, handler, className = '') {
    const node = element('button', className, label); node.type = 'button'; node.onclick = handler; return node;
  }
  function popoutButton(label, handler, isDock = false) {
    const node = button('',handler,'wb-popout'); node.innerHTML = isDock ? dockIcon : popoutIcon;
    node.setAttribute('aria-label',label); return tooltips.set(node,isDock?'Dock window':'Open in window');
  }
  function iconButton(label, drawing, handler, className = '') {
    const node = button('', handler, 'wb-icon ' + className); node.innerHTML = svg(drawing);
    node.setAttribute('aria-label', label); return tooltips.set(node,label);
  }
  const consolePanel = element('section', 'wb wb-console'); consolePanel.hidden = true;
  consolePanel.setAttribute('role', 'dialog'); consolePanel.setAttribute('aria-label', 'Client console');
  const heading = element('div', 'wb-head');
  // Keep the capture context for reports and detached windows, outside the header.
  let captureContext = 'Page';
  const pausedButton = iconButton('Pause', '<path d="M9 5v14M15 5v14"/>', () => { paused = !paused; syncPauseButton(); render(); }, 'wb-push wb-pause');
  pausedButton.firstElementChild.classList.add('wb-pause-icon');
  pausedButton.insertAdjacentHTML('beforeend', svg('<path d="m9 5 10 7-10 7Z"/>'));
  pausedButton.lastElementChild.classList.add('wb-resume-icon');
  pausedButton.setAttribute('aria-pressed', 'false');
  tooltips.set(pausedButton, 'Pause console', 'Messages keep recording');
  const closeConsole = iconButton('Close console', '<path d="m6 6 12 12M6 18 18 6"/>', () => hideConsole(), 'wb-close');
  const consolePopout = popoutButton(detached === 'console' ? 'Dock console' : 'Open console in new window', () => detached === 'console' ? dock?.() : popConsole(), detached === 'console');
  heading.append(element('span','wb-title','Client console'), pausedButton, consolePopout, closeConsole);
  const filters = element('div', 'wb-filters');
  const searchRow = element('div', 'wb-search-row'), searchField = element('div', 'wb-search');
  searchField.innerHTML = svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>');
  const search = element('input'); search.type = 'search'; search.placeholder = 'Filter messages…'; search.setAttribute('aria-label', 'Filter console messages');
  searchField.append(search);
  const filterRow = element('div', 'wb-filter-row'), filterOptions = element('div', 'wb-filter-options');
  filterOptions.setAttribute('role', 'group'); filterOptions.setAttribute('aria-label', 'Console filters');
  const utilities = element('div', 'wb-console-utilities');
  utilities.setAttribute('role', 'group'); utilities.setAttribute('aria-label', 'Console actions');
  const level = element('select'); level.setAttribute('aria-label', 'Console level');
  const sourceFilter = element('select'); sourceFilter.setAttribute('aria-label','Console source');
  for(const [value,label] of [['all','All sources'],['browser','Browser'],['server','Server']]){const option=element('option','',label);option.value=value;sourceFilter.append(option);}
  for (const [value, label] of [['all','All levels'],['error','Errors'],['warn','Warnings'],['info','Info'],['debug','Debug']]) {
    const option = element('option', '', label); option.value = value; level.append(option);
  }
  const clear = button('Clear', () => { active?.clear(); frozen = []; render(true); });
  const copy = button('Copy', async () => {
    try { await view.navigator.clipboard.writeText(filtered().map(entry => `[${new Date(entry.time).toISOString()}] ${entry.source?'['+entry.source+'] ':''}${entry.level}: ${entry.text}`).join('\n')); copy.textContent = 'Copied'; feedback.textContent = 'Visible console messages copied.'; }
    catch { copy.textContent = 'Failed'; feedback.textContent = 'Clipboard access unavailable.'; }
  }, 'wb-copy'); copy.setAttribute('aria-label', 'Copy visible logs');
  const aiGroup=element('div','wb-ai');
  const aiCopy=button('',()=>copyForAI(filtered(),'logs',aiCopy),'wb-ai-main');aiCopy.innerHTML=copyIcon+'<span data-copy-label>Copy for AI</span>';aiCopy.setAttribute('aria-label','Copy for AI');
  const aiToggle=button('',()=>aiMenuOpen?closeAIMenu(true):openAIMenu(),'wb-ai-toggle');aiToggle.innerHTML=chevronIcon;aiToggle.setAttribute('aria-label','AI copy options');aiToggle.setAttribute('aria-haspopup','menu');aiToggle.setAttribute('aria-expanded','false');
  aiGroup.append(aiCopy,aiToggle);utilities.append(clear,copy);searchRow.append(searchField,utilities);
  filterOptions.append(level);if(tools)filterOptions.append(sourceFilter);filterRow.append(filterOptions,aiGroup);filters.append(searchRow,filterRow);
  tooltips.set(aiCopy, 'Copy for AI');
  const aiMenu=element('div','wb wb-ai-menu');aiMenu.setAttribute('role','menu');aiMenu.setAttribute('aria-label','AI copy options');aiMenu.tabIndex=-1;aiMenu.popover='manual';
  const errorsAI=button('Copy errors for AI',()=>{closeAIMenu(true);copyForAI((active?.snapshot().entries||[]).filter(entry=>entry.level==='error'),'errors',aiCopy);});
  const visibleAI=button('Copy visible logs for AI',()=>{closeAIMenu(true);copyForAI(filtered(),'logs',aiCopy);});
  errorsAI.title='All recorded errors, including those hidden by filters';visibleAI.title='Only messages matching the current filters';
  for(const item of [errorsAI,visibleAI]){item.setAttribute('role','menuitem');item.tabIndex=-1;aiMenu.append(item);}
  aiMenu.hidden=true;
  const logs = element('div', 'wb-logs'); logs.tabIndex = 0; logs.setAttribute('role', 'region'); logs.setAttribute('aria-label', 'Console messages');
  const footer = element('div', 'wb-foot');
  const counts = element('span'), retained = element('span'); footer.append(counts, retained);
  const feedback = element('span', 'sr-only'); feedback.setAttribute('role', 'status');
  consolePanel.append(heading, filters, logs, footer, feedback, aiMenu); shadow.append(consolePanel);

  let active = capture, rawActive = capture, unsubscribe, paused = false, frozen = [], visible = [], frame, previewStore;
  let device = 'phone', rotated = false, customWidth, frameTimer, paint, disposed = false;
  let frameEnabled = true, frameMotion;
  try { frameEnabled = view.sessionStorage.getItem('prnext:dev-device-frame') !== 'false'; } catch {}
  let viewportWidth=390,viewportScale=1,resizeStart,previewChrome;
  let consoleWindow, previewWindow;
  let aiMenuOpen=false;
  const rowNodes=new Map();
  function syncPauseButton() {
    pausedButton.setAttribute('aria-pressed', String(paused));
    pausedButton.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    tooltips.set(pausedButton, paused ? 'Resume console' : 'Pause console', paused ? 'Show new messages' : 'Messages keep recording');
  }
  async function writeClipboard(text,control,label='Copied') {
    feedback.textContent='';control.dataset.copyState='copying';control.setAttribute('aria-busy','true');
    try {await view.navigator.clipboard.writeText(text);control.dataset.copyState='copied';feedback.textContent=label;
      const textNode=control.querySelector('[data-copy-label]');if(textNode)textNode.textContent='Copied';
    }catch{control.dataset.copyState='failed';feedback.textContent='Clipboard access unavailable. Allow clipboard access and try again.';
      const textNode=control.querySelector('[data-copy-label]');if(textNode)textNode.textContent='Copy failed';}
    finally{control.removeAttribute('aria-busy');}
  }
  function reportOptions(kind) {return {kind,version,route:currentURL(),source:captureContext,dropped:active?.snapshot().dropped||0};}
  async function copyForAI(entries,kind,control) {
    if(!entries.length)return;
    await writeClipboard(consolePrompt(entries,reportOptions(kind)),control,kind==='errors'?'All captured errors copied for AI.':'Client messages copied for AI.');
  }
  function closeAIMenu(restore=false) {
    aiMenuOpen=false;aiToggle.setAttribute('aria-expanded','false');
    try{if(aiMenu.matches(':popover-open'))aiMenu.hidePopover();}catch{}aiMenu.hidden=true;
    if(restore)aiToggle.focus();
  }
  function openAIMenu() {
    aiMenuOpen=true;aiMenu.hidden=false;aiToggle.setAttribute('aria-expanded','true');aiMenu.showPopover();
    const anchor=aiToggle.getBoundingClientRect(),box=aiMenu.getBoundingClientRect();
    aiMenu.style.left=Math.max(8,Math.min(view.innerWidth-box.width-8,anchor.right-box.width))+'px';
    aiMenu.style.top=(anchor.bottom+box.height+8<view.innerHeight?anchor.bottom+5:Math.max(8,anchor.top-box.height-5))+'px';
    const first=[...aiMenu.children].find(item=>!item.disabled);(first||aiMenu).focus();
  }
  aiToggle.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openAIMenu();}},events);
  aiMenu.addEventListener('keydown',event=>{
    const items=[...aiMenu.children].filter(item=>!item.disabled),index=items.indexOf(shadow.activeElement);
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeAIMenu(true);}
    else if(event.key==='Tab'){event.preventDefault();closeAIMenu(false);(event.shiftKey?aiCopy:logs).focus();}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&items.length){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:index<0?(event.key==='ArrowUp'?items.length-1:0):(index+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus();}
  },events);
  document.addEventListener('pointerdown',event=>{if(aiMenuOpen&&!event.composedPath().includes(aiMenu)&&!event.composedPath().includes(aiGroup))closeAIMenu();},{...events,capture:true});
  document.addEventListener('focusin',event=>{if(aiMenuOpen&&!event.composedPath().includes(aiMenu)&&!event.composedPath().includes(aiGroup))closeAIMenu();},events);
  function createRow(entry) {
    const row=element('details','wb-entry');row.dataset.entry=String(entry.id);
    const summary=element('summary','wb-line');summary.dataset.level=entry.level;
    const timestamp=element('time','',new Date(entry.time).toLocaleTimeString([],{hour12:false}));timestamp.dateTime=new Date(entry.time).toISOString();
    const caret=element('span','wb-entry-caret');caret.innerHTML=chevronIcon;
    summary.append(timestamp,element('span','wb-level',entry.level),element('span','wb-message',(entry.source==='server'?'[server] ':'')+entry.text),caret);
    const actions=element('div','wb-entry-actions');
    const raw=button('',()=>writeClipboard(entry.text,raw,'Complete captured message copied.'));
    raw.innerHTML=copyIcon+'<span data-copy-label>Copy message</span>';
    const ai=button('',()=>copyForAI([entry],'message',ai));ai.innerHTML=copyIcon+'<span data-copy-label>Copy for AI</span>';
    raw.setAttribute('aria-label','Copy message');ai.setAttribute('aria-label','Copy for AI');
    actions.append(raw,ai);row.append(summary,actions);
    const full=element('pre','wb-entry-full',entry.text);
    row.addEventListener('toggle',()=>{if(row.open)row.append(full);else full.remove();});return row;
  }
  function filtered() {
    const query = search.value.toLocaleLowerCase();
    return visible.filter(entry => (sourceFilter.value==='all'||(entry.source||'browser')===sourceFilter.value) && (level.value === 'all' || entry.level === level.value || level.value === 'info' && entry.level === 'log') && (!query || entry.text.toLocaleLowerCase().includes(query)));
  }
  function render(force = false) {
    if (disposed || consolePanel.hidden) return;
    const data = active?.snapshot() || {entries:[],dropped:0};
    if (!paused || force) frozen = data.entries;
    visible = frozen;
    const shown = filtered(), atBottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 35, oldTop = logs.scrollTop;
    const retainedIDs=new Set([...data.entries,...shown].map(entry=>entry.id));
    for(const [id] of rowNodes)if(!retainedIDs.has(id))rowNodes.delete(id);
    const nodes=shown.map(entry=>{let row=rowNodes.get(entry.id);if(!row){row=createRow(entry);rowNodes.set(entry.id,row);}return row;});
    if(!shown.length)nodes.push(element('div','wb-empty',!active?'Waiting for preview…':data.entries.length?'No matching messages':'No client messages yet'));
    // Leave existing rows in place so new logs preserve open messages and focus.
    const wanted=new Set(nodes);for(const node of [...logs.children])if(!wanted.has(node))node.remove();
    nodes.forEach((node,index)=>{if(logs.children[index]!==node)logs.insertBefore(node,logs.children[index]||null);});
    logs.scrollTop = atBottom ? logs.scrollHeight : oldTop;
    const sourceEntries=data.entries.filter(entry=>sourceFilter.value==='all'||(entry.source||'browser')===sourceFilter.value);
    const errors = sourceEntries.filter(entry => entry.level === 'error').length, warnings = sourceEntries.filter(entry => entry.level === 'warn').length;
    counts.textContent = `${errors} ${errors === 1 ? 'error' : 'errors'} · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    retained.textContent = `${shown.length}/${data.entries.length} messages${paused ? ' · display paused' : ''}${data.dropped ? ' · older messages removed' : ''}`;
    errorsAI.disabled=!data.entries.some(entry=>entry.level==='error');visibleAI.disabled=shown.length===0;aiCopy.disabled=shown.length===0;
  }
  function schedule() { if (!paint && !consolePanel.hidden) paint = requestAnimationFrame(() => { paint = null; render(); }); }
  function subscribeStore() { unsubscribe?.(); unsubscribe=consolePanel.hidden?undefined:active?.subscribe(schedule); }
  function useStore(store, label) {
    closeAIMenu();rowNodes.clear();logs.replaceChildren();
    unsubscribe?.(); rawActive=store;active = store&&tools?tools.captureFor(store):store; captureContext = label; frozen = []; paused = false;
    syncPauseButton();
    subscribeStore(); render(true);
    consoleWindow?.tools.setCapture(store,label);
  }
  search.addEventListener('input', () => { copy.textContent = 'Copy'; render(); }, events);
  level.addEventListener('change', () => { copy.textContent = 'Copy'; render(); }, events);
  sourceFilter.addEventListener('change', () => { copy.textContent = 'Copy'; render(); }, events);
  consolePanel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideConsole(); } }, events);
  function showConsole() { if (consoleWindow && !consoleWindow.window.closed) { consoleWindow.focus(); return; } consoleWindow?.close(); consolePanel.hidden = false;subscribeStore(); consoleToggle.setAttribute('aria-pressed','true'); copy.textContent = 'Copy'; render(true); search.focus(); }
  function hideConsole() { tooltips.hide();closeAIMenu();if (detached === 'console') { closeWindow?.(); return; } consolePanel.hidden = true;unsubscribe?.();unsubscribe=undefined; consoleToggle.setAttribute('aria-pressed','false'); if (preview.open) consoleToggle.focus(); else restoreFocus(); }

  const preview = element('dialog', 'wb wb-preview'); preview.setAttribute('aria-label', 'Device preview');
  const toolbar = element('div','wb-preview-head'), devices = element('div','wb-devices'); devices.setAttribute('role','group'); devices.setAttribute('aria-label','Preview device');
  function deviceButton(value,label,width) {
    const node=button('',()=>setDevice(value),'wb-device');node.innerHTML=deviceIcons[value];node.setAttribute('aria-label',label);node.setAttribute('aria-description',`${width}px viewport`);return tooltips.set(node,label);
  }
  const phone=deviceButton('phone','Phone',390),tablet=deviceButton('tablet','Tablet',768),desktop=deviceButton('desktop','Desktop',1280);
  devices.append(desktop,phone,tablet);
  const dimensions = element('span','wb-dimensions');
  const rotate = iconButton('Rotate', '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/><rect x="9" y="8" width="6" height="8" rx="1"/>', () => rotatePreview());
  const frameToggle = iconButton('Device frame', '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><rect x="8" y="7" width="8" height="10" rx="1.5"/>', () => setFrame(!frameEnabled));
  frameToggle.classList.add('wb-frame-toggle');frameToggle.append(element('span','','Frame'));
  frameToggle.setAttribute('aria-pressed',String(frameEnabled));
  const consoleToggle = iconButton('Console', '<path d="m5 7 5 5-5 5m8 0h6"/>', () => consolePanel.hidden ? showConsole() : hideConsole());
  consoleToggle.setAttribute('aria-pressed','false');
  const closePreview = iconButton('Close device preview', '<path d="m6 6 12 12M6 18 18 6"/>', () => preview.close(), 'wb-close');
  const previewPopout = popoutButton(detached === 'preview' ? 'Dock device preview' : 'Open device preview in new window', () => detached === 'preview' ? dock?.() : popPreview(device), detached === 'preview');
  const toolbarActions=element('div','wb-preview-actions');toolbarActions.append(rotate,frameToggle,consoleToggle,previewPopout,closePreview);
  toolbar.append(devices,dimensions,toolbarActions);
  const stage = element('div','wb-stage'), frameWrap = element('div','wb-frame-wrap'), screen = element('div','wb-screen'); frameWrap.append(screen);stage.append(frameWrap);
  const deviceTop = element('div','wb-device-top'), deviceHome = element('div','wb-device-home');
  for(let index=0;index<3;index++)deviceTop.append(element('i'));
  deviceTop.setAttribute('aria-hidden','true');deviceHome.setAttribute('aria-hidden','true');frameWrap.append(deviceTop,deviceHome);
  const resizeHandle=button('',()=>{},'wb-resize');resizeHandle.setAttribute('role','slider');resizeHandle.setAttribute('aria-label','Preview width');resizeHandle.setAttribute('aria-orientation','horizontal');resizeHandle.setAttribute('aria-valuemin','240');resizeHandle.setAttribute('aria-valuemax','2560');frameWrap.append(resizeHandle);
  function setWidth(width) {customWidth=Math.max(240,Math.min(2560,Math.round(width)));sizePreview();}
  resizeHandle.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();resizeHandle.focus();resizeStart={x:event.clientX,width:viewportWidth,scale:viewportScale,pointer:event.pointerId};resizeHandle.setPointerCapture(event.pointerId);stage.dataset.resizing='true';},events);
  resizeHandle.addEventListener('pointermove',event=>{if(resizeStart&&event.pointerId===resizeStart.pointer)setWidth(resizeStart.width+(event.clientX-resizeStart.x)/resizeStart.scale);},events);
  function stopResize(){resizeStart=null;stage.dataset.resizing='false';}
  resizeHandle.addEventListener('pointerup',stopResize,events);resizeHandle.addEventListener('pointercancel',stopResize,events);resizeHandle.addEventListener('lostpointercapture',stopResize,events);
  resizeHandle.addEventListener('keydown',event=>{const step=event.shiftKey?50:10;if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();setWidth(event.key==='Home'?240:event.key==='End'?2560:viewportWidth+(event.key==='ArrowLeft'?-step:step));}},events);
  const note = element('div','wb-preview-note');
  const previewStatus = element('span');note.setAttribute('role','status');note.hidden=true;
  dimensions.setAttribute('aria-description','CSS viewport size in your current browser, without device OS or touch emulation.');
  const retry = button('', () => { if (frame) { beginLoading(); frame.src = location.href; } },'wb-icon wb-preview-reload');
  retry.innerHTML=svg('<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>');retry.setAttribute('aria-label','Reload preview');tooltips.set(retry,'Refresh preview');toolbarActions.prepend(retry);
  tooltips.set(closePreview,'Close preview');
  note.append(previewStatus); preview.append(toolbar,stage,note); shadow.append(preview);
  function animateFrame() {
    frameMotion?.cancel();frameMotion=null;
    if(preview.open&&!view.matchMedia('(prefers-reduced-motion: reduce)').matches)
      frameMotion=frameWrap.animate([{opacity:.65,translate:'0 4px'},{opacity:1,translate:'0 0'}],{duration:200,easing:'cubic-bezier(.16,1,.3,1)'});
  }
  function rotatePreview({animate=true}={}) {
    if(!frame||!preview.open||device==='desktop')return;
    const before=frameWrap.getBoundingClientRect(),computed=view.getComputedStyle(frameWrap);
    const oldWidth=parseFloat(frameWrap.style.width),oldHeight=parseFloat(frameWrap.style.height);
    const previous=new view.DOMMatrixReadOnly(computed.transform==='none'?undefined:computed.transform);
    const oldOpacity=Number(computed.opacity);
    rotated=!rotated;customWidth=undefined;sizePreview();
    if(!animate||view.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const after=frameWrap.getBoundingClientRect(),width=parseFloat(frameWrap.style.width),height=parseFloat(frameWrap.style.height);
    // Convert the current visual transform to the new orientation before
    // cancelling an interrupted turn. The speaker stays on the same physical end.
    const start=new view.DOMMatrix([previous.a,previous.b,previous.c,previous.d,0,0])
      .rotate(rotated?90:-90).scale(oldHeight/width,oldWidth/height);
    const angle=Math.atan2(start.b,start.a),scaleX=Math.hypot(start.a,start.b),scaleY=(start.a*start.d-start.b*start.c)/scaleX;
    const dx=before.x+before.width/2-after.x-after.width/2,dy=before.y+before.height/2-after.y-after.height/2;
    const availableWidth=Math.max(1,stage.clientWidth-32),availableHeight=Math.max(1,stage.clientHeight-32),keyframes=[];
    // Fit the entire rotating silhouette, including its diagonal, to the canvas.
    // These small transform-only keyframes run on the compositor, not a JS loop.
    for(let index=0;index<=24;index++){
      const progress=index/24,remaining=1-progress,radians=angle*remaining;
      const sx=1+(scaleX-1)*remaining,sy=1+(scaleY-1)*remaining;
      const boundsWidth=Math.abs(Math.cos(radians))*width*sx+Math.abs(Math.sin(radians))*height*sy;
      const boundsHeight=Math.abs(Math.sin(radians))*width*sx+Math.abs(Math.cos(radians))*height*sy;
      const fit=Math.min(1,availableWidth/boundsWidth,availableHeight/boundsHeight);
      keyframes.push({offset:progress,transform:`translate(${dx*remaining}px,${dy*remaining}px) rotate(${radians*180/Math.PI}deg) scale(${sx*fit},${sy*fit})`,opacity:oldOpacity+(1-oldOpacity)*progress});
    }
    const motion=frameWrap.animate(keyframes,{duration:380,easing:'cubic-bezier(.22,1,.36,1)'});frameMotion=motion;
    motion.onfinish=()=>{if(frameMotion===motion)frameMotion=null;};
  }
  function setFrame(enabled) {
    frameEnabled=Boolean(enabled);frameToggle.setAttribute('aria-pressed',String(frameEnabled));
    try{view.sessionStorage.setItem('prnext:dev-device-frame',String(frameEnabled));}catch{}
    sizePreview();animateFrame();
  }
  function clearPreviewChrome() {
    if(!previewChrome)return;
    previewChrome.touch.dispose();
    try{const {document,sheet}=previewChrome;document.adoptedStyleSheets=document.adoptedStyleSheets.filter(value=>value!==sheet);}catch{}
    previewChrome=undefined;
  }
  function syncPreviewChrome() {
    if(!frame)return;
    try{
      const child=frame.contentWindow;
      if(child.location.origin!==location.origin){clearPreviewChrome();return;}
      const childDocument=child.document;
      // Navigation can expose the new Document before its root is parsed. The
      // load/ready callback installs the cursor and panning together afterward.
      if(!childDocument.documentElement){clearPreviewChrome();return;}
      if(previewChrome?.document!==childDocument)clearPreviewChrome();
      if(device==='desktop'){clearPreviewChrome();return;}
      if(!previewChrome){
        // A sheet owned by this preview document only. No overflow changes or
        // application styles are modified; removing it restores the original UI.
        const sheet=new child.CSSStyleSheet();
        // Native cursors stay centered even when the device is scaled.
        sheet.replaceSync(':root,:root *{scrollbar-width:none!important;scrollbar-gutter:auto!important}:root::-webkit-scrollbar,:root *::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' + contactCursorStyle);
        previewChrome={document:childDocument,sheet,touch:createPreviewTouch(childDocument)};
      }
      if(!childDocument.adoptedStyleSheets.includes(previewChrome.sheet))childDocument.adoptedStyleSheets=[...childDocument.adoptedStyleSheets,previewChrome.sheet];
    }catch{clearPreviewChrome();}
  }
  function sizePreview() {
    if (!frame || !preview.open) return;
    tooltips.hide();
    frameMotion?.cancel();frameMotion=null;
    // Scale the entire device, keeping its CSS viewport independent of decoration.
    const inset = !frameEnabled ? [0,0,0,0] : device==='desktop' ? [32,6,6,6] : device==='tablet' ? [16,16,16,16] : [12,12,12,12];
    const [top,right,bottom,left]=inset,chromeWidth=left+right,chromeHeight=top+bottom;
    const availableWidth=Math.max(1,stage.clientWidth-40),availableHeight=Math.max(1,stage.clientHeight-40);
    let [width,height] = device === 'phone' ? [390,844] : device==='tablet' ? [768,1024] : [Math.max(240,availableWidth-chromeWidth),Math.max(240,availableHeight-chromeHeight)];
    if (rotated) [width,height] = [height,width];
    if(customWidth!==undefined)width=customWidth;
    const scale = Math.min(1,availableWidth/(width+chromeWidth),availableHeight/(height+chromeHeight));
    viewportWidth=width;viewportScale=scale;
    frame.style.width = width + 'px'; frame.style.height = height + 'px'; frame.style.transform = `scale(${scale})`;
    screen.style.width=width*scale+'px';screen.style.height=height*scale+'px';screen.style.left=left*scale+'px';screen.style.top=top*scale+'px';
    screen.style.borderRadius=!frameEnabled?'0px':device==='desktop'?`0 0 ${6*scale}px ${6*scale}px`:(device==='phone'?32:14)*scale+'px';
    const outerWidth=(width+chromeWidth)*scale,outerHeight=(height+chromeHeight)*scale;
    frameWrap.style.width=outerWidth+'px';frameWrap.style.height=outerHeight+'px';frameWrap.style.left=(stage.clientWidth-outerWidth)/2+'px';frameWrap.style.top=(stage.clientHeight-outerHeight)/2+'px';
    frameWrap.style.borderRadius=(frameEnabled?(device==='phone'?44:device==='tablet'?30:12)*scale:0)+'px';frameWrap.style.setProperty('--s',String(scale));
    frameWrap.dataset.device=device;frameWrap.dataset.frame=String(frameEnabled);frameWrap.dataset.rotated=String(rotated);
    rotate.hidden=device==='desktop';
    dimensions.textContent = `${width} × ${height}`;
    dimensions.setAttribute('aria-label',`${width} by ${height} pixel viewport, ${Math.round(scale*100)} percent scale`);
    for(const [node,value,defaultWidth,defaultHeight] of [[phone,'phone',390,844],[tablet,'tablet',768,1024],[desktop,'desktop',Math.max(240,availableWidth-12),Math.max(240,availableHeight-38)]]){
      node.setAttribute('aria-pressed',String(device===value));
      tooltips.set(node,node.getAttribute('aria-label'),`${device===value?width:defaultWidth} × ${device===value?height:defaultHeight}`);
      node.setAttribute('aria-description',`${device===value?width:defaultWidth} by ${device===value?height:defaultHeight} pixel viewport`);
    }
    tooltips.set(rotate,'Rotate device');tooltips.set(frameToggle,frameEnabled?'Hide device frame':'Show device frame');
    resizeHandle.setAttribute('aria-valuenow',String(width));resizeHandle.setAttribute('aria-valuetext',`${width}px`);
    syncPreviewChrome();
  }
  const observer = new view.ResizeObserver(sizePreview); observer.observe(stage);
  function attachPreview() {
    if (!frame || !preview.open) return;
    try {
      const child = frame.contentWindow;
      if (child.location.origin !== location.origin) throw new Error('External page');
      syncPreviewChrome();
      const store = child.__PRNEXT_DEV__?.consoleCapture;
      if (store && store !== previewStore) { previewStore = store; useStore(store,'Preview'); }
      if (store) { clearTimeout(frameTimer); previewStatus.textContent = '';note.hidden=true;preview.removeAttribute('aria-busy'); }
    } catch { clearPreviewChrome();previewStore = null; useStore(null,'Preview'); previewStatus.textContent = 'Preview unavailable. Reload to return.';note.hidden=false;preview.removeAttribute('aria-busy'); }
  }
  view.addEventListener('message', event => {
    if (frame && event.source === frame.contentWindow && event.origin === location.origin && event.data?.type === 'prnext:preview-ready') attachPreview();
  }, events);
  function setDevice(value) { device = value; rotated = false;customWidth=undefined;sizePreview();animateFrame(); }
  function beginLoading() {
    clearTimeout(frameTimer);clearPreviewChrome(); previewStore = null; useStore(null,'Preview'); previewStatus.textContent = '';note.hidden=true;preview.setAttribute('aria-busy','true');
    frameTimer = setTimeout(() => { if (!previewStore) {previewStatus.textContent = 'Preview unavailable. Open it in a new window or reload.';note.hidden=false;preview.removeAttribute('aria-busy');} }, 15000);
  }
  function openPreview(value) {
    if (previewWindow?.window.closed) previewWindow.close();
    if (previewWindow) {previewWindow.tools.openPreview(value);previewWindow.focus();return;}
    if (!preview.open) {
      beginLoading();
      frame = element('iframe','wb-frame'); frame.title = 'PRNext responsive preview'; frame.dataset.prnextPreview = 'true';
      frame.addEventListener('load', attachPreview, events); frame.src = location.href; screen.append(frame);
      if (!consoleWindow) preview.append(consolePanel);consoleToggle.setAttribute('aria-pressed',String(!consolePanel.hidden));preview.showModal();
    }
    setDevice(value); (value === 'phone' ? phone : value==='tablet'?tablet:desktop).focus();
  }
  preview.addEventListener('close', () => {
    tooltips.hide();
    clearTimeout(frameTimer);clearPreviewChrome(); frameMotion?.cancel();frameMotion=null;frame?.remove(); frame = null; previewStore = null;
    shadow.append(consolePanel); useStore(capture,'Page'); restoreFocus();
    if (detached === 'preview') closeWindow?.();
  }, events);
  const popupFeedback = element('div','wb wb-popup-feedback'); popupFeedback.hidden = true; popupFeedback.setAttribute('role','status');
  shadow.append(popupFeedback);
  function blocked() {
    popupFeedback.textContent = 'Popup blocked. Allow popups for this site, then try again.'; popupFeedback.hidden = false;
    if (preview.open) preview.append(popupFeedback);
    else { showConsole(); consolePanel.append(popupFeedback); }
  }
  function currentURL() { try { const url = frame?.contentWindow?.location.href; if (url && new URL(url).origin === location.origin) return url; } catch {} return location.href; }
  function createPopout(kind, value = device, reservedWindow) {
    const existing = kind === 'console' ? consoleWindow : previewWindow;
    if (existing && !existing.window.closed) { reservedWindow?.close();if (kind === 'preview') existing.tools.openPreview(value); existing.focus(); return existing; }
    existing?.close();
    let record;
    const source = currentURL();
    const popup = createToolWindow({owner:view,title:kind==='console'?'PRNext — Client console':'PRNext — Device preview',width:kind==='console'?860:value==='tablet'?1000:560,height:kind==='console'?520:960,
      reservedWindow,onClose() { record?.tools.dispose(); if (kind==='console' && consoleWindow===record) consoleWindow = null; else if (kind==='preview' && previewWindow===record) previewWindow = null; },
    });
    if (!popup) { blocked(); return null; }
    popupFeedback.hidden = true;
    const child = createDevWorkbench({shadow:popup.shadow,capture:rawActive,tools,sourceURL:()=>source,detached:kind,restoreFocus:()=>{},closeWindow:()=>popup.close(),
      dock() {
        const last = child.previewState(), consoleState = child.consoleState(); popup.close();
        if (kind === 'console') { setConsoleState(consoleState); showConsole(); }
        else { openPreview(last.device);rotated=last.rotated;customWidth=last.customWidth;setFrame(last.frameEnabled);if(frame&&last.url!==location.href){beginLoading();frame.src=last.url;}sizePreview(); }
        view.focus();
      },
    });
    record = {...popup,tools:child};
    if (kind === 'console') { consoleWindow = record; child.setCapture(rawActive,captureContext); child.setConsoleState(getConsoleState()); child.showConsole(); }
    else { previewWindow = record; child.openPreview(value);child.setFrame(frameEnabled); if(value===device){if(rotated)child.rotate({animate:false});if(customWidth!==undefined)child.setWidth(customWidth);} }
    popup.focus(); return record;
  }
  function popConsole(reservedWindow) { const popup = createPopout('console',device,reservedWindow); if (popup) {consolePanel.hidden = true;unsubscribe?.();unsubscribe=undefined;consoleToggle.setAttribute('aria-pressed','false');} }
  function getConsoleState() { return {query:search.value,level:level.value,source:sourceFilter.value,paused}; }
  function setConsoleState(state) { search.value=state.query;level.value=state.level;sourceFilter.value=state.source||'all';paused=state.paused;syncPauseButton();render(true); }
  function popPreview(value = device,reservedWindow) {
    if (value === 'desktop') {
      // Desktop is the original application, with the browser's normal viewport.
      try { const popup = reservedWindow===undefined?view.open(location.href,'_blank','popup=yes,width=1280,height=900,resizable=yes,scrollbars=yes'):reservedWindow; if (popup) { popup.opener=null;if(reservedWindow)popup.location.href=location.href;popup.focus(); } else blocked(); }
      catch { blocked(); }
      return;
    }
    const popup = createPopout('preview',value,reservedWindow); if (popup && preview.open) preview.close();
  }
  useStore(capture,'Page');
  return {
    showConsole, openPreview, popConsole, popPreview,
    consoleState:getConsoleState,setConsoleState,
    setCapture(store,label='Page') { capture=store;useStore(store,label); },
    previewState:()=>({device,rotated,customWidth,frameEnabled,url:currentURL()}),setWidth,setFrame,
    rotate:rotatePreview,
    hide() { tooltips.hide();consoleWindow?.close(); previewWindow?.close(); consolePanel.hidden = true;unsubscribe?.();unsubscribe=undefined;if (preview.open) preview.close(); },
    dispose() {
      disposed = true;tooltips.dispose();closeAIMenu();clearPreviewChrome();rowNodes.clear();clearTimeout(frameTimer);frameMotion?.cancel();cancelAnimationFrame(paint);unsubscribe?.();observer.disconnect();controller.abort();
      consoleWindow?.close(); previewWindow?.close();
      if (preview.open) preview.close(); frame?.remove(); preview.remove(); consolePanel.remove(); popupFeedback.remove(); style.remove();
    },
  };
}
