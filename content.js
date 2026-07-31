// App Store Connect Review Counter
//
// Apple's "iOS Ratings" chart only shows per-star bars, but the bar fill
// divs carry a full-precision width attribute (e.g. "80.53097345132744%").
// Combined with the "113 Ratings" total shown under the chart, that is
// enough to recover the exact number of ratings for each star.

(() => {
  'use strict';

  const BADGE_CLASS = 'asc-review-count';
  const ROW_LABEL_RE = /^(\d+)\s+Stars?\s+([\d.]+)%$/i;
  const TOTAL_RE = /^([\d.,  ]+)\s+Ratings?$/i;

  function parseTotal(container) {
    for (const p of container.querySelectorAll('p')) {
      const m = p.textContent.trim().match(TOTAL_RE);
      if (m) {
        const n = parseInt(m[1].replace(/[.,  ]/g, ''), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  }

  // The fill is the empty div with a numeric width inside the 100%-wide track.
  function parseFillPct(row) {
    for (const div of row.querySelectorAll('div')) {
      if (div.childElementCount !== 0) continue;
      const parent = div.parentElement;
      if (!parent || parent.getAttribute('width') !== '100%') continue;
      const w = div.getAttribute('width');
      if (!w || !/^\d*\.?\d+%?$/.test(w)) continue;
      const pct = parseFloat(w);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    return null;
  }

  function collectRows(container) {
    const rows = [];
    for (const el of container.querySelectorAll('div[role="img"][aria-label]')) {
      const m = el.getAttribute('aria-label').trim().match(ROW_LABEL_RE);
      if (!m) continue;
      const ariaPct = parseFloat(m[2]);
      let pct = parseFillPct(el);
      // The width attribute is occasionally malformed (missing "%" and not
      // matching the row's real share) — fall back to the aria-label
      // percentage when the two clearly disagree.
      if (pct === null || Math.abs(pct - ariaPct) > 0.6) pct = ariaPct;
      rows.push({ el, stars: parseInt(m[1], 10), pct });
    }
    return rows;
  }

  // Largest-remainder apportionment so the per-star counts sum to the total.
  function apportion(pcts, total) {
    const raw = pcts.map((p) => (p / 100) * total);
    const counts = raw.map(Math.floor);
    let remainder = total - counts.reduce((a, b) => a + b, 0);
    const order = raw
      .map((r, i) => [r - Math.floor(r), i])
      .sort((a, b) => b[0] - a[0]);
    let k = 0;
    while (remainder > 0 && order.length) {
      counts[order[k % order.length][1]]++;
      k++;
      remainder--;
    }
    while (remainder < 0 && order.length) {
      const i = order[order.length - 1 - (k % order.length)][1];
      if (counts[i] > 0) {
        counts[i]--;
        remainder++;
      }
      k++;
    }
    return counts;
  }

  function badgeFor(row) {
    return row.querySelector(':scope > .' + BADGE_CLASS);
  }

  function annotateChart(container) {
    const total = parseTotal(container);
    if (!total) return;
    const rows = collectRows(container);
    if (!rows.length) return;

    const counts = apportion(rows.map((r) => r.pct), total);

    rows.forEach((row, i) => {
      const count = counts[i];
      const tip =
        count.toLocaleString() +
        (count === 1 ? ' rating' : ' ratings') +
        ' · ' +
        row.pct.toFixed(1) +
        '% of ' +
        total.toLocaleString();

      let badge = badgeFor(row.el);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        row.el.appendChild(badge);
      }
      if (badge.textContent !== String(count.toLocaleString())) {
        badge.textContent = count.toLocaleString();
      }
      if (badge.getAttribute('data-tip') !== tip) {
        badge.setAttribute('data-tip', tip);
      }
    });
  }

  function run() {
    // A star row's chart container is the nearest ancestor that also holds
    // the "N Ratings" total. Group rows by that container so multiple
    // charts on one page each get their own total.
    const seen = new Set();
    for (const el of document.querySelectorAll('div[role="img"][aria-label]')) {
      if (!ROW_LABEL_RE.test(el.getAttribute('aria-label').trim())) continue;
      let container = el.parentElement;
      while (container && container !== document.body && !parseTotal(container)) {
        container = container.parentElement;
      }
      if (!container || container === document.body || seen.has(container)) continue;
      seen.add(container);
      annotateChart(container);
    }
  }

  let scheduled = null;
  function scheduleRun() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      run();
    }, 250);
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore mutation batches caused purely by our own badges.
    for (const m of mutations) {
      const t = m.target;
      if (t instanceof Element && (t.classList.contains(BADGE_CLASS) || t.closest('.' + BADGE_CLASS))) {
        continue;
      }
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

  run();
})();
