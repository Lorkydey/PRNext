// Geometry is local to the embedded console. Detached windows use native chrome.
export function fitConsoleRect(rect, bounds, minimum) {
  const width = Math.min(bounds.width, Math.max(Math.min(minimum.width, bounds.width), rect.width));
  const height = Math.min(bounds.height, Math.max(Math.min(minimum.height, bounds.height), rect.height));
  return { x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, rect.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, rect.y)), width, height };
}

export function resizeConsoleRect(rect, edge, dx, dy, bounds, minimum) {
  const start = fitConsoleRect(rect, bounds, minimum), right = start.x + start.width, bottom = start.y + start.height;
  const width = Math.min(minimum.width, bounds.width), height = Math.min(minimum.height, bounds.height);
  let x = start.x, y = start.y, endX = right, endY = bottom;
  if (edge.includes('w')) x = Math.max(bounds.x, Math.min(right - width, x + dx));
  if (edge.includes('e')) endX = Math.min(bounds.x + bounds.width, Math.max(x + width, right + dx));
  if (edge.includes('n')) y = Math.max(bounds.y, Math.min(bottom - height, y + dy));
  if (edge.includes('s')) endY = Math.min(bounds.y + bounds.height, Math.max(y + height, bottom + dy));
  return { x, y, width: endX - x, height: endY - y };
}

export function createConsoleWindow({ panel, heading, enabled, minimumHeight, onInteract, announce }) {
  const document = panel.ownerDocument, view = document.defaultView;
  const controller = new AbortController(), events = { signal: controller.signal };
  const properties = ['left', 'top', 'right', 'bottom', 'width', 'height', 'min-height'];
  const handles = [];
  let saved, gesture, disposed = false;
  function bounds() {
    const port = view.visualViewport, inset = 8;
    return { x: (port?.offsetLeft || 0) + inset, y: (port?.offsetTop || 0) + inset,
      width: Math.max(1, (port?.width || view.innerWidth) - inset * 2), height: Math.max(1, (port?.height || view.innerHeight) - inset * 2) };
  }
  function minimum() { return { width: 320, height: Math.max(180, minimumHeight()) }; }
  function available() { return !disposed && !panel.hidden && enabled(); }
  function clear() { for (const name of properties) panel.style.removeProperty(name); }
  function finishEntrance() { for (const animation of panel.getAnimations()) if (animation.animationName === 'wb-enter') animation.finish(); }
  function apply(rect) {
    saved = fitConsoleRect(rect, bounds(), minimum());
    Object.assign(panel.style, { left: saved.x + 'px', top: saved.y + 'px', right: 'auto', bottom: 'auto',
      width: saved.width + 'px', height: saved.height + 'px', minHeight: Math.min(minimum().height, bounds().height) + 'px' });
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const state = gesture; gesture = undefined;
    delete panel.dataset.windowGesture;
    if (cancel && state.moved) { saved = state.previous; if (saved && available()) apply(saved); else clear(); }
    if (state.target.hasPointerCapture(state.pointer)) state.target.releasePointerCapture(state.pointer);
    if (!cancel && state.moved) announce(`Console ${state.edge ? 'resized to ' + Math.round(saved.width) + ' by ' + Math.round(saved.height) + ' pixels' : 'moved'}.`);
  }
  function start(event, edge = '') {
    if (!available() || gesture || event.button !== 0 || !event.isPrimary) return;
    if (!edge && event.target.closest('button,input,select,a,textarea')) return;
    if (edge) event.preventDefault();
    finishEntrance();
    const target = event.currentTarget, rect = panel.getBoundingClientRect();
    gesture = { target, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, previous: saved && { ...saved }, edge, moved: false };
    target.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (!available()) { finish(true); return; }
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < (event.pointerType === 'touch' ? 6 : 3)) return;
    if (!gesture.moved) { gesture.moved = true; onInteract(); panel.dataset.windowGesture = gesture.edge || 'move'; }
    event.preventDefault();
    apply(gesture.edge ? resizeConsoleRect(gesture.rect, gesture.edge, dx, dy, bounds(), minimum()) :
      { ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy });
  }
  for (const edge of ['n','e','s','w','ne','se','sw','nw']) {
    const handle = document.createElement('div'); handle.className = 'wb-window-edge'; handle.dataset.edge = edge;
    handle.setAttribute('aria-hidden', 'true'); panel.append(handle); handles.push(handle);
    handle.addEventListener('pointerdown', event => start(event, edge), events);
  }
  heading.addEventListener('pointerdown', event => start(event), events);
  for (const target of [heading, ...handles]) {
    target.addEventListener('pointermove', move, events);
    target.addEventListener('pointerup', event => { if (event.pointerId === gesture?.pointer) finish(); }, events);
    for (const type of ['pointercancel','lostpointercapture']) target.addEventListener(type, event => { if (event.pointerId === gesture?.pointer) finish(true); }, events);
    target.addEventListener('dragstart', event => event.preventDefault(), events);
  }
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopImmediatePropagation(); finish(true); return; }
    if (event.target !== heading || !available() || !event.altKey || event.ctrlKey || event.metaKey || !event.key.startsWith('Arrow')) return;
    event.preventDefault(); event.stopPropagation(); onInteract();
    finishEntrance();
    const rect = panel.getBoundingClientRect(), dx = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0,
      dy = event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0;
    apply(event.shiftKey ? resizeConsoleRect(rect, dx ? 'e' : 's', dx, dy, bounds(), minimum()) : { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height });
    announce(`Console ${event.shiftKey ? 'resized to ' + Math.round(saved.width) + ' by ' + Math.round(saved.height) + ' pixels' : 'moved'}.`);
  }, { ...events, capture: true });
  function sync() {
    finish(true);
    if (available()) {
      panel.dataset.windowControls = 'true'; heading.tabIndex = 0; heading.setAttribute('role', 'group');
      heading.setAttribute('aria-label', 'Move and resize client console');
      heading.setAttribute('aria-description', 'Drag to move. Alt + arrow keys move; Alt + Shift + arrow keys resize.');
      heading.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
      if (saved) apply(saved);
    } else {
      clear(); delete panel.dataset.windowControls;
      for (const name of ['tabindex','role','aria-label','aria-description','aria-keyshortcuts']) heading.removeAttribute(name);
    }
  }
  function viewportChanged() { if (available() && saved) { finish(); apply(saved); } }
  view.addEventListener('resize', viewportChanged, events);
  view.visualViewport?.addEventListener('resize', viewportChanged, events);
  view.visualViewport?.addEventListener('scroll', viewportChanged, events);
  view.addEventListener('blur', () => finish(true), events);
  sync();
  return { sync, dispose() { finish(true); disposed = true; controller.abort(); clear(); delete panel.dataset.windowControls; for (const handle of handles) handle.remove(); } };
}
