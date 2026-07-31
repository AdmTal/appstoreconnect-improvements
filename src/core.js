// App Store Connect Improvements — module registry.
//
// Each improvement lives in src/modules/<name>.js and registers itself here.
// A module is { id, run } where run() is idempotent: it is called on page
// load and again (debounced) whenever the page mutates, since App Store
// Connect is a React SPA that loads and re-renders content asynchronously.
//
// Any DOM a module injects must be marked with the data-asc-ui attribute so
// the shared MutationObserver in main.js can ignore our own mutations.

'use strict';

window.ascImprovements = {
  modules: [],
  register(module) {
    this.modules.push(module);
  },
};
