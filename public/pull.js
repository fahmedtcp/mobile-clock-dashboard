// Pull to refresh for trackpads and touch: at the top of the page, keep pulling down past a threshold and let go.
// The content follows the gesture with progressive resistance, springs back on release, and the view reloads.

export const PULL_THRESHOLD = 90;    // px of gesture travel that commits a refresh
const MOUSE_STEP = 50;               // wheel deltas this big are mouse-wheel notches, not a trackpad pull
const WHEEL_RELEASE_MS = 140;        // trackpads have no "release" event; a pause in wheel events counts as one
const MAX_STRETCH = 140;             // how far the content can travel, however hard you pull

// Apple's rubber-band curve: near 1:1 for small pulls, flattening toward `dimension` for long ones.
export function rubberband(distance, dimension = MAX_STRETCH, constant = 0.55) {
  return (distance * dimension * constant) / (dimension + constant * distance);
}

// The gesture's state, with no DOM: how far it has been pulled, and what letting go should do.
export function createPullTracker(threshold = PULL_THRESHOLD) {
  let pulled = 0;
  return {
    move(delta) { pulled = Math.max(0, pulled + delta); },
    wheel(deltaY) {
      if (Math.abs(deltaY) >= MOUSE_STEP) return;
      pulled = Math.max(0, pulled - deltaY);
    },
    distance: () => pulled,
    progress: () => Math.min(1, pulled / threshold),
    release() {
      const outcome = pulled >= threshold ? 'refresh' : 'cancel';
      pulled = 0;
      return outcome;
    },
  };
}

const atTop = () => window.scrollY <= 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function createIndicator(parent) {
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 24 24');
  ring.setAttribute('class', 'pull-ring');
  ring.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [name, value] of Object.entries({ cx: 12, cy: 12, r: 9, pathLength: 100 })) arc.setAttribute(name, value);
  ring.append(arc);
  const box = document.createElement('div');
  box.className = 'pull-indicator';
  box.setAttribute('role', 'status');
  box.append(ring);
  parent.prepend(box);
  return { box, arc };
}

// Wire the gesture to `content` (the element that moves) and call `onRefresh` (async) when it commits.
export function enablePullToRefresh({ content, indicatorParent, onRefresh }) {
  const pull = createPullTracker();
  const { box, arc } = createIndicator(indicatorParent);
  let busy = false;
  let wheelTimer = null;

  function paint() {
    const offset = rubberband(pull.distance());
    if (!reducedMotion()) content.style.transform = offset ? `translateY(${offset}px)` : '';
    box.style.opacity = String(Math.min(1, pull.progress() * 1.4));
    box.style.transform = `translateY(${Math.min(offset, MAX_STRETCH) / 2}px)`;
    arc.style.strokeDashoffset = String(100 - pull.progress() * 100);
    box.classList.toggle('armed', pull.progress() === 1);
  }

  function settle() {
    content.classList.add('pull-settling'); // spring back; the transition lives in CSS so it respects reduced motion
    content.style.transform = '';
    setTimeout(() => content.classList.remove('pull-settling'), 450);
  }

  async function release() {
    const outcome = pull.release();
    settle();
    if (outcome !== 'refresh') { paint(); return; }
    busy = true;
    box.classList.add('spinning');
    box.setAttribute('aria-label', 'Refreshing');
    try { await onRefresh(); } finally {
      busy = false;
      box.classList.remove('spinning', 'armed');
      box.removeAttribute('aria-label');
      paint();
    }
  }

  window.addEventListener('wheel', (e) => {
    if (busy || e.ctrlKey || !atTop() || (e.deltaY > 0 && pull.distance() === 0)) return;
    pull.wheel(e.deltaY);
    paint();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(release, WHEEL_RELEASE_MS);
  }, { passive: true });

  let lastY = null;
  window.addEventListener('touchstart', (e) => { lastY = !busy && atTop() ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (lastY === null) return;
    const y = e.touches[0].clientY;
    pull.move(y - lastY);
    lastY = y;
    paint();
  }, { passive: true });
  window.addEventListener('touchend', () => { if (lastY !== null) { lastY = null; release(); } }, { passive: true });
}
