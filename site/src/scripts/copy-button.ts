/**
 * Single, page-wide click handler for `[data-copy]` elements.
 *
 * Each element opts in by carrying a `data-copy="<text>"` attribute.
 * On click the text is written to the clipboard. If the element has a
 * `data-copy-feedback` value of `swap-icon`, its inner HTML is briefly
 * replaced with a checkmark; otherwise the optional `data-copy-label`
 * child is swapped for "copied". The colour pulse to brand green is
 * toggled via the `is-copied` class so styling stays in CSS.
 */

const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
const RESET_MS = 1400;

function attach(btn: HTMLElement) {
  if (btn.dataset.copyBound === '1') return;
  btn.dataset.copyBound = '1';
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    btn.classList.add('is-copied');
    const label = btn.querySelector<HTMLElement>('[data-copy-label]');
    const feedback = btn.dataset.copyFeedback;
    let originalHTML: string | null = null;
    let originalLabel: string | null = null;
    if (feedback === 'swap-icon') {
      originalHTML = btn.innerHTML;
      btn.innerHTML = CHECK_SVG;
    } else if (label) {
      originalLabel = label.textContent;
      label.textContent = 'copied';
    }
    setTimeout(() => {
      btn.classList.remove('is-copied');
      if (originalHTML !== null) btn.innerHTML = originalHTML;
      if (originalLabel !== null && label) label.textContent = originalLabel;
    }, RESET_MS);
  });
}

function initCopy() {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(attach);
  // Pick up dynamically-rendered copy buttons (route changes etc.).
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) {
          if (n.matches?.('[data-copy]')) attach(n);
          n.querySelectorAll?.<HTMLElement>('[data-copy]').forEach(attach);
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCopy, { once: true });
} else {
  initCopy();
}
