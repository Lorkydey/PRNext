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

// Inward folding brings the moving edge toward the viewer. Include its
// perspective enlargement in both axes, even just before the faces close.
export function duoFoldProjection(progress) {
  const angle = Math.max(0, Math.min(1, progress)) * Math.PI;
  const cross = 4 / (4 - Math.sin(angle)), edge = 1 + Math.cos(angle) * cross;
  return { min: Math.min(0, edge), max: Math.max(1, edge), cross };
}

export function createDuoPreview({ frameWrap, screen }) {
  const document = frameWrap.ownerDocument, view = document.defaultView;
  const node = className => { const element = document.createElement('div'); element.className = className; return element; };
  const root = node('wb-duo-layer'), shell = node('wb-duo-shell'), first = node('wb-duo-panel'),
    crease = node('wb-duo-crease'), leaf = node('wb-duo-leaf');
  const innerFace=node('wb-duo-inner-face'),coverFace=node('wb-duo-cover-face');
  innerFace.append(node('wb-duo-glass'));coverFace.append(node('wb-duo-glass'),node('wb-duo-camera'));
  leaf.append(innerFace,coverFace);root.append(shell,first,crease,leaf,node('wb-duo-camera wb-duo-static-camera'));
  root.setAttribute('aria-hidden', 'true'); root.hidden = true; leaf.hidden = true; frameWrap.append(root);
  let layout, motions = [], epoch = 0;
  function place(element, rect, scale) {
    Object.assign(element.style, { left: (rect.x || 0) * scale + 'px', top: (rect.y || 0) * scale + 'px', width: rect.width * scale + 'px', height: rect.height * scale + 'px' });
  }
  function cancel() {
    epoch++; for (const motion of motions) motion.cancel(); motions = [];
    leaf.hidden = true; delete frameWrap.dataset.foldAnimating;
    screen.style.removeProperty('clip-path');screen.style.removeProperty('transform-origin');frameWrap.style.removeProperty('transform-origin');
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
    leaf.style.transform = `rotate${rotated ? 'X' : 'Y'}(${folded ? rotated ? 180 : -180 : 0}deg)`;
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
    const target = Number(folded), axis = rotated ? 'X' : 'Y', sign = rotated ? 1 : -1;
    const options = { duration: Math.max(160, 820 * Math.abs(target - before.progress)), easing: 'cubic-bezier(.4,0,.2,1)' };
    frameWrap.style.transformOrigin = `${after.x + after.width / 2 - wrap.x}px ${after.y + after.height / 2 - wrap.y}px`;
    frameWrap.dataset.foldAnimating = 'true'; leaf.hidden = false;
    screen.style.transformOrigin='0 0';
    const ticket = ++epoch;
    const beforeProjection=duoFoldProjection(before.progress),beforeCenter=(beforeProjection.min+beforeProjection.max-1)/2;
    const startX = before.rect.x + before.rect.width / 2 + (rotated ? 0 : before.rect.width*beforeCenter),
      startY = before.rect.y + before.rect.height / 2 + (rotated ? before.rect.height*beforeCenter : 0);
    const availableWidth = Math.max(1, frameWrap.parentElement.clientWidth - 40), availableHeight = Math.max(1, frameWrap.parentElement.clientHeight - 40), keyframes = [],surfaces=[],viewports=[],housing=[];
    const panelWidth=metrics.panel.width*scale,panelHeight=metrics.panel.height*scale,bezel=12*scale;
    const originX=rotated?panelWidth/2:panelWidth,originY=rotated?panelHeight:panelHeight/2,perspective=(rotated?panelHeight:panelWidth)*4;
    for (let index = 0; index <= 48; index++) {
      const t = index / 48, progress = before.progress + (target - before.progress) * t;
      let fitX = ratioX + (1 - ratioX) * t, fitY = ratioY + (1 - ratioY) * t;
      const projection=duoFoldProjection(progress),extent=projection.max-projection.min,center=(projection.min+projection.max-1)/2;
      const fit = Math.min(1, availableWidth / (after.width*(rotated?projection.cross:extent)*fitX), availableHeight / (after.height*(rotated?extent:projection.cross)*fitY));
      fitX *= fit; fitY *= fit;
      const centerX = startX + (wrap.x + wrap.width / 2 - startX) * t,
        centerY = startY + (wrap.y + wrap.height / 2 - startY) * t;
      const dx = centerX - after.x - after.width / 2 - (rotated ? 0 : after.width*center*fitX),
        dy = centerY - after.y - after.height / 2 - (rotated ? after.height*center*fitY : 0);
      keyframes.push({ offset: t, transform: index === 48 ? 'none' : `translate(${dx.toFixed(4)}px,${dy.toFixed(4)}px) scale(${fitX.toFixed(6)},${fitY.toFixed(6)})` });
      // The stationary hinge is square only when flat. Round its corners as
      // the leaf closes so they cannot protrude behind the curved cover.
      const radius=32*scale,hingeRadius=Math.min(1,progress*2)*radius;
      housing.push({offset:t,borderRadius:rotated?`${radius}px ${radius}px ${hingeRadius}px ${hingeRadius}px`:`${radius}px ${hingeRadius}px ${hingeRadius}px ${radius}px`});
      // One live iframe serves the inner display, then the reverse of the
      // moving leaf. A short dark interval models the display handover. No DOM
      // reparenting, screenshots, mirrored page or second application instance.
      const outer=progress>=.5,viewport=duoViewport(outer,rotated);
      const width=(outer||rotated?panelWidth:panelWidth*2)-bezel*2,
        height=(outer||!rotated?panelHeight:panelHeight*2)-bezel*2;
      const rotation=`rotate${axis}(${progress*sign*180}deg)`,reverse=`rotate${axis}(180deg)`;
      const transform=outer?`translate(${originX}px,${originY}px) perspective(${perspective}px) translate(${-originX}px,${-originY}px) translate(${rotated?0:panelWidth}px,${rotated?panelHeight:0}px) ${rotation} translate3d(${rotated?0:panelWidth}px,${rotated?panelHeight:0}px,${-.6*scale}px) ${reverse} translate(${bezel}px,${bezel}px)`:`translate(${bezel}px,${bezel}px)`;
      const opacity=Math.max(0,Math.min(1,outer?(progress-.51)/.20:(.49-progress)/.10));
      // Reveal the continuous viewport as the leaf approaches flat, instead of
      // retaining a hard center cut until the animation's final frame.
      const hiddenHalf=Math.min(1,progress/.12)/2;
      surfaces.push({offset:t,left:'0px',top:'0px',width:width+'px',height:height+'px',transform,opacity,
        clipPath:outer?'inset(0)':rotated?`inset(0 0 ${height*hiddenHalf}px 0)`:`inset(0 ${width*hiddenHalf}px 0 0)`});
      viewports.push({offset:t,width:viewport.width+'px',height:viewport.height+'px',transform:`scale(${width/viewport.width},${height/viewport.height})`,easing:'steps(1,end)'});
    }
    const move = frameWrap.animate(keyframes, options);
    const fold = leaf.animate([{ transform: `rotate${axis}(${before.progress * sign * 180}deg)` }, { transform: `rotate${axis}(${target * sign * 180}deg)` }], options);
    const surface=screen.animate(surfaces,options),frame=screen.querySelector('iframe');
    motions = [move,fold,surface,shell.animate(housing,options)];if(frame)motions.push(frame.animate(viewports,options));
    fold.onfinish = () => { if (ticket === epoch) cancel(); };
  }
  return { update, capture, animate, cancel, dispose() { cancel(); root.remove(); } };
}
