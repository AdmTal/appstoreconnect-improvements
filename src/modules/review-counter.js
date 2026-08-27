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
// "History" button under the total opens a table of all recorded rows
// (with a Clear button to wipe them).
//
// History only tracks the unfiltered chart: recording, deltas, and the
// History button are active only while the territory picker shows
// "All Countries or Regions" — a filtered territory shows different
// numbers for the same app and would corrupt the stored history.

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

  // --- territory gating ------------------------------------------------------

  const ALL_COUNTRIES_RE = /^All Countries or Regions$/i;

  // True only when the ratings page's territory picker currently shows
  // "All Countries or Regions". Walks the page's text nodes looking for that
  // exact label, ignoring dropdown option lists (an open picker contains the
  // label as an *option* regardless of what is selected) and our own UI.
  function territoryIsAllCountries() {
    const stack = [document.body];
    while (stack.length) {
      const node = stack.pop();
      for (const child of node.childNodes) {
        if (child.nodeType === 3 /* text */) {
          if (!ALL_COUNTRIES_RE.test(child.nodeValue.trim())) continue;
          const el = child.parentElement;
          if (!el) continue;
          if (
            el.closest(
              '[role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [data-asc-ui]'
            )
          ) {
            continue;
          }
          const opt = el.closest('option');
          if (opt && !opt.selected) continue;
          return true;
        }
        if (child.nodeType === 1 /* element */) stack.push(child);
      }
    }
    return false;
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
  // stored row. Returns 'baseline' for the first-ever row, 'changed' when a
  // change was recorded, false when nothing changed. byStar is indexed 0..4
  // for 1..5 stars.
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
    return last ? 'changed' : 'baseline';
  }

  // --- confetti --------------------------------------------------------------
  // A burst when the star counts move: paper confetti for a new 5-star,
  // raining sad emoji for a new 1- or 2-star. Purely decorative: any failure
  // (no canvas, no rAF, reduced-motion preference) silently skips it.

  let confetti = null; // { canvas, ctx, parts, raf }

  const HAPPY_COLORS = ['#0071e3', '#1d9d50', '#ff9f0a', '#ff375f', '#bf5af2', '#ffd60a'];
  const SAD_GLYPHS = ['\u{1F622}', '\u{1F62D}', '\u{1F614}', '\u{1F494}'];

  function burst(origins, mood) {
    try {
      if (!origins.length || typeof requestAnimationFrame !== 'function') return;
      if (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }
      if (!confetti) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return;
        canvas.className = 'asc-rc-confetti';
        canvas.setAttribute('data-asc-ui', '');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        confetti = { canvas, ctx, parts: [], raf: null };
      }
      const sad = mood === 'sad';
      for (const el of origins) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        // Sad emoji are big enough to hide the badge they spawn from, so
        // start them above it and let them rain down past.
        const cy = sad ? r.top - 14 : r.top + r.height / 2;
        // Sad emoji dribble out and fall; happy paper shoots up and scatters.
        const count = sad ? 14 : 40;
        for (let i = 0; i < count; i++) {
          const angle = sad
            ? -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8
            : -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
          const speed = sad ? 1 + Math.random() * 2.5 : 3.5 + Math.random() * 7;
          confetti.parts.push({
            x: cx,
            y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: sad ? 16 + Math.random() * 8 : 4 + Math.random() * 4,
            glyph: sad ? SAD_GLYPHS[i % SAD_GLYPHS.length] : null,
            color: HAPPY_COLORS[i % HAPPY_COLORS.length],
            rot: sad ? (Math.random() - 0.5) * 0.5 : Math.random() * Math.PI,
            vr: sad ? (Math.random() - 0.5) * 0.08 : (Math.random() - 0.5) * 0.4,
            gravity: sad ? 0.09 : 0.18,
            life: sad ? 90 + Math.random() * 50 : 60 + Math.random() * 40,
          });
        }
      }
      if (confetti.raf === null) confetti.raf = requestAnimationFrame(confettiTick);
    } catch (e) {
      /* decorative only */
    }
  }

  function confettiTick() {
    const c = confetti;
    if (!c) return;
    const { ctx, canvas } = c;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of c.parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.rot += p.vr;
      p.life--;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 25));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.glyph) {
        ctx.font = p.size + 'px -apple-system, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.glyph, 0, 0);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      }
      ctx.restore();
    }
    c.parts = c.parts.filter((p) => p.life > 0 && p.y < canvas.height + 30);
    if (c.parts.length) {
      c.raf = requestAnimationFrame(confettiTick);
    } else {
      canvas.remove();
      confetti = null;
    }
  }

  // --- DOM annotation ----------------------------------------------------------

  function fmtDeltaText(d) {
    return (d > 0 ? '+' : '-') + Math.abs(d).toLocaleString();
  }

  // Is this change good news? More 1- and 2-star ratings is bad; more of
  // anything else (and a bigger total) is good. Drives colour everywhere:
  // green for good, red for bad, regardless of the +/- sign.
  //  stars: 1..5, or 0 for the ratings total.
  function isGoodChange(stars, delta) {
    const badWhenUp = stars === 1 || stars === 2;
    return badWhenUp ? delta < 0 : delta > 0;
  }

  function annotateChart(container, key, store, historyEnabled) {
    const totalInfo = parseTotal(container);
    if (!totalInfo) return false;
    const { total, el: totalEl } = totalInfo;
    const rows = collectRows(container);
    if (!rows.length) return false;

    const counts = apportion(rows.map((r) => r.pct), total);

    // Only record history for a fully-rendered 1–5 star chart, so a
    // half-rendered React tree can't store a bogus snapshot.
    let dirty = false;
    let changedNow = false;
    const starsSeen = rows.map((r) => r.stars).sort().join('');
    if (historyEnabled && starsSeen === '12345') {
      const byStar = [0, 0, 0, 0, 0];
      rows.forEach((row, i) => {
        byStar[row.stars - 1] = counts[i];
      });
      const rec = recordSnapshot(store, key, total, byStar);
      dirty = Boolean(rec);
      changedNow = rec === 'changed';
    }

    const deltas = historyEnabled ? sessionDeltas.get(key) || null : null;
    let happyDeltaEl = null; // a new 5-star
    let sadDeltaEl = null; // a new 1- or 2-star

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
        // Colour by good/bad news, not by sign: "+1" on a 1-star row is red.
        const good = isGoodChange(row.stars, delta);
        deltaEl.classList.toggle('asc-rc-delta--good', good);
        deltaEl.classList.toggle('asc-rc-delta--bad', !good);
        if (delta > 0) {
          if (row.stars === 5) happyDeltaEl = deltaEl;
          else if (row.stars === 1 || row.stars === 2) sadDeltaEl = deltaEl;
        }
      } else if (deltaEl) {
        deltaEl.remove();
      }
    });

    // Only at the moment a change is first detected: paper for a new 5-star,
    // sad emoji for a new 1- or 2-star. A round that brought both gets both.
    if (changedNow) {
      if (happyDeltaEl) burst([happyDeltaEl], 'happy');
      if (sadDeltaEl) burst([sadDeltaEl], 'sad');
    }

    ensureHistoryButton(totalEl, key, historyEnabled);
    return dirty;
  }

  // --- history button + panel --------------------------------------------------

  function ensureHistoryButton(totalEl, key, historyEnabled) {
    let btn = totalEl.nextElementSibling;
    const present = btn && btn.classList && btn.classList.contains(BTN_CLASS);
    if (!historyEnabled) {
      if (present) btn.remove();
      if (panelKey === key) closePanel();
      return;
    }
    if (!present) {
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
  let panelBtn = null;

  function closePanel() {
    if (panel) {
      panel.remove();
      panel = null;
      panelKey = null;
      panelBtn = null;
    }
  }

  function clearHistory(key) {
    storageLoad()
      .then((store) => {
        delete store[key];
        return storageSave(store);
      })
      .then(() => {
        sessionDeltas.delete(key);
        // Drop any on-chart delta badges immediately — the next run() won't
        // re-add them now that the session deltas are gone.
        for (const el of document.querySelectorAll('.' + ROW_CLASS + ' > .' + DELTA_CLASS)) {
          el.remove();
        }
        // Re-render the open panel so it shows as empty.
        if (panelKey === key && panelBtn) openPanel(panelBtn, key);
      });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    })[ch]);
  }

  // One number cell. Numbers are grey by default; a number that moved since
  // the previous snapshot goes bold and green (good) or red (bad). No "+x"
  // here — the colour is the callout.
  function numCellHtml(value, delta, stars) {
    let cls = 'asc-rc-num';
    if (delta) cls += isGoodChange(stars, delta) ? ' asc-rc-num--good' : ' asc-rc-num--bad';
    const title = delta ? ' title="' + esc(fmtDeltaText(delta) + ' since the previous row') + '"' : '';
    return '<td class="' + cls + '"' + title + '>' + value.toLocaleString() + '</td>';
  }

  function buildPanel(history, key) {
    const el = document.createElement('div');
    el.className = 'asc-rc-panel';
    el.setAttribute('data-asc-ui', '');

    let html =
      '<div class="asc-rc-panel-head">' +
      '<span>Ratings history</span>' +
      '<span class="asc-rc-panel-actions">' +
      (history.length
        ? '<button type="button" class="asc-rc-panel-clear">Clear</button>'
        : '') +
      '<button type="button" class="asc-rc-panel-close" aria-label="Close">&times;</button>' +
      '</span>' +
      '</div>';

    if (!history.length) {
      html += '<div class="asc-rc-panel-empty">No snapshots recorded yet.</div>';
    } else {
      let body = '';
      // Newest first; each row is compared against the row below it (the
      // chronologically previous snapshot) to decide which numbers moved.
      for (let i = history.length - 1; i >= 0; i--) {
        const row = history[i];
        const prev = history[i - 1] || null;
        const d = new Date(row.t);
        let cells =
          '<td class="asc-rc-when">' + esc(d.toLocaleDateString()) + '</td>' +
          '<td class="asc-rc-when">' +
          esc(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) +
          '</td>' +
          numCellHtml(row.total, prev ? row.total - prev.total : 0, 0);
        for (let s = 0; s < 5; s++) {
          cells += numCellHtml(row.c[s], prev ? row.c[s] - prev.c[s] : 0, s + 1);
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
    const clearBtn = el.querySelector('.asc-rc-panel-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (
          typeof window.confirm === 'function' &&
          !window.confirm('Clear the stored ratings history for this app?')
        ) {
          return;
        }
        clearHistory(key);
      });
    }
    return el;
  }

  function openPanel(btn, key) {
    storageLoad().then((store) => {
      closePanel();
      panel = buildPanel(store[key] || [], key);
      panelKey = key;
      panelBtn = btn;
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
      if (t && typeof t.closest === 'function' && (panel.contains(t) || t.closest('.' + BTN_CLASS))) return;
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
      if (panel && !(e.target && panel.contains(e.target))) closePanel();
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

    // History features only run on the unfiltered "All Countries or Regions"
    // view — a filtered territory would store its (different) numbers under
    // the same app key and corrupt the history. Count pills still work.
    const historyEnabled = territoryIsAllCountries();

    const store = await storageLoad();
    let dirty = false;
    containers.forEach((container, i) => {
      if (annotateChart(container, chartKeyFor(i), store, historyEnabled)) dirty = true;
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
