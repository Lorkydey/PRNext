// Surface Duo CSS viewport presets. Hardware/hinge visuals do not override
// the browser's Device Posture or Viewport Segments APIs.
export function duoViewport(folded = false, rotated = false) {
  const width = folded ? 540 : 1114, height = 720;
  return rotated ? {
    width: height, height: width, inset: [12, 24, folded ? 22 : 12, 24],
    panel: { width: 768, height: 564 }, second: { x: 0, y: 574 },
    spine: { x: 0, y: 564, width: 768, height: 10 },
    gap: { x: 24, y: 552, width: 720, height: 34 },
  } : {
    width, height, inset: [24, folded ? 22 : 12, 24, 12],
    panel: { width: 564, height: 768 }, second: { x: 574, y: 0 },
    spine: { x: 564, y: 0, width: 10, height: 768 },
    gap: { x: 552, y: 24, width: 34, height: 720 },
  };
}

// Projected extra width/height beyond the first housing while the second leaf
// folds behind it. The ratio lets the whole motion fit inside a small canvas.
export function duoFoldExtent(progress) {
  const angle = Math.max(0, Math.min(1, progress)) * Math.PI;
  return (10 + Math.max(0, Math.cos(angle)) * 564 * 1800 / (1800 + Math.sin(angle) * 564)) / 564;
}

export function createDuoPreview({ frameWrap, screen }) {
  const document = frameWrap.ownerDocument, view = document.defaultView;
  const node = className => { const element = document.createElement('div'); element.className = className; return element; };
  const root = node('wb-duo-layer'), first = node('wb-duo-panel'), second = node('wb-duo-panel wb-duo-second'),
    gap = node('wb-duo-gap'), spine = node('wb-duo-spine'), leaf = node('wb-duo-leaf');
  leaf.append(node('wb-duo-glass')); root.append(first, second, gap, spine, leaf);
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
    place(first, metrics.panel, scale); place(second, { ...metrics.panel, ...metrics.second }, scale);
    place(leaf, { ...metrics.panel, ...metrics.second }, scale); place(gap, metrics.gap, scale); place(spine, metrics.spine, scale);
    second.hidden = folded; gap.hidden = folded;
    root.style.setProperty('--duo-radius', 22 * scale + 'px');
    root.style.setProperty('--duo-side', (rotated ? 24 : 12) * scale + 'px');
    root.style.setProperty('--duo-end', (rotated ? 12 : 24) * scale + 'px');
    root.style.setProperty('--duo-glass-radius', 8 * scale + 'px');
    root.style.perspective = 1800 * scale + 'px';
    root.style.perspectiveOrigin = rotated ? `${metrics.panel.width * scale / 2}px ${metrics.spine.y * scale}px` : `${metrics.spine.x * scale}px ${metrics.panel.height * scale / 2}px`;
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
    const ratio = before.rect.width / after.width;
    const target = Number(folded), axis = rotated ? 'X' : 'Y', sign = rotated ? -1 : 1;
    const options = { duration: Math.max(140, 620 * Math.abs(target - before.progress)), easing: 'cubic-bezier(.22,1,.36,1)' };
    frameWrap.style.transformOrigin = `${after.x + after.width / 2 - wrap.x}px ${after.y + after.height / 2 - wrap.y}px`;
    frameWrap.dataset.foldAnimating = 'true'; leaf.hidden = false;
    screen.style.clipPath = rotated ? `inset(0 0 ${Math.max(0, metrics.height - 540) * scale}px 0)` : `inset(0 ${Math.max(0, metrics.width - 540) * scale}px 0 0)`;
    const ticket = ++epoch;
    const beforeExtra = (rotated ? before.rect.height : before.rect.width) * duoFoldExtent(before.progress);
    const startX = before.rect.x + before.rect.width / 2 + (rotated ? 0 : beforeExtra / 2),
      startY = before.rect.y + before.rect.height / 2 + (rotated ? beforeExtra / 2 : 0);
    const availableWidth = Math.max(1, frameWrap.parentElement.clientWidth - 40), availableHeight = Math.max(1, frameWrap.parentElement.clientHeight - 40), keyframes = [];
    for (let index = 0; index <= 24; index++) {
      const t = index / 24, progress = before.progress + (target - before.progress) * t;
      let fit = ratio + (1 - ratio) * t;
      const extra = (rotated ? after.height : after.width) * duoFoldExtent(progress);
      fit *= Math.min(1, availableWidth / ((after.width + (rotated ? 0 : extra)) * fit), availableHeight / ((after.height + (rotated ? extra : 0)) * fit));
      const centerX = startX + (wrap.x + wrap.width / 2 - startX) * t,
        centerY = startY + (wrap.y + wrap.height / 2 - startY) * t;
      const dx = centerX - after.x - after.width / 2 - (rotated ? 0 : extra * fit / 2),
        dy = centerY - after.y - after.height / 2 - (rotated ? extra * fit / 2 : 0);
      keyframes.push({ offset: t, transform: index === 24 ? 'none' : `translate(${dx.toFixed(4)}px,${dy.toFixed(4)}px) scale(${fit.toFixed(6)})` });
    }
    const move = frameWrap.animate(keyframes, options);
    const fold = leaf.animate([{ transform: `rotate${axis}(${before.progress * sign * 180}deg)` }, { transform: `rotate${axis}(${target * sign * 180}deg)` }], options);
    motions = [move, fold]; fold.onfinish = () => { if (ticket === epoch) cancel(); };
  }
  return { update, capture, animate, cancel, dispose() { cancel(); root.remove(); } };
}
