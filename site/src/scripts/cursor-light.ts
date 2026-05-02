/**
 * Tracks cursor position and writes it to two layers:
 *   1. :root — `--cx` / `--cy` (viewport coords). Drives the page-level
 *      cursor-light radial gradient.
 *   2. Each `.helm-pill` element — `--mx` / `--my` (element-local
 *      coords). Drives the masked cursor-rim ring around the helm pill.
 *
 * Updates are batched into a single requestAnimationFrame on each
 * mousemove tick; off-screen surfaces are skipped to keep this cheap on
 * long pages.
 */

let lastX = window.innerWidth / 2;
let lastY = window.innerHeight / 3;
let needsUpdate = false;
let rimEls: HTMLElement[] = [];

function refreshRimList() {
  rimEls = Array.from(document.querySelectorAll<HTMLElement>('.helm-pill'));
}

function tick() {
  needsUpdate = false;
  const root = document.documentElement;
  root.style.setProperty('--cx', `${lastX}px`);
  root.style.setProperty('--cy', `${lastY}px`);

  const vh = window.innerHeight;
  const margin = 300;

  for (const el of rimEls) {
    const rect = el.getBoundingClientRect();
    // Skip if comfortably off-screen to avoid wasted work on long pages.
    if (rect.bottom < -margin || rect.top > vh + margin) continue;
    const mx = lastX - rect.left;
    const my = lastY - rect.top;
    el.style.setProperty('--mx', `${mx}px`);
    el.style.setProperty('--my', `${my}px`);
  }
}

function schedule() {
  if (needsUpdate) return;
  needsUpdate = true;
  requestAnimationFrame(tick);
}

function onPointerMove(e: PointerEvent) {
  lastX = e.clientX;
  lastY = e.clientY;
  schedule();
}

function init() {
  refreshRimList();
  // Refresh the rim list when DOM changes (route changes, etc.) — cheap.
  const mo = new MutationObserver(() => refreshRimList());
  mo.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  // Prime once so initial paint has a sensible cursor position.
  schedule();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
