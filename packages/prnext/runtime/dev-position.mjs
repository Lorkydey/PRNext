// Pointer capture stays on the logo: dragging never installs page-wide styles.
// A tab-local preference cannot override a newly configured default corner.
const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const preference = 'prnext:dev-corner:v1';

export function createDevPosition({ host, trigger, position, onDrag, announce }) {
  const view = host.ownerDocument.defaultView;
  const controller = new AbortController(), events = { signal: controller.signal };
  let current = corners.includes(position) ? position : 'bottom-left';
  const configured = current;
  try {
    const saved = JSON.parse(view.sessionStorage.getItem(preference));
    if (saved?.configured === configured && corners.includes(saved.corner)) current = saved.corner;
  } catch { /* Storage can be disabled by the browser. */ }
  host.dataset.position = current;
  trigger.style.touchAction = 'none';
  trigger.setAttribute('aria-description', 'Drag to a corner. Use Alt + arrow keys to move the logo.');
  trigger.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight');
  const hints = view.document.createElement('div'); hints.className = 'corner-hints'; hints.hidden = true; hints.setAttribute('aria-hidden', 'true');
  for (const corner of corners) {
    const node = view.document.createElement('span'); node.className = 'corner-hint'; node.dataset.corner = corner; hints.append(node);
  }
  host.shadowRoot.append(hints);
  let drag, motion, suppressClick = false;
  function viewport() {
    const port = view.visualViewport;
    return { x: port?.offsetLeft || 0, y: port?.offsetTop || 0, width: port?.width || view.innerWidth, height: port?.height || view.innerHeight };
  }
  function nearest(x, y) {
    const port = viewport();
    return `${y < port.y + port.height / 2 ? 'top' : 'bottom'}-${x < port.x + port.width / 2 ? 'left' : 'right'}`;
  }
  function highlight(corner) {
    for (const node of hints.children) node.dataset.active = String(node.dataset.corner === corner);
  }
  function clearCoordinates() {
    for (const name of ['top', 'right', 'bottom', 'left']) host.style.removeProperty(name);
  }
  function settle(corner, from, save = true) {
    motion?.cancel(); motion = null;
    current = corner; host.dataset.position = corner; clearCoordinates();
    const target = host.getBoundingClientRect();
    if (from && !view.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion = host.animate([
        { transform: `translate(${from.x - target.x}px,${from.y - target.y}px)` },
        { transform: 'translate(0,0)' },
      ], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    if (save) {
      try { view.sessionStorage.setItem(preference, JSON.stringify({ configured, corner })); } catch {}
      announce(`Logo moved to ${corner.replace('-', ' ')}.`);
    }
  }
  function finish(cancel = false) {
    if (!drag) return;
    const state = drag; drag = null;
    if (state.moved) {
      suppressClick = true;
      const from = host.getBoundingClientRect();
      hints.hidden = true; delete host.dataset.dragging;
      settle(cancel ? state.corner : nearest(from.x + 22, from.y + 22), from, !cancel);
    }
    if (trigger.hasPointerCapture(state.pointer)) trigger.releasePointerCapture(state.pointer);
  }
  trigger.addEventListener('pointerdown', event => {
    if (drag || event.button !== 0 || !event.isPrimary) return;
    suppressClick = false;
    const rect = host.getBoundingClientRect();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, rect, corner: current, moved: false };
    trigger.setPointerCapture(event.pointerId);
  }, events);
  trigger.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true; motion?.cancel(); motion = null; onDrag();
      host.dataset.dragging = 'true'; hints.hidden = false;
    }
    event.preventDefault();
    const port = viewport();
    const x = Math.max(port.x + 4, Math.min(port.x + port.width - 48, drag.rect.x + dx));
    const y = Math.max(port.y + 4, Math.min(port.y + port.height - 48, drag.rect.y + dy));
    host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.right = 'auto'; host.style.bottom = 'auto';
    highlight(nearest(x + 22, y + 22));
  }, events);
  trigger.addEventListener('pointerup', event => { if(event.pointerId === drag?.pointer) finish(); }, events);
  trigger.addEventListener('pointercancel', event => { if(event.pointerId === drag?.pointer) finish(true); }, events);
  trigger.addEventListener('lostpointercapture', event => { if(event.pointerId === drag?.pointer) finish(true); }, events);
  trigger.addEventListener('dragstart', event => event.preventDefault(), events);
  trigger.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, { ...events, capture: true });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag?.moved) { event.preventDefault(); event.stopPropagation(); finish(true); }
    if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rect = host.getBoundingClientRect(); onDrag();
    const [vertical, horizontal] = current.split('-');
    settle(`${event.key === 'ArrowUp' ? 'top' : event.key === 'ArrowDown' ? 'bottom' : vertical}-${event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : horizontal}`, rect);
  }, events);
  function resize() { if (drag) finish(true); motion?.cancel(); motion = null; }
  view.addEventListener('resize', resize, events);
  view.addEventListener('blur', () => finish(true), events);
  view.visualViewport?.addEventListener('resize', resize, events);
  return { dispose() { controller.abort(); motion?.cancel(); hints.remove(); } };
}
