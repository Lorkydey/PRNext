import { elementPickerStyle } from './dev-element-picker-style.mjs';

const PROPERTIES = ['display', 'position', 'width', 'height', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'gap', 'border-radius', 'align-items', 'justify-content', 'grid-template-columns'];
const HOVER_HOLD = 35, SMALL_HOVER_HOLD = 75, POINTER_REST = 50;
const pickerEpochs=new WeakMap();
const toolNode = node => {
  for(let current=node;current;current=current.getRootNode?.().host)
    if(current.closest?.('prnext-dev-tools,prnext-dev-picker,#__prnext_dev_error__'))return true;
  return false;
};

function sourceLocation(element) {
  for(let owner=element;owner;owner=owner.parentElement||owner.getRootNode?.().host) {
    const source=owner.getAttribute?.('data-prnext-source');
    if(source)return {source,sourceRelation:owner===element?'element':'ancestor'};
  }
  return {source:null,sourceRelation:null};
}

export function describeElement(element, view = globalThis) {
  const bounds = element.getBoundingClientRect(), style = view.getComputedStyle(element);
  const {source,sourceRelation}=sourceLocation(element);
  const tag = element.tagName.toLowerCase(), selector = element.id ? '#' + view.CSS.escape(element.id) : tag + [...element.classList].slice(0, 3).map(name => '.' + view.CSS.escape(name)).join('');
  let text = '';
  if (['input', 'textarea', 'select'].includes(tag)) text = '[Form value omitted]';
  else {
    const walker = view.document.createTreeWalker(element, view.NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && text.length < 4000) {
      if (!walker.currentNode.parentElement?.closest('input,textarea,select,script,style,[hidden],[aria-hidden="true"]')) text += walker.currentNode.textContent + ' ';
    }
    text = text.trim().replace(/\s+/g, ' ').slice(0, 4000);
  }
  return { kind: 'element', path: view.location.pathname, selector, tag, text, source, sourceRelation,
    bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) },
    styles: Object.fromEntries(PROPERTIES.map(property => [property, style.getPropertyValue(property)])) };
}

// User-triggered capture only. Form controls, scripts, frames and development UI
// never enter an image; a CORS/CSP failure is reported rather than hidden.
export async function captureElementImage(element) {
  const { toPng } = await import('html-to-image');
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) throw Error('The element has no visible size.');
  if (['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'VIDEO'].includes(element.tagName)) throw Error('Form values and embedded content are excluded from images.');
  const scale = Math.min(1, 1400 / bounds.width, 1000 / bounds.height);
  const result = await toPng(element, { pixelRatio: scale, skipFonts: true, cacheBust: false,
    filter: node => !toolNode(node) && !['SCRIPT', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO'].includes(node.tagName),
  });
  if (result.length > 349525) throw Error('The image exceeds the 256 KB context limit. Select a smaller element.');
  return { mimeType: 'image/png', data: result.slice(result.indexOf(',') + 1), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) };
}

export function createElementPicker({ tools, onSelect, onCancel = () => {}, view = globalThis }) {
  const document = view.document, controller = new AbortController(), options = { signal: controller.signal, capture: true };
  const epoch=(pickerEpochs.get(tools)||0)+1;pickerEpochs.set(tools,epoch);
  const host = document.createElement('prnext-dev-picker'), shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent=elementPickerStyle;
  const node=(tag,className,text)=>{const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=text;return result;};
  const icon=paths=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const box = node('div','target'); box.hidden = true; box.setAttribute('aria-hidden','true');
  for(const corner of ['tl','t','tr','r','br','b','bl','l']){const mark=node('span','corner');mark.dataset.corner=corner;box.append(mark);}
  const tag=node('div','picker-tag');tag.hidden=true;tag.setAttribute('aria-hidden','true');
  const tagTop=node('div','picker-tag-top'),dimensions=node('span','picker-dimensions'),source=node('span','picker-source');
  const fileIcon=node('span','picker-file-icon'),fileName=node('span','picker-source-name'),fileLine=node('span','picker-source-line'),parentSource=node('span','picker-source-parent','Parent');
  source.append(fileIcon,fileName,fileLine,parentSource);tagTop.append(dimensions);tag.append(tagTop,source);
  const fileTypes={js:['javascript','JS'],jsx:['javascript','JS'],mjs:['javascript','JS'],cjs:['javascript','JS'],ts:['typescript','TS'],tsx:['typescript','TS'],mts:['typescript','TS'],cts:['typescript','TS'],html:['html','<>'],htm:['html','<>'],css:['css','#'],scss:['css','#'],json:['json','{}'],vue:['vue','V'],svelte:['svelte','S'],md:['markdown','M'],mdx:['markdown','M'],py:['python','Py'],rs:['rust','Rs']};
  let fileIconKey;
  function updateFileIcon(filename) {
    const extension=filename?.split('.').at(-1)?.toLowerCase(),type=Object.hasOwn(fileTypes,extension)?fileTypes[extension]:null,key=type?.[0]||'file';
    if(fileIconKey===key)return;fileIconKey=key;fileIcon.dataset.language=key;
    if(type){fileIcon.textContent=type[1];fileIcon.title=key;}
    else{fileIcon.innerHTML=icon('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5"/>');fileIcon.title='File';}
  }
  const hint=node('div','hint');hint.setAttribute('role','region');hint.setAttribute('aria-label','Element picker');
  const instruction=node('span','picker-instruction','Pick an element'),enter=node('kbd','picker-enter','↵');enter.setAttribute('aria-hidden','true');
  const cancelButton=node('button','picker-cancel','Cancel');cancelButton.type='button';cancelButton.setAttribute('aria-label','Cancel');
  const escape=node('kbd','','esc');escape.setAttribute('aria-hidden','true');cancelButton.append(escape);cancelButton.onclick=()=>cancel();
  const live=node('span','sr-only');live.setAttribute('role','status');
  hint.append(instruction,enter,cancelButton);shadow.append(style,box,tag,hint,live);document.documentElement.append(host);
  const previous = document.activeElement; let active, frame, pending, hoverTimer, pointer, stopped = false, viewportKey, placed = false;
  const viewport=()=>({left:view.visualViewport?.offsetLeft||0,top:view.visualViewport?.offsetTop||0,width:view.visualViewport?.width||view.innerWidth,height:view.visualViewport?.height||view.innerHeight});
  function placeHint() {
    const visible=viewport(),key=[visible.left,visible.top,visible.width,visible.height].join(':');
    if(viewportKey!==key){viewportKey=key;hint.style.maxWidth=Math.max(1,visible.width-24)+'px';}
    const height=hint.offsetHeight,width=hint.offsetWidth;let top=Math.max(visible.top+8,visible.top+visible.height-height-16),left=visible.left+(visible.width-width)/2;
    const hud=document.querySelector('prnext-dev-tools')?.getBoundingClientRect();
    if(hud?.width&&left<hud.right&&left+width>hud.left&&top<hud.bottom&&top+height>hud.top){
      const candidates=[hud.right+8,hud.left-width-8],fitting=candidates.find(candidate=>candidate>=visible.left+12&&candidate+width<=visible.left+visible.width-12);
      if(fitting!==undefined)left=fitting;else top=Math.max(visible.top+8,hud.top-height-12);
    }
    hint.style.left=(left+width/2)+'px';hint.style.bottom='auto';hint.style.top=top+'px';
    return {visible,hint:{top,height}};
  }
  function placeTag(rect, animate) {
    const {visible,hint:bar}=placeHint(),margin=8,gap=9;
    tag.style.maxWidth=Math.max(1,Math.min(280,visible.width-margin*2))+'px';
    const size=tag.getBoundingClientRect(),minX=visible.left+margin,maxX=visible.left+visible.width-size.width-margin;
    const maxY=Math.min(visible.top+visible.height-size.height-margin,bar.top-size.height-margin),minY=visible.top+margin;
    if(maxY<minY){tag.hidden=true;return;}
    const above=rect.top-size.height-gap,below=rect.bottom+gap;
    const top=above>=minY&&above<=maxY?above:below>=minY&&below<=maxY?below:Math.min(maxY,Math.max(minY,above));
    const left=Math.min(Math.max(minX,maxX),Math.max(minX,rect.left));
    // A wider filename must not travel outside the viewport from its old anchor.
    // Otherwise CSS can retarget the current animation without restarting it.
    tag.dataset.motion=String(animate&&size.left>=minX&&size.left<=maxX&&size.top>=minY&&size.top<=maxY);
    tag.style.translate=left+'px '+top+'px';tag.dataset.side=top+size.height<=rect.top?'above':'below';
  }
  function highlight(element, keyboard=false, animate=true) {
    const node=element;
    if (!node || toolNode(node) || node === document.documentElement || node === document.body) return;
    active = node; const rect = node.getBoundingClientRect();
    if(!rect.width||!rect.height){box.hidden=true;tag.hidden=true;placed=false;return;}
    const moving=animate&&placed;
    box.dataset.motion=String(moving);box.hidden = false; Object.assign(box.style, { translate: rect.left+'px '+rect.top+'px', width: rect.width+'px', height: rect.height+'px' });
    const location=sourceLocation(node),parsed=location.source?.match(/^(.*?):(\d+)(?::(\d+))?$/),filename=parsed?.[1].replaceAll('\\','/').split('/').at(-1);
    dimensions.textContent=Math.round(rect.width)+' × '+Math.round(rect.height);
    updateFileIcon(filename);fileName.textContent=filename||location.source||'<'+node.tagName.toLowerCase()+'>';
    fileLine.textContent=parsed?':'+parsed[2]:'';fileLine.hidden=!parsed;parentSource.hidden=location.sourceRelation!=='ancestor';
    source.title=location.source?(location.sourceRelation==='ancestor'?'Parent source: ':'')+location.source:'Source location unavailable';source.dataset.ancestor=String(location.sourceRelation==='ancestor');
    tag.hidden=false;placeTag(rect,moving);
    // Commit the first rectangle in place; later targets interpolate from it.
    // The existing layout read in placeTag also commits the frame's geometry.
    placed=true;
    if(keyboard)live.textContent=node.tagName.toLowerCase()+', '+Math.round(rect.width)+' by '+Math.round(rect.height)+' pixels'+(filename?', '+(location.sourceRelation==='ancestor'?'parent source ':'source ')+filename+', line '+parsed[2]:'')+'. Enter selects.';
  }
  function clearHover(resetPointer=true) {
    view.clearTimeout(hoverTimer);view.cancelAnimationFrame(frame);
    hoverTimer=undefined;frame=undefined;pending=undefined;if(resetPointer)pointer=undefined;
  }
  function hoverReadyAt() {
    const minimum=pending.since+pending.hold;
    const slow=pending.slowSince===undefined?Infinity:Math.max(minimum,pending.slowSince+pending.hold);
    return Math.min(slow,Math.max(minimum,pointer.lastMove+POINTER_REST));
  }
  function queueHover() {
    view.clearTimeout(hoverTimer);hoverTimer=undefined;
    if(stopped||!pending)return;
    const remaining=hoverReadyAt()-view.performance.now();
    if(frame!==undefined){if(remaining<=0)return;view.cancelAnimationFrame(frame);frame=undefined;}
    if(remaining>0){hoverTimer=view.setTimeout(queueHover,remaining);return;}
    frame=view.requestAnimationFrame(()=>{
      frame=undefined;
      // Acceleration between the timer and paint must not commit a stale hover.
      if(stopped||!pending)return;
      if(hoverReadyAt()>view.performance.now()){queueHover();return;}
      const candidate=pending.node;pending=undefined;
      if(candidate.isConnected)highlight(candidate);
    });
  }
  function hover(node,event) {
    if(!node||toolNode(node)||node===document.documentElement||node===document.body){clearHover();return;}
    const now=view.performance.now(),x=event.clientX,y=event.clientY;
    if(!pointer)pointer={x,y,time:now,lastMove:now,speed:0,instant:0};
    else{
      const distance=Math.hypot(x-pointer.x,y-pointer.y),elapsed=now-pointer.time;
      // Compare with the last meaningful position so subpixel steps accumulate.
      if(distance>1){
        const instant=distance/Math.max(1,Math.min(elapsed,64));
        pointer={x,y,time:now,lastMove:now,instant,speed:elapsed>120?instant:pointer.speed*.35+instant*.65};
      }
    }
    if(node===active){
      clearHover(false);frame=view.requestAnimationFrame(()=>{frame=undefined;if(!stopped&&node.isConnected)highlight(node);});return;
    }
    if(node!==pending?.node){
      clearHover(false);const rect=node.getBoundingClientRect();
      pending={node,since:now,hold:Math.min(rect.width,rect.height)<28||active?.contains(node)?SMALL_HOVER_HOLD:HOVER_HOLD};
    }
    // Hysteresis accepts deliberate slow movement, while a sudden acceleration
    // cancels that decision. A short pause also confirms intent after a fast move.
    if(pointer.instant>=.85||pointer.speed>=.65)pending.slowSince=undefined;
    else if(pointer.speed<=.45&&pending.slowSince===undefined)pending.slowSince=now;
    queueHover();
  }
  function stop(restore = true) { if (stopped) return; stopped = true; controller.abort(); clearHover(); host.remove(); if (restore && previous?.isConnected) previous.focus({ preventScroll: true }); }
  function cancel(){if(stopped)return;stop();onCancel();}
  async function select(node) {
    if (!node || toolNode(node)) return;
    const context = describeElement(node, view); stop(false); onSelect(context);
    let expectedContext,knownContext=false;
    try{const state=tools.snapshot?.();knownContext=Boolean(state&&Object.hasOwn(state,'context'));expectedContext=state?.context;}catch{}
    const image = captureElementImage(node).then(screenshot => ({ screenshot })).catch(error => ({ screenshot: null, screenshotError: error.message }));
    const mapped = context.source ? tools.call('dev_source', { source: context.source }).catch(error => ({ mapped: false, error: error.message })) : Promise.resolve({ mapped: false, error: 'No source location was emitted for this element.' });
    const [capture, source] = await Promise.all([image, mapped]);
    if(pickerEpochs.get(tools)!==epoch)return;
    if(knownContext){try{if(tools.snapshot().context!==expectedContext)return;}catch{return;}}
    const complete = { ...context, ...capture, mappedSource: source }; tools.setContext(complete); void tools.browser('selection', { selection: complete }); onSelect(complete);
  }
  document.addEventListener('pointermove', event => {
    hover(event.composedPath().find(item => item instanceof view.Element),event);
  }, options);
  document.addEventListener('pointerout',event=>{if(!event.relatedTarget)clearHover();},options);
  document.addEventListener('pointercancel',clearHover,options);view.addEventListener('blur',clearHover,options);
  document.addEventListener('click', event => {
    const node = event.composedPath().find(item => item instanceof view.Element); if (toolNode(node)) return;
    event.preventDefault(); event.stopImmediatePropagation(); void select(node);
  }, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    else if (event.key === 'Enter' && active && !toolNode(event.composedPath().find(item=>item instanceof view.Element))) { event.preventDefault(); event.stopImmediatePropagation(); void select(active); }
  }, options);
  document.addEventListener('focusin', event => {clearHover();highlight(event.composedPath().find(item=>item instanceof view.Element),true);}, options);
  // Scrolling and resizing keep the outline attached, without a trailing frame.
  const reposition=()=>{clearHover();placeHint();if(active)highlight(active,false,false);};
  view.addEventListener('scroll',reposition,options);view.addEventListener('resize',reposition,options);
  view.visualViewport?.addEventListener('scroll',reposition,options);view.visualViewport?.addEventListener('resize',reposition,options);
  placeHint();queueMicrotask(()=>{if(!stopped)live.textContent='Pick an element. Click, or use Tab and Enter. Escape or Cancel exits.';});
  // Leave the inert logo menu's tab sequence. The next Tab starts with the
  // application's first control rather than cycling back through tool buttons.
  const tabindex=document.body.getAttribute('tabindex');document.body.tabIndex=-1;document.body.focus({preventScroll:true});
  if(tabindex===null)document.body.removeAttribute('tabindex');else document.body.setAttribute('tabindex',tabindex);
  return { dispose: stop };
}
