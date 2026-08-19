// Review Counter — reveals the actual number of ratings per star.
//
// Apple's ratings chart only shows per-star bars, but the bar fill divs
// carry a full-precision width attribute (e.g. "80.53097345132744%").
// Combined with the "113 Ratings" total shown under the chart, that is
// enough to recover the exact number of ratings for each star.
//
// The module also keeps history: every time you view the chart and the
// counts differ from the last stored snapshot, a new row is saved to
// chrome.storage.local (keyed by app id). Changed numbers get a "+x"/"-x"
// delta next to their pill for the rest of the page session, and a
// "History" button under the total opens a table of all recorded rows.

(() => {
  'use strict';

  const BADGE_CLASS = 'asc-review-count';
  const DELTA_CLASS = 'asc-rc-delta';
  const ROW_CLASS = 'asc-rc-row';
  const BTN_CLASS = 'asc-rc-history-btn';
  const ROW_LABEL_RE = /^(\d+)\s+Stars?\s+([\d.]+)%$/i;
  const TOTAL_RE = /^([\d.,  ]+)\s+Ratings?$/i;
  const STORAGE_KEY = 'asc-rc-history';
  const MAX_ROWS_PER_CHART = 500;

  // Deltas detected during this page session, keyed by chart key. They stay
  // visible next to the pills until the page is reloaded, even though the
  // stored history has already caught up to the current counts.
  const sessionDeltas = new Map();

  // --- storage -------------------------------------------------------------
  // chrome.storage.local survives across App Store Connect sessions; fall
  // back to localStorage when running outside an extension context.

  function chromeStorage() {
    try {
      return chrome.storage.local;
    } catch (e) {
      return null;
    }
  }

  function storageLoad() {
    return new Promise((resolve) => {
      const cs = chromeStorage();
      if (cs) {
        cs.get(STORAGE_KEY, (o) => resolve((o && o[STORAGE_KEY]) || {}));
        return;
      }
      try {
        resolve(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {});
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSave(data) {
    return new Promise((resolve) => {
      const cs = chromeStorage();
      if (cs) {
        cs.set({ [STORAGE_KEY]: data }, () => resolve());
        return;
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        /* storage full or unavailable — history is best-effort */
      }
      resolve();
    });
  }

  // History is keyed by the app id in the URL plus the chart's position on
  // the page, so multiple charts (or apps) don't share rows.
  function chartKeyFor(index) {
    const m = location.pathname.match(/\/apps\/(\d+)/);
    return (m ? m[1] : 'app') + ':' + index;
  }

  // --- chart parsing ---------------------------------------------------------

  function parseTotal(container) {
    for (const p of container.querySelectorAll('p')) {
      const m = p.textContent.trim().match(TOTAL_RE);
      if (m) {
        const n = parseInt(m[1].replace(/[.,  ]/g, ''), 10);
        if (Number.isFinite(n) && n > 0) return { total: n, el: p };
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

  // --- history recording -----------------------------------------------------

  // Records a snapshot into store[key] when the counts differ from the last
  // stored row. Returns true when the store was modified. byStar is indexed
  // 0..4 for 1..5 stars.
  function recordSnapshot(store, key, total, byStar) {
    const history = store[key] || (store[key] = []);
    const last = history[history.length - 1];
    if (last && last.total === total && last.c.every((v, i) => v === byStar[i])) {
      return false;
    }
    if (last) {
      sessionDeltas.set(key, byStar.map((v, i) => v - last.c[i]));
    }
    history.push({ t: Date.now(), total, c: byStar });
    if (history.length > MAX_ROWS_PER_CHART) {
      history.splice(0, history.length - MAX_ROWS_PER_CHART);
    }
    return true;
  }

  // --- DOM annotation ----------------------------------------------------------

  function fmtDeltaText(d) {
    return (d > 0 ? '+' : '-') + Math.abs(d).toLocaleString();
  }

  function annotateChart(container, key, store) {
    const totalInfo = parseTotal(container);
    if (!totalInfo) return false;
    const { total, el: totalEl } = totalInfo;
    const rows = collectRows(container);
    if (!rows.length) return false;

    const counts = apportion(rows.map((r) => r.pct), total);

    // Only record history for a fully-rendered 1–5 star chart, so a
    // half-rendered React tree can't store a bogus snapshot.
    let dirty = false;
    const starsSeen = rows.map((r) => r.stars).sort().join('');
    if (starsSeen === '12345') {
      const byStar = [0, 0, 0, 0, 0];
      rows.forEach((row, i) => {
        byStar[row.stars - 1] = counts[i];
      });
      dirty = recordSnapshot(store, key, total, byStar);
    }

    const deltas = sessionDeltas.get(key) || null;

    rows.forEach((row, i) => {
      const count = counts[i];
      const tip =
        count.toLocaleString() +
        (count === 1 ? ' rating' : ' ratings') +
        ' · ' +
        row.pct.toFixed(1) +
        '% of ' +
        total.toLocaleString();

      // The tooltip lives on the row itself so hovering anywhere on the
      // star row shows it, not just the badge.
      row.el.classList.add(ROW_CLASS);
      if (row.el.getAttribute('data-asc-tip') !== tip) {
        row.el.setAttribute('data-asc-tip', tip);
      }

      let badge = row.el.querySelector(':scope > .' + BADGE_CLASS);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.setAttribute('data-asc-ui', '');
        row.el.appendChild(badge);
      }
      if (badge.textContent !== count.toLocaleString()) {
        badge.textContent = count.toLocaleString();
      }

      // "+x"/"-x" next to the pill for numbers that changed since the
      // previous stored snapshot.
      const delta = deltas ? deltas[row.stars - 1] || 0 : 0;
      let deltaEl = row.el.querySelector(':scope > .' + DELTA_CLASS);
      if (delta) {
        if (!deltaEl) {
          deltaEl = document.createElement('span');
          deltaEl.className = DELTA_CLASS;
          deltaEl.setAttribute('data-asc-ui', '');
          row.el.appendChild(deltaEl);
        }
        const txt = fmtDeltaText(delta);
        if (deltaEl.textContent !== txt) deltaEl.textContent = txt;
        deltaEl.classList.toggle('asc-rc-delta--up', delta > 0);
        deltaEl.classList.toggle('asc-rc-delta--down', delta < 0);
      } else if (deltaEl) {
        deltaEl.remove();
      }
    });

    ensureHistoryButton(totalEl, key);
    return dirty;
  }

  // --- history button + panel --------------------------------------------------

  function ensureHistoryButton(totalEl, key) {
    let btn = totalEl.nextElementSibling;
    if (!btn || !btn.classList || !btn.classList.contains(BTN_CLASS)) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN_CLASS;
      btn.setAttribute('data-asc-ui', '');
      btn.textContent = 'History';
      btn.addEventListener('click', () => {
        if (panelKey === btn.dataset.ascKey) {
          closePanel();
        } else {
          openPanel(btn, btn.dataset.ascKey);
        }
      });
      totalEl.insertAdjacentElement('afterend', btn);
    }
    if (btn.dataset.ascKey !== key) btn.dataset.ascKey = key;
  }

  let panel = null;
  let panelKey = null;

  function closePanel() {
    if (panel) {
      panel.remove();
      panel = null;
      panelKey = null;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    })[ch]);
  }

  function deltaCellHtml(d) {
    if (!d) return '';
    const cls = d > 0 ? 'asc-rc-delta--up' : 'asc-rc-delta--down';
    return ' <span class="asc-rc-delta ' + cls + '">' + fmtDeltaText(d) + '</span>';
  }

  function buildPanel(history) {
    const el = document.createElement('div');
    el.className = 'asc-rc-panel';
    el.setAttribute('data-asc-ui', '');

    let html =
      '<div class="asc-rc-panel-head">' +
      '<span>Ratings history</span>' +
      '<button type="button" class="asc-rc-panel-close" aria-label="Close">&times;</button>' +
      '</div>';

    if (!history.length) {
      html += '<div class="asc-rc-panel-empty">No snapshots recorded yet.</div>';
    } else {
      let body = '';
      // Newest first; each row's deltas compare against the row below it
      // (the chronologically previous snapshot).
      for (let i = history.length - 1; i >= 0; i--) {
        const row = history[i];
        const prev = history[i - 1] || null;
        const d = new Date(row.t);
        let cells =
          '<td>' + esc(d.toLocaleDateString()) + '</td>' +
          '<td>' + esc(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</td>' +
          '<td>' + row.total.toLocaleString() + (prev ? deltaCellHtml(row.total - prev.total) : '') + '</td>';
        for (let s = 0; s < 5; s++) {
          cells +=
            '<td>' + row.c[s].toLocaleString() + (prev ? deltaCellHtml(row.c[s] - prev.c[s]) : '') + '</td>';
        }
        body += '<tr>' + cells + '</tr>';
      }
      html +=
        '<div class="asc-rc-panel-scroll"><table class="asc-rc-table">' +
        '<thead><tr><th>Date</th><th>Time</th><th>Total</th>' +
        '<th>1★</th><th>2★</th><th>3★</th><th>4★</th><th>5★</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table></div>';
    }

    el.innerHTML = html;
    el.querySelector('.asc-rc-panel-close').addEventListener('click', closePanel);
    return el;
  }

  function openPanel(btn, key) {
    storageLoad().then((store) => {
      closePanel();
      panel = buildPanel(store[key] || []);
      panelKey = key;
      document.body.appendChild(panel);

      // Anchor below the button, right edge clamped to the viewport.
      const r = btn.getBoundingClientRect();
      panel.style.top = Math.min(r.bottom + 8, window.innerHeight - 80) + 'px';
      const width = panel.offsetWidth;
      let left = r.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - 12 - width;
      panel.style.left = Math.max(12, left) + 'px';
    });
  }

  // Close the panel on outside clicks, Escape, or page scroll (the panel is
  // fixed-position, so scrolling would detach it from its anchor).
  document.addEventListener(
    'click',
    (e) => {
      if (!panel) return;
      const t = e.target;
      if (t instanceof Element && (panel.contains(t) || t.closest('.' + BTN_CLASS))) return;
      closePanel();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
  window.addEventListener(
    'scroll',
    (e) => {
      if (panel && !(e.target instanceof Node && panel.contains(e.target))) closePanel();
    },
    true
  );

  // --- runner ------------------------------------------------------------------

  async function runAsync() {
    // A star row's chart container is the nearest ancestor that also holds
    // the "N Ratings" total. Group rows by that container so multiple
    // charts on one page each get their own total and history key.
    const containers = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('div[role="img"][aria-label]')) {
      if (!ROW_LABEL_RE.test(el.getAttribute('aria-label').trim())) continue;
      let container = el.parentElement;
      while (container && container !== document.body && !parseTotal(container)) {
        container = container.parentElement;
      }
      if (!container || container === document.body || seen.has(container)) continue;
      seen.add(container);
      containers.push(container);
    }
    if (!containers.length) return;

    const store = await storageLoad();
    let dirty = false;
    containers.forEach((container, i) => {
      if (annotateChart(container, chartKeyFor(i), store)) dirty = true;
    });
    if (dirty) await storageSave(store);
  }

  // Serialize runs: storage access is async and the runner re-invokes run()
  // on every page mutation, so overlapping runs could double-record rows.
  let running = false;
  function run() {
    if (running) return;
    running = true;
    runAsync()
      .catch((e) => console.warn('[ASC Improvements] review-counter failed:', e))
      .finally(() => {
        running = false;
      });
  }

  window.ascImprovements.register({ id: 'review-counter', run });
})();
