// Approximate iPhone Duo-style layout sizes, using the published panel pixels
// at an assumed 3x scale: https://www.apple.com/iphone-duo/specs/
// These are visual presets, not measured Safari viewports or iOS emulation.
export function duoViewport(folded = false, rotated = false) {
  const width = folded ? 466 : 890, height = folded ? 678 : 626;
  const panelWidth = folded ? width + 24 : (width + 24) / 2, panelHeight = height + 24;
  return rotated ? {
    width: height, height: width, inset: [12, 12, 12, 12],
    panel: { width: panelHeight, height: panelWidth }, second: { x: 0, y: panelWidth },
    crease: { x: 12, y: panelWidth - 7, width: height, height: 14 }, frontSpan: folded ? width : width / 2,
  } : {
    width, height, inset: [12, 12, 12, 12],
    panel: { width: panelWidth, height: panelHeight }, second: { x: panelWidth, y: 0 },
    crease: { x: panelWidth - 7, y: 12, width: 14, height }, frontSpan: folded ? width : width / 2,
  };
}

// The second half shares the fold axis with the first: no dead hinge pixels.
// Use a dimensionless perspective ratio so retargeting keeps its geometry.
export function duoFoldExtent(progress) {
  const angle = Math.max(0, Math.min(1, progress)) * Math.PI;
  return Math.max(0, Math.cos(angle)) * 4 / (4 + Math.sin(angle));
}

export function createDuoPreview({ frameWrap, screen }) {
  const document = frameWrap.ownerDocument, view = document.defaultView;
  const node = className => { const element = document.createElement('div'); element.className = className; return element; };
  const root = node('wb-duo-layer'), shell = node('wb-duo-shell'), first = node('wb-duo-panel'),
    crease = node('wb-duo-crease'), leaf = node('wb-duo-leaf');
  leaf.append(node('wb-duo-glass')); root.append(shell, first, crease, leaf);
  root.setAttribute('aria-hidden', 'true'); root.hidden = true; leaf.hidden = true; frameWrap.append(root);
  let layout, motions = [], epoch = 0;
  function place(element, rect, scale) {
    Object.assign(element.style, { left: (rect.x || 0) * scale + 'px', top: (rect.y || 0) * scale + 'px', width: rect.width * scale + 'px', height: rect.height * scale + 'px' });
  }
  function cancel() {
    epoch++; for (const motion of motions) motion.cancel(); motions = [];
    leaf.hidden = true; delete frameWrap.dataset.foldAnimating;
    screen.style.removeProperty('clip-path'); frameWrap.style.removeProperty('transform-origin');
  }
  function update(next) {
    layout = next; root.hidden = !next;
    if (!next) { cancel(); return; }
    const { folded, rotated, scale, metrics } = next;
    root.dataset.rotated = String(rotated); frameWrap.dataset.folded = String(folded);
    place(first, metrics.panel, scale); place(leaf, { ...metrics.panel, ...metrics.second }, scale); place(crease, metrics.crease, scale);
    crease.hidden = folded;
    root.style.setProperty('--duo-radius', 32 * scale + 'px');
    root.style.setProperty('--duo-bezel', 12 * scale + 'px');
    root.style.setProperty('--duo-glass-radius', 20 * scale + 'px');
    root.style.setProperty('--duo-panel-width', metrics.panel.width * scale + 'px');
    root.style.setProperty('--duo-panel-height', metrics.panel.height * scale + 'px');
    root.style.perspective = (rotated ? metrics.panel.height : metrics.panel.width) * 4 * scale + 'px';
    root.style.perspectiveOrigin = rotated ? `${metrics.panel.width * scale / 2}px ${metrics.second.y * scale}px` : `${metrics.second.x * scale}px ${metrics.panel.height * scale / 2}px`;
    leaf.style.transformOrigin = rotated ? 'center top' : 'left center';
    leaf.style.transform = `rotate${rotated ? 'X' : 'Y'}(${folded ? rotated ? -180 : 180 : 0}deg)`;
  }
  function capture() {
    if (!layout || root.hidden) return null;
    let progress = Number(layout.folded);
    if (motions.length) {
      const matrix = new view.DOMMatrixReadOnly(view.getComputedStyle(leaf).transform);
      const radians = layout.rotated ? Math.atan2(matrix.m23, matrix.m22) : Math.atan2(-matrix.m13, matrix.m11);
      progress = Math.max(0, Math.min(1, Math.abs(radians) / Math.PI));
    }
    return { rect: first.getBoundingClientRect(), progress, rotated: layout.rotated };
  }
  function animate(before) {
    if (!before || !layout || before.rotated !== layout.rotated || !before.rect.width || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const after = first.getBoundingClientRect(), wrap = frameWrap.getBoundingClientRect(), { rotated, folded, scale, metrics } = layout;
    const ratioX = before.rect.width / after.width, ratioY = before.rect.height / after.height;
    const target = Number(folded), axis = rotated ? 'X' : 'Y', sign = rotated ? -1 : 1;
    const options = { duration: Math.max(140, 620 * Math.abs(target - before.progress)), easing: 'cubic-bezier(.22,1,.36,1)' };
    frameWrap.style.transformOrigin = `${after.x + after.width / 2 - wrap.x}px ${after.y + after.height / 2 - wrap.y}px`;
    frameWrap.dataset.foldAnimating = 'true'; leaf.hidden = false;
    screen.style.clipPath = rotated ? `inset(0 0 ${Math.max(0, metrics.height - metrics.frontSpan) * scale}px 0)` : `inset(0 ${Math.max(0, metrics.width - metrics.frontSpan) * scale}px 0 0)`;
    const ticket = ++epoch;
    const beforeExtra = (rotated ? before.rect.height : before.rect.width) * duoFoldExtent(before.progress);
    const startX = before.rect.x + before.rect.width / 2 + (rotated ? 0 : beforeExtra / 2),
      startY = before.rect.y + before.rect.height / 2 + (rotated ? beforeExtra / 2 : 0);
    const availableWidth = Math.max(1, frameWrap.parentElement.clientWidth - 40), availableHeight = Math.max(1, frameWrap.parentElement.clientHeight - 40), keyframes = [];
    for (let index = 0; index <= 24; index++) {
      const t = index / 24, progress = before.progress + (target - before.progress) * t;
      let fitX = ratioX + (1 - ratioX) * t, fitY = ratioY + (1 - ratioY) * t;
      const extra = (rotated ? after.height : after.width) * duoFoldExtent(progress);
      const fit = Math.min(1, availableWidth / ((after.width + (rotated ? 0 : extra)) * fitX), availableHeight / ((after.height + (rotated ? extra : 0)) * fitY));
      fitX *= fit; fitY *= fit;
      const centerX = startX + (wrap.x + wrap.width / 2 - startX) * t,
        centerY = startY + (wrap.y + wrap.height / 2 - startY) * t;
      const dx = centerX - after.x - after.width / 2 - (rotated ? 0 : extra * fitX / 2),
        dy = centerY - after.y - after.height / 2 - (rotated ? extra * fitY / 2 : 0);
      keyframes.push({ offset: t, transform: index === 24 ? 'none' : `translate(${dx.toFixed(4)}px,${dy.toFixed(4)}px) scale(${fitX.toFixed(6)},${fitY.toFixed(6)})` });
    }
    const move = frameWrap.animate(keyframes, options);
    const fold = leaf.animate([{ transform: `rotate${axis}(${before.progress * sign * 180}deg)` }, { transform: `rotate${axis}(${target * sign * 180}deg)` }], options);
    motions = [move, fold]; fold.onfinish = () => { if (ticket === epoch) cancel(); };
  }
  return { update, capture, animate, cancel, dispose() { cancel(); root.remove(); } };
}
