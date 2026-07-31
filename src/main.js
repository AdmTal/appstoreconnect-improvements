// App Store Connect Improvements — runner.
//
// Runs every registered module on load, then re-runs them (debounced)
// whenever the page mutates. Loaded last in the manifest, after core.js
// and all modules.

(() => {
  'use strict';

  const ASC = window.ascImprovements;

  function runAll() {
    for (const module of ASC.modules) {
      try {
        module.run();
      } catch (e) {
        console.warn('[ASC Improvements] module "' + module.id + '" failed:', e);
      }
    }
  }

  let scheduled = null;
  function scheduleRun() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      runAll();
    }, 250);
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore mutation batches caused purely by DOM we injected ourselves.
    for (const m of mutations) {
      const t = m.target;
      if (t instanceof Element && t.closest('[data-asc-ui]')) continue;
      scheduleRun();
      return;
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'width'],
  });

  runAll();
})();
