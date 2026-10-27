const RECORDER = Symbol.for('prnext.dev.replay.recorder');
const STORAGE = '__prnext_replay_draft_v1__', MAX_STEPS = 50, MAX_STORAGE = 40000;
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const clone = value => JSON.parse(JSON.stringify(value));
const internalPath = path => /^\/_prnext(?:\/|$)/.test(path);
const ownNode = element => {
  for (let current = element; current; current = current.getRootNode?.().host)
    if (current.closest?.('prnext-dev-tools,prnext-dev-picker,prnext-dev-replay,#__prnext_dev_error__')) return true;
  return false;
};

export function isReplaySensitiveField(element) {
  if (!element?.matches?.('input,textarea,select,[contenteditable]')) return false;
  if (element.matches('[contenteditable],input[type="password"],input[type="hidden"],input[type="file"]')) return true;
  const hints = [element.name, element.id, element.getAttribute('autocomplete'), element.getAttribute('aria-label'), element.form?.id, element.form?.name, element.form?.getAttribute('action'), element.form?.getAttribute('aria-label'), ...(element.labels || [])].map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ');
  return /(?:password|passwd|passphrase|secret|token|auth|credential|credit|card|cvv|cvc|one.?time|otp|cc-|security.?code|api.?key|bearer|jwt|session.?key|user.?name|login|sign.?in)/i.test(hints);
}

function visibleText(element) {
  if (!element || element.matches?.('input,textarea,select,[contenteditable]')) return '';
  const copy = element.cloneNode(true);
  for (const node of copy.querySelectorAll('input,textarea,select,[contenteditable],script,style,[hidden],[aria-hidden="true"]')) node.remove();
  return compact(copy.textContent).slice(0, 500);
}
function accessibleName(element, document) {
  const explicit = compact(element.getAttribute('aria-label'));
  if (explicit) return explicit;
  const references = compact(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
  if (references.length) return compact(references.map(id => document.getElementById(id)?.textContent).join(' '));
  if (element.matches('input[type="button"],input[type="submit"],input[type="reset"]')) return '';
  return visibleText(element);
}
function roleOf(element) {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit && /^[a-z][a-z0-9-]*$/.test(explicit)) return explicit;
  if (element.matches('button,input[type="button"],input[type="submit"],input[type="reset"]')) return 'button';
  if (element.matches('a[href]')) return 'link';
  if (element.matches('input[type="checkbox"]')) return 'checkbox';
  if (element.matches('input[type="radio"]')) return 'radio';
  if (element.matches('textarea,input:not([type]),input[type="text"],input[type="email"],input[type="search"],input[type="tel"],input[type="url"]')) return element.type === 'search' ? 'searchbox' : 'textbox';
  if (/^H[1-6]$/.test(element.tagName)) return 'heading';
  return '';
}

// Persist only an exact, unique locator. Ambiguous elements need a stable label
// or data-testid; choosing a first match would hide application regressions.
export function createReplayTarget(element, view = globalThis) {
  const document = view.document;
  if (!element || ownNode(element) || isReplaySensitiveField(element)) throw Error('Choose a non-sensitive page element.');
  const all = [...document.querySelectorAll('body *')].filter(item => !ownNode(item));
  const testId = element.getAttribute('data-testid');
  if (testId && testId.length <= 180 && all.filter(item => item.getAttribute('data-testid') === testId).length === 1) return { kind: 'testId', value: testId };
  if (element.labels?.length) {
    for (const label of element.labels) {
      const value = visibleText(label);
      if (value && value.length <= 180 && all.filter(item => item.labels && [...item.labels].some(itemLabel => visibleText(itemLabel) === value)).length === 1) return { kind: 'label', value };
    }
  }
  const role = roleOf(element), name = accessibleName(element, document);
  if (role && name && name.length <= 180 && all.filter(item => roleOf(item) === role && accessibleName(item, document) === name).length === 1) return { kind: 'role', role, name };
  const ariaLabel = compact(element.getAttribute('aria-label'));
  if (element.matches('input,textarea,select') && ariaLabel && ariaLabel.length <= 180 && all.filter(item => compact(item.getAttribute('aria-label')) === ariaLabel).length === 1) return { kind: 'label', value: ariaLabel };
  const text = visibleText(element);
  // Match Playwright's smallest exact text element, not its text ancestors.
  const textMatches = text && all.filter(item => visibleText(item) === text && ![...item.children].some(child => visibleText(child) === text));
  if (text && text.length <= 180 && textMatches.length === 1 && textMatches[0] === element) return { kind: 'text', value: text };
  if (element.id && element.id.length <= 160 && document.querySelectorAll('#' + view.CSS.escape(element.id)).length === 1) return { kind: 'css', value: '#' + view.CSS.escape(element.id) };
  throw Error('This element has no unique locator. Add a label or data-testid and select it again.');
}

function safeDraft(raw) {
  if (!raw || raw.version !== 1 || !['recording', 'paused', 'stopped'].includes(raw.mode) || !Array.isArray(raw.scenario?.steps) || !raw.scenario.steps.length || raw.scenario.steps[0]?.type !== 'visit' || raw.scenario.steps.length > MAX_STEPS) return;
  const scenario = raw.scenario;
  if (scenario.version !== 1 || typeof scenario.name !== 'string' || scenario.name.length > 120 || !Number.isInteger(scenario.viewport?.width) || !Number.isInteger(scenario.viewport?.height)) return;
  // An allow-list also prevents old or tampered drafts carrying form values.
  const steps = [];
  for (const step of scenario.steps) {
    if (!step || typeof step !== 'object') return;
    if (['visit', 'expectURL'].includes(step.type)) {
      if (typeof step.path !== 'string' || !step.path.startsWith('/') || step.path.startsWith('//') || /[?#\r\n\\]/.test(step.path) || internalPath(step.path) || step.path.length > 1000) return;
      steps.push({ type: step.type, path: step.path }); continue;
    }
    if (!['click', 'fill', 'expectVisible', 'expectText'].includes(step.type)) return;
    const target = step.target;
    if (!target || !['role', 'label', 'testId', 'text', 'css'].includes(target.kind)) return;
    const value = target.kind === 'role' ? target.name : target.value;
    if (typeof value !== 'string' || !value || value.length > 500) return;
    const clean = { type: step.type, target: target.kind === 'role' ? { kind: 'role', role: String(target.role).slice(0, 50), name: value } : { kind: target.kind, value } };
    if (step.type === 'fill') { if (!/^field\d{1,3}$/.test(step.parameter)) return; clean.parameter = step.parameter; }
    if (step.type === 'expectText') { if (typeof step.text !== 'string' || step.text.length > 500) return; clean.text = step.text; }
    steps.push(clean);
  }
  return { version: 1, mode: raw.mode, updatedAt: Number(raw.updatedAt) || 0, lastClickAt: Number.isFinite(raw.lastClickAt) ? raw.lastClickAt : 0, lastPath: typeof raw.lastPath === 'string' ? raw.lastPath.split(/[?#]/)[0].slice(0, 1000) : '', scenario: { version: 1, name: scenario.name, viewport: { width: Math.max(240, Math.min(2560, scenario.viewport.width)), height: Math.max(240, Math.min(2560, scenario.viewport.height)) }, steps } };
}

export function getDevReplayRecorder(view = globalThis) { return view[RECORDER]; }

export function installDevReplayRecorder({ view = globalThis } = {}) {
  view[RECORDER]?.dispose();
  const document = view.document;
  if (!document || view.__PRNEXT_REPLAY__ === true) return;
  const controller = new view.AbortController(), listeners = new Set(), originals = [];
  const options = { capture: true, signal: controller.signal };
  let disposed = false, draft, message = '', picker, keyboardTarget, host, toolbar, status, pauseButton, stopButton, reviewButton, hint, outline;
  try { const saved = view.sessionStorage.getItem(STORAGE); if (saved && saved.length <= MAX_STORAGE) draft = safeDraft(JSON.parse(saved)); } catch {}
  if (draft?.updatedAt < Date.now() - 8 * 60 * 60 * 1000) draft = undefined;
  const state = () => ({ mode: draft?.mode || 'idle', scenario: draft ? clone(draft.scenario) : null, message, picking: picker || null });
  const currentPath = () => internalPath(view.location.pathname) ? null : view.location.pathname;
  function persist() {
    try { if (draft) { draft.updatedAt = Date.now(); const value = JSON.stringify(draft); if (value.length <= MAX_STORAGE) view.sessionStorage.setItem(STORAGE, value); } else view.sessionStorage.removeItem(STORAGE); } catch { message = 'Draft storage is unavailable. Keep this page open until you save.'; }
  }
  function notify() { if (disposed) return; syncToolbar(); for (const listener of listeners) { try { listener(state()); } catch {} } }
  function feedback(text) { message = text; notify(); }
  function append(step) {
    if (disposed || !draft) return;
    if (draft.scenario.steps.length >= MAX_STEPS) { draft.mode = 'stopped'; feedback('The 50-step limit is reached. Review and save this scenario.'); persist(); return; }
    draft.scenario.steps.push(step);
    if(JSON.stringify(draft).length>MAX_STORAGE){draft.scenario.steps.pop();feedback('This draft is too large. Remove a step before recording more.');return;}
    message = ''; persist(); notify();
  }
  function recordNavigation() {
    if (disposed || draft?.mode !== 'recording') return;
    const path = currentPath();
    if (path && path !== draft.lastPath) {
      draft.lastPath = path;
      const sinceClick=Date.now()-(draft.lastClickAt||0);
      // The click must cause its own navigation. A visit here could reload an
      // SPA or make a broken navigation appear to work during replay.
      append({ type: sinceClick>=0&&sinceClick<30000?'expectURL':'visit', path });
    }
  }
  function eventElement(event) {
    const path = event.composedPath?.() || [event.target];
    if (path.some(item => item?.tagName && ownNode(item))) return null;
    return path.find(item => item?.nodeType === 1) || null;
  }
  function localAction(element) {
    const link = element.closest('a[href]');
    const raw = link?.getAttribute('href') || element.closest('form')?.getAttribute('action');
    if (raw) { try { const url = new URL(raw, view.location.href); if (url.origin !== view.location.origin || internalPath(url.pathname)) return false; } catch { return false; } }
    return !link?.hasAttribute('download') && (!link?.target || link.target === '_self');
  }
  function recordClick(event) {
    const raw = eventElement(event);
    if (!raw || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (picker) { event.preventDefault(); event.stopImmediatePropagation(); selectAssertion(raw); return; }
    if (draft?.mode !== 'recording') return;
    const element = raw.closest('button,a[href],input[type="checkbox"],input[type="radio"],[role="button"],[role="link"],[role="checkbox"],[role="radio"]');
    if (!element || element.disabled || isReplaySensitiveField(element) || !localAction(element)) return;
    try { const target=createReplayTarget(element,view);draft.lastClickAt=Date.now();append({ type: 'click', target }); } catch (error) { feedback(error.message); }
  }
  function recordFill(event) {
    if (draft?.mode !== 'recording' || picker) return;
    const element = eventElement(event);
    if (!element?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea') || isReplaySensitiveField(element)) return;
    try {
      const target = createReplayTarget(element, view), steps = draft.scenario.steps;draft.lastClickAt=0;
      // Repeated keystrokes and change/blur events update the same parameter.
      if (steps.at(-1)?.type === 'fill' && JSON.stringify(steps.at(-1).target) === JSON.stringify(target)) return;
      const serial = Math.max(0, ...steps.filter(step => step.type === 'fill').map(step => Number(step.parameter.slice(5))));
      append({ type: 'fill', target, parameter: 'field' + (serial + 1) });
    } catch (error) { feedback(error.message); }
  }
  function requestReview() { view.dispatchEvent(new view.CustomEvent('prnext-replay-review')); }
  function clearPicker() { picker = undefined; keyboardTarget = undefined; if (outline) outline.hidden = true; notify(); }
  function selectAssertion(element) {
    if (!picker || !draft) return;
    try {
      if (element.closest('input,textarea,select,[contenteditable]')) throw Error('Choose page content. Form values cannot be assertions.');
      const target = createReplayTarget(element, view), type = picker;
      const text = type === 'expectText' ? visibleText(element) : undefined;
      if (type === 'expectText' && !text) throw Error('Choose an element with visible text.');
      clearPicker(); append(type === 'expectText' ? { type, target, text } : { type, target });
      feedback('Assertion added. Continue recording or review the scenario.');
    } catch (error) { feedback(error.message); }
  }
  function movePicker(event) {
    if (!picker) return;
    const element = eventElement(event);
    if (!element) { if (outline) outline.hidden = true; return; }
    keyboardTarget = undefined; outlineElement(element);
  }
  function outlineElement(element) {
    const bounds = element.getBoundingClientRect();
    if (outline) { outline.hidden = false; Object.assign(outline.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' }); }
  }
  function nextKeyboardTarget(direction) {
    const candidates = [...document.querySelectorAll('[data-testid],button,a[href],h1,h2,h3,h4,h5,h6,p,[role],span,li')].filter(element => {
      if(ownNode(element)||element.closest('[hidden],[aria-hidden="true"],input,textarea,select,[contenteditable]'))return false;
      const bounds=element.getBoundingClientRect();if(!bounds.width||!bounds.height)return false;
      return true;
    });
    if(!candidates.length){feedback('No uniquely labelled elements are available. Add a label or data-testid.');return;}
    const index=candidates.indexOf(keyboardTarget);
    for(let offset=1;offset<=candidates.length;offset++){
      const candidate=candidates[((index+direction*offset)%candidates.length+candidates.length)%candidates.length];
      try{const label=targetLabelForKeyboard(candidate);keyboardTarget=candidate;keyboardTarget.scrollIntoView({block:'nearest',inline:'nearest'});outlineElement(keyboardTarget);hint.textContent='Selected: '+label+'. Press Enter to add the assertion. Escape cancels.';return;}catch{}
    }
    feedback('No uniquely labelled elements are available. Add a label or data-testid.');
  }
  function targetLabelForKeyboard(element){const target=createReplayTarget(element,view);return target.kind==='role'?target.role+' '+target.name:target.kind+' '+target.value;}
  function buildToolbar() {
    if (disposed || host || !document.documentElement) return;
    host = document.createElement('prnext-dev-replay'); const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;color-scheme:dark;font:12px/1.5 ui-sans-serif,system-ui;color:#ededed}*{box-sizing:border-box}[hidden]{display:none!important}.bar{position:fixed;top:max(12px,env(safe-area-inset-top));left:50%;translate:-50% 0;pointer-events:auto;max-width:calc(100vw - 24px);display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px;padding:6px;background:#101010;border:1px solid #444;border-radius:14px;box-shadow:0 4px 20px #0006}.status{padding:0 8px;white-space:nowrap}button{font:inherit;color:inherit;background:#202020;border:0;border-radius:8px;min-height:44px;padding:8px 10px;cursor:pointer}button:hover{background:#303030}button:focus-visible{outline:2px solid #d2d2d2;outline-offset:-3px}.hint{flex-basis:100%;text-align:center;max-width:420px;overflow-wrap:anywhere;color:#bcbcbc;padding:0 8px 4px}.outline{position:fixed;pointer-events:none;border:2px solid #e7e7e7;outline:1px solid #111;background:#ffffff10;border-radius:3px}@media(max-width:390px){.bar{width:calc(100vw - 24px)}.status{flex-basis:100%;text-align:center}button{flex:1}}@media(forced-colors:active){.bar,.outline{border-color:CanvasText}button:focus-visible{outline-color:Highlight}}`;
    style.textContent += ':host([hidden]){display:none!important}';
    const node = (tag, text) => { const result = document.createElement(tag); if (text) result.textContent = text; return result; };
    const button = (text, action) => { const result = node('button', text); result.type = 'button'; result.onclick = action; return result; };
    toolbar = node('section'); toolbar.className = 'bar'; toolbar.setAttribute('aria-label', 'Replay recording');
    status = node('span'); status.className = 'status'; status.setAttribute('role', 'status');
    pauseButton = button('Pause recording', () => api[draft?.mode === 'paused' ? 'resume' : 'pause']());
    stopButton = button('Stop recording', () => { api.stop(); requestReview(); });
    const visible = button('Add on-screen assertion', () => api.pickAssertion('expectVisible'));
    const text = button('Add text assertion', () => api.pickAssertion('expectText'));
    const url = button('Add URL assertion', () => api.addURLAssertion());
    reviewButton = button('Review scenario', requestReview);
    const cancel = button('Cancel selection', clearPicker); cancel.dataset.cancel = '';
    hint = node('span'); hint.className = 'hint'; hint.setAttribute('role', 'status');
    outline = node('div'); outline.className = 'outline'; outline.hidden = true; outline.setAttribute('aria-hidden', 'true');
    toolbar.append(status, pauseButton, stopButton, visible, text, url, reviewButton, cancel, hint); shadow.append(style, outline, toolbar); document.documentElement.append(host); syncToolbar();
  }
  function syncToolbar() {
    if (!host) { buildToolbar(); return; }
    host.hidden = !draft; toolbar.dataset.mode = draft?.mode || 'idle';
    status.textContent = (picker ? 'Select an assertion' : draft?.mode === 'recording' ? 'Recording' : draft?.mode === 'paused' ? 'Recording paused' : 'Draft ready') + ' · ' + (draft?.scenario.steps.length || 0) + '/50';
    pauseButton.hidden = stopButton.hidden = draft?.mode === 'stopped';
    pauseButton.textContent = draft?.mode === 'paused' ? 'Resume recording' : 'Pause recording';
    pauseButton.setAttribute('aria-pressed', String(draft?.mode === 'paused'));
    reviewButton.hidden = draft?.mode !== 'stopped';
    toolbar.querySelector('[data-cancel]').hidden = !picker;
    hint.textContent = picker ? 'Select page content, or use arrow keys and Enter. Escape cancels.' : message;
    hint.hidden = !hint.textContent;
  }
  const api = {
    getState: state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start({ name = 'New scenario' } = {}) {
      const path = currentPath(); if (!path) throw Error('Open an application route before recording.');
      draft = { version: 1, mode: 'recording', lastPath: path, updatedAt: Date.now(), scenario: { version: 1, name: String(name).trim().slice(0, 120) || 'New scenario', viewport: { width: Math.max(240, Math.min(2560, Math.round(view.innerWidth))), height: Math.max(240, Math.min(2560, Math.round(view.innerHeight))) }, steps: [{ type: 'visit', path }] } };
      picker = undefined; message = ''; persist(); notify();
    },
    pause() { if (draft?.mode === 'recording') { draft.mode = 'paused'; persist(); notify(); } },
    resume() { if (draft?.mode === 'paused' || draft?.mode === 'stopped') { draft.mode = 'recording'; recordNavigation(); persist(); notify(); } },
    stop() { if (draft) { draft.mode = 'stopped'; clearPicker(); persist(); notify(); } },
    discard() { draft = undefined; picker = undefined; message = ''; persist(); notify(); },
    setName(name) { if (draft) { draft.scenario.name = String(name).slice(0, 120); persist(); notify(); } },
    removeStep(index) { if (draft && index > 0 && index < draft.scenario.steps.length) { draft.scenario.steps.splice(index, 1); persist(); notify(); } },
    addURLAssertion() { const path = currentPath(); if (draft && path) append({ type: 'expectURL', path }); },
    pickAssertion(type) { if (!draft) throw Error('Record a scenario first.'); if (!['expectVisible', 'expectText'].includes(type)) throw Error('Choose a visible or text assertion.'); picker = type; keyboardTarget=undefined; message = ''; notify(); },
    cancelSelection: clearPicker,
    dispose() {
      if (disposed) return; disposed = true; controller.abort(); for (const restore of originals.reverse()) restore(); listeners.clear(); host?.remove();
      if (view[RECORDER] === api) delete view[RECORDER];
    },
  };
  view[RECORDER] = api;
  document.addEventListener('click', recordClick, options);
  document.addEventListener('input', recordFill, options); document.addEventListener('change', recordFill, options);
  document.addEventListener('pointermove', movePicker, options);
  document.addEventListener('focusin',event=>{if(picker){const element=eventElement(event);if(element&&!isReplaySensitiveField(element))outlineElement(element);}},options);
  document.addEventListener('keydown', event => {
    if (!picker) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); clearPicker(); }
    else if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();nextKeyboardTarget(['ArrowDown','ArrowRight'].includes(event.key)?1:-1);}
    else if (event.key === 'Enter' && (keyboardTarget||eventElement(event))) { event.preventDefault(); event.stopImmediatePropagation(); selectAssertion(keyboardTarget||eventElement(event)); }
  }, options);
  for (const name of ['pushState', 'replaceState']) {
    const original = view.history?.[name]; if (!original) continue;
    const wrapped = function (...args) { const result = Reflect.apply(original, this, args); recordNavigation(); return result; };
    try { view.history[name] = wrapped; originals.push(() => { if (view.history[name] === wrapped) view.history[name] = original; }); } catch {}
  }
  view.addEventListener('popstate', recordNavigation, { signal: controller.signal });
  view.addEventListener('pageshow', recordNavigation, { signal: controller.signal });
  document.addEventListener('DOMContentLoaded', buildToolbar, { once: true, signal: controller.signal });
  buildToolbar(); recordNavigation(); return api;
}
