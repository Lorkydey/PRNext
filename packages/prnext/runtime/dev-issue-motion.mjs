// A bounded, reversible transfer between the existing issue ring and menu border.
const NS = 'http://www.w3.org/2000/svg';
const circleStart = -113.4 * Math.PI / 180, arcControl = 4 / 3 * Math.tan(Math.PI / 16), cornerControl = 4 / 3 * Math.tan(Math.PI / 8);
const lerp = (a, b, t) => a + (b - a) * t;
const number = value => Number(value.toFixed(4));
let revealSequence = 0;

function circle(cx, cy, radius) {
  const result = [cx + radius * Math.cos(circleStart), cy + radius * Math.sin(circleStart)];
  for (let index = 0; index < 8; index++) {
    const a = circleStart + index * Math.PI / 4, b = a + Math.PI / 4;
    result.push(cx + radius * (Math.cos(a) - arcControl * Math.sin(a)), cy + radius * (Math.sin(a) + arcControl * Math.cos(a)),
      cx + radius * (Math.cos(b) + arcControl * Math.sin(b)), cy + radius * (Math.sin(b) - arcControl * Math.cos(b)), cx + radius * Math.cos(b), cy + radius * Math.sin(b));
  }
  return result;
}
function rectangle(x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2)), k = r * cornerControl, right = x + width, bottom = y + height;
  const points = [x + r, y];
  const line = (ax, ay, bx, by) => points.push(lerp(ax, bx, 1 / 3), lerp(ay, by, 1 / 3), lerp(ax, bx, 2 / 3), lerp(ay, by, 2 / 3), bx, by);
  line(x + r, y, right - r, y); points.push(right - r + k, y, right, y + r - k, right, y + r);
  line(right, y + r, right, bottom - r); points.push(right, bottom - r + k, right - r + k, bottom, right - r, bottom);
  line(right - r, bottom, x + r, bottom); points.push(x + r - k, bottom, x, bottom - r + k, x, bottom - r);
  line(x, bottom - r, x, y + r); points.push(x, y + r - k, x + r - k, y, x + r, y);
  return points;
}
function path(points) {
  let result = `M${number(points[0])} ${number(points[1])}`;
  for (let index = 2; index < points.length; index += 6) result += 'C' + points.slice(index, index + 6).map(number).join(' ');
  return result + 'Z';
}
const clamp = value => Math.max(0, Math.min(1, value));
const easing = t => t * t * (3 - 2 * t);
// One continuous ease-in-out: gentle endpoints, a quicker middle, no overshoot.
const transferEasing = t => t * t * t * (t * (6 * t - 15) + 10);
const gatherEnd = .12, travelStart = .08, arrival = .82;
const leftDepartureOffset = 100 - (Math.PI - circleStart) / (2 * Math.PI) * 100;
const rightDepartureOffset = circleStart / (2 * Math.PI) * 100;

function entryOnSide(points, right) {
  const segments = Array.from({ length: 8 }, (_, index) => points.slice(2 + index * 6, 8 + index * 6));
  const next = right ? 3 : 6;
  return [...segments[next - 1].slice(4), ...segments.slice(next).flat(), ...segments.slice(0, next).flat()];
}
function roundedRoute(points, maximumRadius = 4) {
  let result = `M${points[0].map(number).join(' ')}`;
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index], previous = points[index - 1], next = points[index + 1];
    const before = Math.hypot(x - previous[0], y - previous[1]), after = Math.hypot(next[0] - x, next[1] - y);
    const radius = Math.min(maximumRadius, before / 2, after / 2);
    if (!radius) { result += `L${number(x)} ${number(y)}`; continue; }
    const a = [x - (x - previous[0]) / before * radius, y - (y - previous[1]) / before * radius];
    const b = [x + (next[0] - x) / after * radius, y + (next[1] - y) / after * radius];
    result += `L${a.map(number).join(' ')}Q${number(x)} ${number(y)} ${b.map(number).join(' ')}`;
  }
  return result + `L${points.at(-1).map(number).join(' ')}`;
}

export function createDevIssueMotion({ host, shadow, ringSvg, issues, panel }) {
  const view = host.ownerDocument.defaultView, noop = { update() {}, refresh() {}, closeImmediately() {}, dispose() {} };
  if (!view.requestAnimationFrame || !view.matchMedia || !host.ownerDocument.createElementNS) return noop;
  const svg = host.ownerDocument.createElementNS(NS, 'svg'), outline = host.ownerDocument.createElementNS(NS, 'path');
  const ring = host.ownerDocument.createElementNS(NS, 'path'), streak = host.ownerDocument.createElementNS(NS, 'path');
  const defs = host.ownerDocument.createElementNS(NS, 'defs'), clip = host.ownerDocument.createElementNS(NS, 'clipPath'), reveal = host.ownerDocument.createElementNS(NS, 'rect');
  clip.id = `prnext-issue-border-reveal-${++revealSequence}`; clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
  reveal.classList.add('issue-motion-reveal'); clip.append(reveal); defs.append(clip);
  svg.classList.add('issue-motion'); svg.setAttribute('viewBox', '0 0 1 1'); svg.setAttribute('aria-hidden', 'true');
  outline.classList.add('issue-motion-path'); ring.classList.add('issue-motion-ring'); streak.classList.add('issue-motion-streak');
  for (const stroke of [ring, outline]) { stroke.setAttribute('pathLength', '100'); stroke.setAttribute('fill', 'none'); stroke.setAttribute('stroke-linecap', 'round'); }
  outline.setAttribute('stroke-width', '1'); streak.setAttribute('fill', 'none'); streak.setAttribute('stroke-width', '1.5'); streak.setAttribute('stroke-linecap', 'round');
  outline.setAttribute('clip-path', `url(#${clip.id})`);
  svg.append(defs, ring, outline, streak); shadow.append(svg);
  const controller = new view.AbortController(), events = { signal: controller.signal }, reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  let severity = 'none', opened = false, disposed = false, frame = 0, animation, current, source, target;
  function measureSource(rest = false) {
    const origin = host.getBoundingClientRect(), rect = ringSvg.getBoundingClientRect(), width = rest ? ringSvg.clientWidth : rect.width;
    if (!width) return;
    return { x: rect.left - origin.left + rect.width / 2, y: rect.top - origin.top + rect.height / 2,
      radius: 17.25 * width / 36, width: 1.5 * width / 36 };
  }
  function measureTarget() {
    if (issues.hidden || panel.hidden) return;
    const origin = host.getBoundingClientRect(), rect = issues.getBoundingClientRect(), parent = panel.getBoundingClientRect(), style = view.getComputedStyle(panel);
    const values = /^matrix\(([^)]+)\)/.exec(style.transform)?.[1].split(',').map(Number), sx = values?.[0] || 1, sy = values?.[3] || 1;
    const [ox, oy] = style.transformOrigin.split(' ').map(parseFloat);
    // Undo the bubble content's temporary scale/translation, keeping its final border as target.
    const panelX = parent.left - origin.left - (values?.[4] || 0) - (ox || 0) * (1 - sx);
    const panelY = parent.top - origin.top - (values?.[5] || 0) - (oy || 0) * (1 - sy);
    const x = panelX + (rect.left - parent.left) / sx + .5, y = panelY + (rect.top - parent.top) / sy + .5;
    const width = rect.width / sx - 1, height = rect.height / sy - 1;
    const right = host.dataset.position?.endsWith('right') || false;
    const points = entryOnSide(rectangle(x, y, width, height, Math.max(0, parseFloat(view.getComputedStyle(issues).borderTopLeftRadius) - .5)), right);
    const below = source.y > panelY + panel.offsetHeight / 2;
    const railX = right ? panelX + parent.width / sx - parseFloat(style.paddingRight) / 2 : panelX + parseFloat(style.paddingLeft) / 2;
    const marginY = below ? panelY + panel.offsetHeight - parseFloat(style.paddingBottom) / 2 : panelY + parseFloat(style.paddingTop) / 2;
    // Leave the ring on the menu's outside edge, tangent to its circumference. The
    // segment must never start at the center or cut across the logo artwork.
    const departureX = source.x + (right ? source.radius : -source.radius);
    const route = [[departureX, source.y], [departureX, marginY], [railX, marginY], [railX, points[1]], [points[0], points[1]]];
    return { points, route, right, routeRadius: below ? 6 : 4, reveal: { x: x - 1, y: y - 1, width: width + 2, height: height + 2 } };
  }
  function measure(destination = opened) {
    source = measureSource(true) || source;
    if (destination && source) {
      target = measureTarget() || target;
      if (target) {
        outline.setAttribute('d', path(target.points)); streak.setAttribute('d', roundedRoute(target.route, target.routeRadius));
        for (const key of ['x', 'y', 'height']) reveal.setAttribute(key, String(number(target.reveal[key])));
        // Geometry is measured once per placement, never in the animation loop.
        target.routeLength = Math.max(14, streak.getTotalLength());
      }
    }
  }
  function sample(progress) {
    // Flight and border tracing share one eased clock. Re-easing each of these
    // phases made the short flight stop and accelerate at every handoff.
    const gather = easing(clamp(progress / gatherEnd)), travel = clamp((progress - travelStart) / (arrival - travelStart));
    const fill = clamp((progress - arrival) / (1 - arrival)), formation = easing(clamp((gather - .45) / .55));
    const length = (14 + 24 * travel * (1 - travel)) * formation, arcLength = severity === 'critical' ? 50 : 13;
    return { progress, ringX: source.x, ringY: source.y, ringRadius: source.radius, ringWidth: source.width,
      ringOpacity: 1 - easing(clamp((gather - .55) / .45)), ringLength: arcLength * (1 - gather),
      ringGap: lerp(50 - arcLength, 100, gather), ringOffset: (target?.right ? rightDepartureOffset : leftDepartureOffset) * gather,
      streakOffset: Math.max(0, ((target?.routeLength || 14) - 14) * travel + (14 * formation - length)),
      streakLength: length, streakWidth: lerp(source.width, 1, travel),
      streakOpacity: formation * (1 - easing(clamp(fill / .18))), fill };
  }
  function paint(pose) {
    current = pose;
    const length = Math.max(0, Math.min(50, pose.ringLength)), gap = Math.max(0, Math.min(100 - 2 * length, pose.ringGap)), fill = clamp(pose.fill);
    ring.setAttribute('d', path(circle(pose.ringX, pose.ringY, Math.max(0, pose.ringRadius))));
    ring.setAttribute('stroke-dasharray', [length, gap, length, Math.max(0, 100 - 2 * length - gap)].map(number).join(' '));
    ring.setAttribute('stroke-dashoffset', String(number(pose.ringOffset)));
    ring.setAttribute('stroke-width', String(number(pose.ringWidth))); ring.setAttribute('opacity', String(number(clamp(pose.ringOpacity))));
    // Reveal from the arriving thread's side, keeping the contour fixed.
    if (target) reveal.setAttribute('x', String(number(target.reveal.x + (target.right ? target.reveal.width * (1 - fill) : 0))));
    reveal.setAttribute('width', String(number((target?.reveal.width || 0) * fill)));
    outline.setAttribute('opacity', fill > 0 ? '1' : '0');
    streak.setAttribute('stroke-dasharray', `${number(Math.max(0, pose.streakLength))} ${number((target?.routeLength || 14) + 14)}`);
    streak.setAttribute('stroke-width', String(number(pose.streakWidth)));
    streak.setAttribute('stroke-dashoffset', String(number(-pose.streakOffset))); streak.setAttribute('opacity', String(number(clamp(pose.streakOpacity))));
    svg.dataset.progress = String(number(pose.progress)); svg.dataset.fill = String(number(fill));
    svg.dataset.stage = pose.progress <= 0 ? 'ring' : pose.progress >= 1 ? 'border' : pose.progress < gatherEnd ? 'gather' : pose.progress < arrival ? 'travel' : 'fill';
  }
  function cancel() { if (frame) view.cancelAnimationFrame(frame); frame = 0; animation = undefined; }
  function phase(name, running = false) { svg.dataset.phase = name; svg.dataset.running = String(running); host.dataset.issueTransfer = running ? 'moving' : name; }
  function finish() {
    cancel(); if (source) paint(sample(opened ? 1 : 0)); phase(opened ? 'open' : 'closed');
  }
  function disable() {
    cancel(); severity = 'none'; opened = false; current = source = target = undefined;
    svg.dataset.phase = 'disabled'; svg.dataset.running = 'false'; svg.dataset.progress = '0'; svg.dataset.fill = '0'; svg.dataset.stage = 'ring';
    ring.setAttribute('opacity', '0'); ring.removeAttribute('d'); outline.setAttribute('opacity', '0'); outline.removeAttribute('d'); streak.setAttribute('opacity', '0'); streak.removeAttribute('d'); delete host.dataset.issueTransfer;
  }
  function tick(now) {
    frame = 0; if (!animation || disposed) return;
    const amount = clamp((now - animation.start) / animation.duration), t = transferEasing(amount), from = animation.from;
    const progress = lerp(animation.origin, animation.to, t), pose = sample(progress);
    const correction = 1 - clamp((t - animation.correctionAt) / Math.max(.000001, 1 - animation.correctionAt));
    // Correct from the last rendered pose, not from a restarted phase. This also
    // preserves the short traveling stroke when the severity changes mid-transfer.
    for (const key of Object.keys(pose)) if (key !== 'progress') pose[key] += (from[key] - animation.baseline[key]) * correction;
    paint(pose);
    if (amount >= 1) finish(); else frame = view.requestAnimationFrame(tick);
  }
  function start() {
    const interrupted = Boolean(animation); cancel();
    source = measureSource(true) || source;
    // Keep both endpoints fixed during reversals. Only the short stroke travels;
    // the destination contour never morphs or follows it through the menu.
    if (opened && (!interrupted || !target)) measure();
    if (!source) return;
    if (!current || reduced.matches) { finish(); return; }
    // The nearby top-corner target uses a quicker clock, synchronized with its
    // 140ms panel entrance. Keep the longer bottom-corner transfer unchanged.
    const duration = host.dataset.position?.startsWith('top') ? (opened ? 240 : 200)
      : opened ? Math.min(480, Math.max(360, (target?.routeLength || 300) * 1.6)) : 360;
    animation = { from: current, baseline: sample(current.progress), origin: current.progress, correctionAt: 0,
      to: opened ? 1 : 0, duration, start: view.performance.now() };
    phase(opened ? 'opening' : 'closing', true); frame = view.requestAnimationFrame(tick);
  }
  function refresh({ immediate = false } = {}) {
    if (disposed || severity === 'none') return;
    if (immediate || reduced.matches || !animation) { measure(); finish(); }
  }
  reduced.addEventListener('change', () => refresh({ immediate: true }), events);
  view.addEventListener('resize', () => refresh({ immediate: true }), events);
  view.addEventListener('blur', () => refresh({ immediate: true }), events);
  view.visualViewport?.addEventListener('resize', () => refresh({ immediate: true }), events);
  panel.addEventListener('scroll', () => refresh({ immediate: true }), events);
  disable();
  return {
    update({ severity: next = 'none', open = false } = {}) {
      if (disposed) return;
      if (next === 'none') { disable(); return; }
      const changed = opened !== open, first = severity === 'none', changedSeverity = severity !== next;
      severity = next; opened = open;
      if (first) { source = measureSource(); if (source) paint(sample(0)); }
      if (!current) return;
      if (!changed && !first && !changedSeverity) return;
      if (!changed && !animation) { finish(); return; }
      if (!changed && animation) {
        // A severity-only update must not restart the travel/fill clock: the
        // closing contour still has to disappear before the menu is hidden.
        animation.from = current; animation.baseline = sample(current.progress);
        animation.correctionAt = transferEasing(clamp((view.performance.now() - animation.start) / animation.duration));
        return;
      }
      start();
    },
    refresh,
    closeImmediately() { if (disposed) return; opened = false; if (severity !== 'none') { measure(false); finish(); } else cancel(); },
    dispose() { if (disposed) return; disposed = true; cancel(); controller.abort(); svg.remove(); delete host.dataset.issueTransfer; },
  };
}
