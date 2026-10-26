// Mouse panning for same-origin mobile previews. Real touch/pen events retain
// their native behavior; inputs and application-owned drag surfaces stay native.
export function createPreviewTouch(document) {
  const view = document.defaultView, root = document.documentElement;
  if (!view?.PointerEvent || !root) return { cancel() {}, dispose() {} };
  const controller = new view.AbortController(), capture = { capture: true, signal: controller.signal };
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  let gesture, momentum = 0, blockedClick, sendingCancel = false;

  function stopMomentum() { if (momentum) { try { view.cancelAnimationFrame(momentum); } catch {} } momentum = 0; }
  function release(state) {
    try { if (root.hasPointerCapture(state.pointer)) root.releasePointerCapture(state.pointer); } catch {}
  }
  function cancel() {
    stopMomentum(); const state = gesture; gesture = undefined; blockedClick = undefined;
    if (state) release(state);
  }
  function scrollPlan(event) {
    const elements = event.composedPath().filter(node => node?.nodeType === 1);
    if (elements.some(node => node.matches('input,textarea,select,option,video,audio,canvas,[role="slider"],[role="spinbutton"],[draggable="true"]') || node.isContentEditable)) return;
    const chain = []; let x = true, y = true;
    for (const node of elements) {
      const style = view.getComputedStyle(node), action = style.touchAction;
      if (action === 'none') return;
      if (/pan-/.test(action)) {
        x &&= /pan-(x|left|right)/.test(action); y &&= /pan-(y|up|down)/.test(action);
      }
      const viewport = node === document.scrollingElement;
      // With visible root overflow, body overflow controls the viewport.
      const overflowX = viewport && style.overflowX === 'visible' ? view.getComputedStyle(document.body || node).overflowX : style.overflowX;
      const overflowY = viewport && style.overflowY === 'visible' ? view.getComputedStyle(document.body || node).overflowY : style.overflowY;
      const canX = (viewport ? !/hidden|clip/.test(overflowX) : /auto|scroll|overlay/.test(overflowX)) && node.scrollWidth > node.clientWidth + 1;
      const canY = (viewport ? !/hidden|clip/.test(overflowY) : /auto|scroll|overlay/.test(overflowY)) && node.scrollHeight > node.clientHeight + 1;
      if (canX || canY) chain.push({ node, x: canX, y: canY, overscrollX: style.overscrollBehaviorX, overscrollY: style.overscrollBehaviorY });
    }
    if (chain.length && (x || y)) return { chain, x, y };
  }
  function pan(state, distance) {
    let remaining = distance, consumed = 0;
    const horizontal = state.axis === 'x', property = horizontal ? 'scrollLeft' : 'scrollTop';
    for (const entry of state.chain) {
      if (!entry[state.axis]) continue;
      const before = entry.node[property];
      entry.node.scrollBy({ [horizontal ? 'left' : 'top']: remaining, behavior: 'instant' });
      const moved = entry.node[property] - before; consumed += moved; remaining -= moved;
      if (Math.abs(remaining) < .5 || /contain|none/.test(entry[horizontal ? 'overscrollX' : 'overscrollY'])) break;
    }
    return consumed;
  }
  function coast(state) {
    if (reduced.matches || Math.abs(state.velocity) < .08 || view.performance.now() - state.time > 80) return;
    const started = view.performance.now(); let previous = started, velocity = state.velocity;
    const tick = now => {
      momentum = 0;
      const elapsed = Math.min(32, now - previous); previous = now;
      if (now - started > 700 || Math.abs(velocity) < .02) return;
      const moved = pan(state, velocity * elapsed);
      velocity *= Math.exp(-elapsed / 160);
      if (Math.abs(moved) > .1) momentum = view.requestAnimationFrame(tick);
    };
    momentum = view.requestAnimationFrame(tick);
  }
  function begin(event) {
    if (event.pointerType !== 'mouse') { cancel(); return; }
    if (event.pointerType !== 'mouse' || !event.isPrimary || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    cancel(); const plan = scrollPlan(event); if (!plan) return;
    gesture = { ...plan, pointer: event.pointerId, target: event.target, startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, time: view.performance.now(), velocity: 0, axis: undefined };
  }
  function move(event) {
    const state = gesture; if (!state || event.pointerId !== state.pointer) return;
    const now = view.performance.now();
    if (!state.axis) {
      const dx = event.clientX - state.startX, dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) < 6) return;
      const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (!state[axis] || !state.chain.some(entry => entry[axis])) { gesture = undefined; return; }
      state.axis = axis;
      // Like native panning, release the control that received pointerdown so
      // pressed controls and custom pointer capture do not remain stuck.
      sendingCancel = true;
      try { state.target.dispatchEvent(new view.PointerEvent('pointercancel', { bubbles: true, composed: true, pointerId: state.pointer, pointerType: 'mouse', isPrimary: true })); }
      finally { sendingCancel = false; }
      if (gesture !== state) return;
      try { root.setPointerCapture(state.pointer); } catch {}
    }
    event.preventDefault(); event.stopImmediatePropagation();
    const delta = state.axis === 'x' ? state.lastX - event.clientX : state.lastY - event.clientY;
    const moved = pan(state, delta), elapsed = Math.max(8, now - state.time);
    const speed = Math.max(-3, Math.min(3, moved / elapsed));
    state.velocity = speed * .7 + state.velocity * .3;
    state.lastX = event.clientX; state.lastY = event.clientY; state.time = now;
  }
  function end(event) {
    const state = gesture; if (!state || event.pointerId !== state.pointer) return;
    gesture = undefined;
    if (state.axis) {
      event.preventDefault(); event.stopImmediatePropagation();
      blockedClick = { pointer: state.pointer, time: view.performance.now() }; coast(state);
    }
    release(state);
  }
  function preventActivation(event) {
    if (!blockedClick || event.detail === 0 || view.performance.now() - blockedClick.time > 500) return;
    if (event.pointerId !== undefined && event.pointerId !== blockedClick.pointer) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'click') blockedClick = undefined;
  }
  document.addEventListener('pointerdown', begin, capture);
  document.addEventListener('pointermove', move, { ...capture, passive: false });
  document.addEventListener('pointerup', end, capture);
  document.addEventListener('pointercancel', event => { if (!sendingCancel && event.pointerId === gesture?.pointer) cancel(); }, capture);
  document.addEventListener('lostpointercapture', event => { if (event.target === root && event.pointerId === gesture?.pointer) cancel(); }, capture);
  document.addEventListener('click', preventActivation, capture);
  document.addEventListener('mouseup', preventActivation, capture);
  for (const name of ['selectstart', 'dragstart']) document.addEventListener(name, event => { if (gesture) event.preventDefault(); }, capture);
  document.addEventListener('wheel', cancel, { ...capture, passive: true });
  document.addEventListener('keydown', cancel, capture);
  for (const name of ['blur', 'pagehide', 'resize']) view.addEventListener(name, cancel, { signal: controller.signal });
  reduced.addEventListener('change', cancel, { signal: controller.signal });
  return { cancel, dispose() { cancel(); controller.abort(); } };
}
