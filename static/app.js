'use strict';
/* HDHomeRun Signal Monitor - front end. No libraries; everything is drawn here (works offline, in Safari). */

// ------------------------------------------------------------------ tiny helpers
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const SVGNS = 'http://www.w3.org/2000/svg';
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function sv(tag, attrs, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in (attrs || {})) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('hdhr.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('hdhr.' + k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
};
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api' + path, opt);
  let j = {};
  try { j = await r.json(); } catch (e) { /* non-JSON */ }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const pad = n => String(n).padStart(2, '0');
const fmtClock = (t, sec = true) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: sec ? '2-digit' : undefined });
const fmtDate = t => new Date(t * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDT = t => fmtDate(t) + ', ' + fmtClock(t, false);
function fmtDur(s) {
  s = Math.round(s);
  if (s < 60) return s + ' sec';
  if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
  return Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min';
}
const fmtTimer = s => pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(Math.floor(s) % 60);
const CH_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
const KIND_LABEL = { pixelation: 'Pixelated', freeze: 'Froze', audio: 'Sound dropped', other: 'Other' };

// ------------------------------------------------------------------ app state
const S = {
  tab: 'monitor', lineup: [], favOnly: store.get('favOnly', false), filter: '', selected: store.get('selected', []),
  live: null, lastActive: false, doneInfo: null, lineupFor: null,
  sessions: [], current: null, zoom: null, magnify: false, confirmDel: null, failures: 0,
};

// ------------------------------------------------------------------ tabs
function setTab(t) {
  S.tab = t;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  for (const id of ['monitor', 'analyze', 'help']) $('#tab-' + id).hidden = id !== t;
  store.set('tab', t);
  if (t === 'analyze') { loadSessions(); if (S.current) renderReport(); }
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ------------------------------------------------------------------ polling
async function poll() {
  let delay = document.hidden ? 3000 : 1000;
  try {
    S.live = await api('/live');
    S.failures = 0;
    $('#banner').hidden = true;
    onLive();
  } catch (e) {
    S.failures++;
    if (S.failures >= 2) {
      const b = $('#banner');
      b.className = 'banner bad'; b.hidden = false;
      b.textContent = 'Lost contact with the monitor program. Make sure the Terminal window running it is still open, then reload this page.';
    }
    delay = 2500;
  }
  setTimeout(poll, delay);
}

function onLive() {
  const L = S.live, d = L.device, rec = L.rec;
  const pill = $('#devpill');
  pill.className = 'pill ' + (d.ok ? 'ok' : 'bad');
  const busy = L.tuners.filter(t => t.Resource.startsWith('tuner') && t.VctNumber).length;
  $('#devtext').textContent = d.ok ? `${d.FriendlyName || 'HDHomeRun'} · ${d.ip} · ${busy} of ${d.TunerCount || L.tuners.filter(t => t.Resource.startsWith('tuner')).length} tuners in use`
    : (d.ip ? `Can't reach HDHomeRun at ${d.ip}` : 'No HDHomeRun found yet');
  $('#card-device').hidden = d.ok;
  if (!d.ok && !$('#ip-input').value && d.ip) $('#ip-input').value = d.ip;

  if (d.ok && S.lineupFor !== d.ip) { S.lineupFor = d.ip; loadLineup(); }

  // recording transitions
  if (S.lastActive && !rec.active) {
    const lf = rec.last_finished;
    if (lf) { S.doneInfo = lf; }
  }
  if (rec.active) S.doneInfo = null;
  S.lastActive = rec.active;

  $('#rec-idle').hidden = rec.active;
  $('#rec-active').hidden = !rec.active;
  $('#rec-done').hidden = !(S.doneInfo && !rec.active);
  if (S.doneInfo && !rec.active) {
    $('#done-text').textContent = `Recording saved (${S.doneInfo.samples} readings). `;
  }
  if (rec.active) renderRecording(rec);
  renderRecordGate();
  renderLive();
  renderTunerTable();
  if (S.tab === 'analyze' && rec.active !== S._analyzeRecState) { S._analyzeRecState = rec.active; loadSessions(); }
}

// ------------------------------------------------------------------ channels
async function loadLineup() {
  try {
    S.lineup = (await api('/lineup')).channels;
    // forget saved selections that no longer exist
    const have = new Set(S.lineup.map(c => c.ch));
    S.selected = S.selected.filter(c => have.has(c));
    renderChannels();
  } catch (e) {
    $('#chan-list').textContent = "Couldn't read the channel list: " + e.message;
  }
}
function renderChannels() {
  const list = $('#chan-list');
  const q = S.filter.trim().toLowerCase();
  const rec = S.live && S.live.rec.active;
  const favs = S.lineup.some(c => c.fav);
  const items = S.lineup.filter(c => (!S.favOnly || !favs || c.fav || S.selected.includes(c.ch)) &&
    (!q || c.ch.includes(q) || (c.name || '').toLowerCase().includes(q)));
  const strip = $('#chan-selected'); strip.textContent = '';
  strip.append(h('span', { class: 'lab' }, S.selected.length ? 'Selected:' : 'Nothing selected yet - tick channels below.'));
  S.selected.forEach((ch, i) => {
    const info = S.lineup.find(c => c.ch === ch) || {};
    const x = h('button', { 'aria-label': 'Remove ' + ch, title: 'Remove', disabled: !!rec }, '×');
    x.addEventListener('click', () => { S.selected = S.selected.filter(v => v !== ch); store.set('selected', S.selected); renderChannels(); renderRecordGate(); });
    strip.append(h('span', { class: 'sel-chip' }, h('span', { class: 'key', style: `background:${CH_COLORS[i]}` }), `${ch} ${info.name || ''}`, rec ? null : x));
  });
  list.textContent = '';
  if (!items.length) list.append(h('p', { class: 'muted' }, 'No channels match.'));
  for (const c of items) {
    const on = S.selected.includes(c.ch);
    const idx = S.selected.indexOf(c.ch);
    const cb = h('input', { type: 'checkbox', 'aria-label': `${c.ch} ${c.name}` });
    cb.checked = on; cb.disabled = !!rec;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (S.selected.length >= 4) { cb.checked = false; return; }
        S.selected.push(c.ch);
      } else S.selected = S.selected.filter(x => x !== c.ch);
      store.set('selected', S.selected);
      renderChannels(); renderRecordGate();
    });
    list.append(h('label', { class: 'chan' + (on ? ' on' : '') + (rec ? ' disabled' : '') }, cb,
      h('span', { class: 'num' }, c.ch), h('span', { class: 'nm' }, c.name || ''),
      c.fav ? h('span', { class: 'star', title: 'A favorite on your HDHomeRun' }, '★') : null,
      on ? h('span', { class: 'key', style: `background:${CH_COLORS[idx]}` }) : null));
  }
  $('#chan-sub').textContent = 'Tick one or more (up to 4). Each channel uses one tuner while recording. Type in the box to search by number or name.';
}
$('#chan-filter').addEventListener('input', e => { S.filter = e.target.value; renderChannels(); });
$('#chan-all').checked = S.favOnly;
$('#chan-all').addEventListener('change', e => { S.favOnly = e.target.checked; store.set('favOnly', S.favOnly); renderChannels(); });

function freeTuners() {
  if (!S.live) return 0;
  return S.live.tuners.filter(t => t.Resource.startsWith('tuner') && !t.VctNumber).length;
}
function renderRecordGate() {
  const n = S.selected.length, free = freeTuners();
  const btn = $('#btn-record'), hint = $('#rec-hint');
  const ok = S.live && S.live.device.ok;
  btn.disabled = !(ok && n > 0 && n <= free);
  if (!ok) hint.textContent = 'Waiting for the HDHomeRun…';
  else if (!n) hint.textContent = 'Pick at least one channel above. While recording, keep this page open and the computer plugged in.';
  else if (n > free) hint.textContent = `You picked ${n} channel(s) but only ${free} tuner(s) are free right now (the others are in use by a recording or a TV). Pick fewer channels, or try later.`;
  else hint.textContent = `${n} channel(s) selected · ${free} tuner(s) free. Recording will use ${n} of them until you press Stop.`;
}

// ------------------------------------------------------------------ record / stop / mark
$('#btn-record').addEventListener('click', async () => {
  const msg = $('#rec-msg'); msg.textContent = '';
  try {
    await api('/record/start', { channels: S.selected, label: $('#rec-label').value, hours: parseFloat($('#rec-hours').value) });
    S.doneInfo = null;
    renderChannels();
  } catch (e) { msg.textContent = e.message; }
});
$('#btn-stop').addEventListener('click', async () => {
  try { await api('/record/stop', {}); } catch (e) { flash(e.message); }
});
async function mark(kind) {
  const ch = $('#mark-ch').value;
  try {
    await api('/marker', { kind, ch });
    flash(`✓ Marked "${KIND_LABEL[kind]}" at ${fmtClock(Date.now() / 1000)}`);
  } catch (e) { flash('Could not save the mark: ' + e.message); }
}
let flashTimer = null;
function flash(text) {
  const el = $('#mark-flash') || (() => { const e = h('div', { id: 'mark-flash', style: 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--ink);color:var(--surface);padding:.8rem 1.4rem;border-radius:999px;font-weight:650;z-index:50;box-shadow:0 8px 28px rgba(0,0,0,.3)' }); document.body.append(e); return e; })();
  el.textContent = text; el.hidden = false;
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
$$('.btn.mark').forEach(b => b.addEventListener('click', () => mark(b.dataset.kind)));
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && S.tab === 'monitor' && S.live && S.live.rec.active && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
    e.preventDefault(); mark('pixelation');
  }
});
$('#btn-analyze-last').addEventListener('click', async () => {
  const id = S.doneInfo && S.doneInfo.id;
  setTab('analyze');
  await loadSessions();
  if (id) openSession(id);
});

function renderRecording(rec) {
  $('#rec-timer').textContent = fmtTimer(rec.elapsed);
  $('#rec-name').textContent = (rec.label ? rec.label + ' · ' : '') + 'started ' + fmtClock(rec.started, false) +
    (rec.limit_s ? ' · stops after ' + fmtDur(rec.limit_s) : '');
  const sel = $('#mark-ch');
  const want = rec.channels.join(',');
  if (sel.dataset.chs !== want) {
    sel.dataset.chs = want; sel.textContent = '';
    if (rec.channels.length > 1) sel.append(h('option', { value: '' }, 'Not sure / any'));
    for (const c of rec.channels) sel.append(h('option', { value: c }, `${c} ${rec.names[c] || ''}`));
  }
  $('#mark-ch-wrap').hidden = rec.channels.length < 2;
  const log = $('#mark-log'); log.textContent = '';
  if (rec.markers.length) {
    log.append('Marked so far: ');
    rec.markers.slice(-8).forEach(m => log.append(h('span', {}, `${KIND_LABEL[m.kind] || 'Mark'} · ${fmtClock(m.t)}`)));
  }
  const msgs = $('#rec-messages'); msgs.textContent = '';
  rec.messages.slice(-5).forEach(m => msgs.append(h('div', {}, `${fmtClock(m.t)}  ${m.ch ? m.ch + ': ' : ''}${m.msg}`)));
}

// ------------------------------------------------------------------ live tiles
function verdict(l) {
  if (!l) return ['info', '…', 'Starting'];
  if (!l.connected) return ['bad', '✖', 'No stream'];
  if (l.warm) return ['info', '…', 'Locking'];
  const q = l.quality, s = l.strength;
  if ((q != null && q < 70) || l.max_gap_ms > 750) return ['bad', '✖', 'Problem'];
  if ((q != null && q < 90) || (s != null && s < 40) || l.cc_err || l.tei) return ['warn', '▲', 'Marginal'];
  return ['good', '✓', 'Good'];
}
function meter(label, v, kind) {
  const lvl = v == null ? '' : kind === 's' ? (v < 40 ? 'bad' : v < 60 ? 'warn' : '') : (v < 70 ? 'bad' : v < 90 ? 'warn' : '');
  return h('div', { class: 'meter' }, h('span', { class: 'lab' }, label),
    h('div', { class: 'track' }, h('div', { class: 'fill ' + lvl, style: `width:${v == null ? 0 : Math.max(0, Math.min(100, v))}%` })),
    h('span', { class: 'val' }, v == null ? '–' : v + '%'));
}
function renderLive() {
  const rec = S.live.rec, host = $('#live-tiles');
  host.textContent = '';
  if (!rec.active) {
    $('#rec-messages').textContent = '';
    $('#live-sub').textContent = '';
    host.append(h('p', { class: 'muted' }, 'Choose channels and press Record to see live signal strength, quality and video data for each one here.'));
    return;
  }
  $('#live-sub').textContent = 'updates every second';
  const draws = [];   // charts are drawn after every tile is in the page, so they measure their final width
  rec.channels.forEach((ch, i) => {
    const l = rec.latest[ch], hist = rec.history[ch] || [];
    const [lvl, icon, word] = verdict(l);
    const last60 = hist.slice(-60);
    const lost = last60.reduce((a, r) => a + (r[5] || 0), 0);
    const stalls = last60.filter(r => (r[6] || 0) > 750).length;
    const spark = h('div', { class: 'spark chart-wrap' });
    host.append(h('div', { class: 'tile' },
      h('div', { class: 'tile-head' }, h('span', { class: 'key', style: `background:${CH_COLORS[i]}` }),
        h('span', { class: 'big' }, `${ch}  ${rec.names[ch] || ''}`),
        h('span', { class: 'badge ' + lvl }, `${icon} ${word}`)),
      h('div', { class: 'meters' }, meter('Signal strength', l && l.strength, 's'), meter('Signal quality', l && l.quality, 'q'), meter('Symbol quality', l && l.symbol, 'q')),
      h('div', { class: 'mini-stats' },
        h('div', {}, 'Video data ', h('b', {}, l && !l.warm ? (l.rx_bps / 1e6).toFixed(1) + ' Mbps' : '–')),
        h('div', {}, 'Lost/bad packets (1 min) ', h('b', {}, String(lost))),
        h('div', {}, 'Stalls (1 min) ', h('b', {}, String(stalls))),
        h('div', {}, 'Tuner ', h('b', {}, l && l.tuner !== '' ? l.tuner : '–'))),
      spark));
    // 5-minute sparkline: strength (channel color) + quality (gray)
    const rows = hist.filter(r => !r[7] && r[8]);
    const t = rows.map(r => r[0]);
    const now = hist.length ? hist[hist.length - 1][0] : Date.now() / 1000;
    draws.push(() => drawChart(spark, {
      t0: now - 300, t1: now, compact: true, interactive: false, noAxis: true,
      panels: [{ title: '', h: 64, yMin: 0, yMax: 100, ticks: [0, 50, 100], series: [
        { name: 'Quality', color: 'var(--ink-2)', width: 1.5, t, v: rows.map(r => r[2]) },
        { name: 'Strength', color: CH_COLORS[i], width: 2, t, v: rows.map(r => r[1]) }] }],
    }));
  });
  draws.forEach(f => f());
}
function renderTunerTable() {
  const tb = $('#tuner-table tbody'); tb.textContent = '';
  for (const t of S.live.tuners) {
    if (t.Resource === 'record') {
      tb.append(h('tr', {}, h('td', {}, 'DVR'), h('td', { colspan: 5 }, 'Recording: ' + (t.Name || '')), h('td', {}, 'HDHomeRun DVR')));
      continue;
    }
    if (!t.Resource.startsWith('tuner')) continue;
    const mine = S.live.rec.active && S.live.rec.channels.includes(t.VctNumber) && t.TargetIP && t.TargetIP !== '[::1]';
    const who = !t.VctNumber ? 'idle' : mine ? 'this monitor' : (t.TargetIP === '[::1]' || t.TargetIP === '::1' ? 'DVR recording' : 'another device (' + t.TargetIP + ')');
    tb.append(h('tr', {}, h('td', {}, t.Resource.replace('tuner', '#')), h('td', {}, t.VctNumber ? `${t.VctNumber} ${t.VctName || ''}` : '–'),
      h('td', {}, t.SignalStrengthPercent != null ? t.SignalStrengthPercent + '%' : '–'), h('td', {}, t.SignalQualityPercent != null ? t.SignalQualityPercent + '%' : '–'),
      h('td', {}, t.SymbolQualityPercent != null ? t.SymbolQualityPercent + '%' : '–'),
      h('td', {}, t.NetworkRate ? (t.NetworkRate / 1e6).toFixed(1) + ' Mbps' : '–'), h('td', {}, who)));
  }
}

// ------------------------------------------------------------------ device selection
async function saveIp() {
  const msg = $('#ip-msg'); msg.textContent = 'Connecting…';
  try { await api('/device', { ip: $('#ip-input').value.trim() }); msg.textContent = ''; S.lineupFor = null; }
  catch (e) { msg.textContent = e.message; }
}
$('#ip-save').addEventListener('click', saveIp);
$('#ip-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveIp(); });
$('#ip-find').addEventListener('click', async () => {
  const msg = $('#ip-msg'); msg.textContent = 'Searching the network…';
  try {
    const d = (await api('/discover')).devices;
    if (!d.length) { msg.textContent = 'Nothing found. Check that the HDHomeRun is powered on and on the same network, or type its IP address.'; return; }
    $('#ip-input').value = d[0].ip; msg.textContent = ''; saveIp();
  } catch (e) { msg.textContent = e.message; }
});

// ================================================================== CHART ENGINE
function niceTimeTicks(t0, t1, W) {
  const span = t1 - t0, target = Math.max(3, Math.floor(W / 125));
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const step = steps.find(s => span / s <= target) || 86400;
  const tz = -new Date(t0 * 1000).getTimezoneOffset() * 60;
  const out = [];
  for (let t = Math.ceil((t0 + tz) / step) * step - tz; t <= t1; t += step) out.push(t);
  return { ticks: out, step };
}
function bsearch(arr, x) { // first index with arr[i] >= x
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
/* Reduce a series to at most ~1 point per 2 px, keeping each bucket's min and max so brief dips are never averaged away. */
function reduceSeries(t, v, t0, t1, px, agg) {
  const i0 = Math.max(0, bsearch(t, t0) - 1), i1 = Math.min(t.length, bsearch(t, t1) + 1);
  const pts = [];
  const n = i1 - i0;
  const nb = Math.max(20, Math.floor(px / 2));
  if (n <= nb * 1.3 && agg !== 'sum') {
    for (let i = i0; i < i1; i++) if (v[i] != null) pts.push({ t: t[i], mean: v[i], min: v[i], max: v[i], n: 1 });
    return { pts, bw: 0 };
  }
  const bw = (t1 - t0) / nb;
  const b = new Map();
  for (let i = i0; i < i1; i++) {
    if (v[i] == null) continue;
    const k = Math.floor((t[i] - t0) / bw);
    let o = b.get(k);
    if (!o) { o = { k, sum: 0, min: Infinity, max: -Infinity, n: 0 }; b.set(k, o); }
    o.sum += v[i]; o.n++; if (v[i] < o.min) o.min = v[i]; if (v[i] > o.max) o.max = v[i];
  }
  Array.from(b.values()).sort((a, c) => a.k - c.k).forEach(o => pts.push({ t: t0 + (o.k + 0.5) * bw, mean: o.sum / o.n, sum: o.sum, min: o.min, max: o.max, n: o.n }));
  return { pts, bw };
}

function drawChart(host, cfg) {
  host.textContent = '';
  const W = cfg.width || Math.max(300, host.clientWidth || 800);
  const compact = !!cfg.compact;
  const M = { l: compact ? 38 : 62, r: 14, t: 4, b: cfg.noAxis ? 4 : 36 };
  const PT = compact ? 0 : 22, GAP = compact ? 8 : 12;
  const t0 = cfg.t0, t1 = cfg.t1, span = Math.max(1, t1 - t0);
  const X = t => M.l + (t - t0) / span * (W - M.l - M.r);
  let y = M.t;
  for (const p of cfg.panels) { p.y0 = y + PT; p.y1 = p.y0 + p.h; y = p.y1 + GAP; }
  const H = y - GAP + M.b;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': cfg.label || 'chart' });
  const g = (a, ...k) => sv('g', a, ...k);
  const tk = niceTimeTicks(t0, t1, W);
  const text = (x, y, s, o) => sv('text', Object.assign({ x, y, 'font-size': 11, fill: 'var(--muted)', 'font-family': 'inherit' }, o || {}), s);

  for (const p of cfg.panels) {
    const Y = v => p.y1 - (v - p.yMin) / (p.yMax - p.yMin) * p.h;
    p.Y = Y;
    // zones (status colors at low opacity, always labelled)
    for (const z of (p.zones || [])) {
      const ya = Math.max(p.yMin, z.from), yb = Math.min(p.yMax, z.to);
      if (yb <= ya) continue;
      svg.append(sv('rect', { x: M.l, y: Y(yb), width: W - M.l - M.r, height: Y(ya) - Y(yb), style: `fill:${z.color};opacity:.11` }));
      if (!compact) svg.append(text(W - M.r - 4, Y(yb) + 12, z.label, { 'text-anchor': 'end', 'font-size': 10.5 }));
    }
    // horizontal grid + y labels
    for (const v of p.ticks) {
      if (v < p.yMin || v > p.yMax) continue;
      svg.append(sv('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), style: 'stroke:var(--grid)', 'stroke-width': 1 }));
      svg.append(text(M.l - 8, Y(v) + 4, (p.fmtTick ? p.fmtTick(v) : v), { 'text-anchor': 'end' }));
    }
    if (!compact) {
      for (const t of tk.ticks) svg.append(sv('line', { x1: X(t), x2: X(t), y1: p.y0, y2: p.y1, style: 'stroke:var(--grid)', 'stroke-width': 1 }));
      svg.append(text(M.l, p.y0 - 7, p.title, { 'font-size': 12.5, 'font-weight': 650, fill: 'var(--ink-2)' }));
      if (p.sub) svg.append(text(W - M.r, p.y0 - 7, p.sub, { 'text-anchor': 'end', 'font-size': 11 }));
    }
    // detected problem spans
    for (const e of (cfg.events || [])) {
      if (e.t1 < t0 || e.t0 > t1) continue;
      const xa = Math.max(M.l, X(e.t0 - 0.5)), xb = Math.min(W - M.r, X(e.t1 + 0.5));
      svg.append(sv('rect', { x: xa, y: p.y0, width: Math.max(3, xb - xa), height: p.h, style: 'fill:var(--crit);opacity:.16' }));
    }
    // series
    const clip = 'clip' + Math.random().toString(36).slice(2, 8);
    svg.append(sv('clipPath', { id: clip }, sv('rect', { x: M.l, y: p.y0 - 2, width: W - M.l - M.r, height: p.h + 4 })));
    const sg = g({ 'clip-path': `url(#${clip})` });
    svg.append(sg);
    const bars = p.series.filter(s => s.type === 'bars');
    if (bars.length) drawStack(sg, p, bars, cfg, X, W - M.l - M.r);
    for (const s of p.series) {
      if (s.type === 'bars') continue;
      const { pts, bw } = reduceSeries(s.t, s.v, t0, t1, W - M.l - M.r, 'mean');
      const brk = Math.max(2.6, bw * 2.6);
      const segs = []; let cur = null;
      for (const q of pts) {
        if (!cur || q.t - cur[cur.length - 1].t > brk) { cur = []; segs.push(cur); }
        cur.push(q);
      }
      for (const sgm of segs) {
        if (bw && sgm.length > 1) { // min..max envelope
          let d = 'M' + sgm.map(q => `${X(q.t).toFixed(1)},${Y(q.max).toFixed(1)}`).join('L');
          d += 'L' + sgm.slice().reverse().map(q => `${X(q.t).toFixed(1)},${Y(q.min).toFixed(1)}`).join('L') + 'Z';
          sg.append(sv('path', { d, style: `fill:${s.color};opacity:.16` }));
        }
        if (sgm.length === 1) { sg.append(sv('circle', { cx: X(sgm[0].t), cy: Y(sgm[0].mean), r: 2.5, style: `fill:${s.color}` })); continue; }
        const d = 'M' + sgm.map(q => `${X(q.t).toFixed(1)},${Y(q.mean).toFixed(1)}`).join('L');
        sg.append(sv('path', { d, fill: 'none', style: `stroke:${s.color}`, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
      // brief single-sample dips would vanish into the line: ring them
      if (!bw && s.ringBelow != null) for (const q of pts) if (q.mean < s.ringBelow) sg.append(sv('circle', { cx: X(q.t), cy: Y(q.mean), r: 4, style: `fill:${s.color};stroke:var(--surface)`, 'stroke-width': 2 }));
    }
  }
  // glitch markers
  (cfg.markers || []).forEach(m => {
    if (m.t < t0 || m.t > t1) return;
    const x = X(m.t);
    svg.append(sv('line', { x1: x, x2: x, y1: cfg.panels[0].y0 - (compact ? 0 : 6), y2: cfg.panels[cfg.panels.length - 1].y1, style: 'stroke:var(--glitch)', 'stroke-width': 1.6 }));
    svg.append(sv('circle', { cx: x, cy: cfg.panels[0].y0 - 14, r: 9, style: 'fill:var(--glitch)' }));
    svg.append(sv('text', { x, y: cfg.panels[0].y0 - 10, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, style: 'fill:var(--surface)' }, String(m.n)));
  });
  // time axis
  if (!cfg.noAxis) {
    const ay = cfg.panels[cfg.panels.length - 1].y1;
    for (const t of tk.ticks) {
      svg.append(sv('line', { x1: X(t), x2: X(t), y1: ay, y2: ay + 4, style: 'stroke:var(--muted)' }));
      svg.append(text(X(t), ay + 17, fmtClock(t, tk.step < 60), { 'text-anchor': 'middle', 'font-size': 11.5 }));
    }
    const d0 = fmtDate(t0), d1 = fmtDate(t1);
    svg.append(text(M.l, ay + 32, d0 === d1 ? d0 : d0 + '  →  ' + d1, { 'font-size': 10.5 }));
  }
  host.append(svg);

  // ---- interaction: crosshair + tooltip + drag to zoom
  if (cfg.interactive === false) return;
  const cross = sv('line', { y1: cfg.panels[0].y0, y2: cfg.panels[cfg.panels.length - 1].y1, style: 'stroke:var(--ink-2)', 'stroke-width': 1, visibility: 'hidden' });
  const sel = sv('rect', { y: cfg.panels[0].y0, height: cfg.panels[cfg.panels.length - 1].y1 - cfg.panels[0].y0, style: 'fill:var(--accent);opacity:.18', visibility: 'hidden' });
  const ov = sv('rect', { x: M.l, y: cfg.panels[0].y0, width: W - M.l - M.r, height: cfg.panels[cfg.panels.length - 1].y1 - cfg.panels[0].y0, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(sel, cross, ov);
  const tip = h('div', { class: 'tip' }); tip.hidden = true; host.append(tip);
  const toT = ev => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width); return { px, py: (ev.clientY - r.top) * (H / r.height), t: t0 + (px - M.l) / (W - M.l - M.r) * span }; };
  let dragX = null;
  ov.addEventListener('pointermove', ev => {
    const p = toT(ev);
    if (dragX != null) {
      const a = Math.min(dragX, p.px), b = Math.max(dragX, p.px);
      sel.setAttribute('x', a); sel.setAttribute('width', b - a); sel.setAttribute('visibility', 'visible');
      tip.hidden = true; return;
    }
    const info = cfg.hover ? cfg.hover(p.t) : null;
    if (!info) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); return; }
    const sx = X(info.snap);
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx); cross.setAttribute('visibility', 'visible');
    tip.textContent = '';
    tip.append(h('div', { class: 'tt' }, info.title));
    for (const r of info.rows) tip.append(h('div', { class: 'tr' }, h('i', { style: `background:${r.color}` }), h('span', {}, r.name), h('b', {}, r.val)));
    tip.hidden = false;
    const r = host.getBoundingClientRect(), pxl = ev.clientX - r.left;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(0, Math.min(r.width - tw, pxl + 16 + tw > r.width ? pxl - tw - 16 : pxl + 16)) + 'px';
    tip.style.top = Math.max(0, Math.min(H - th, (ev.clientY - r.top) - th / 2)) + 'px';
  });
  ov.addEventListener('pointerleave', () => { if (dragX == null) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); } });
  ov.addEventListener('pointerdown', ev => { dragX = toT(ev).px; ov.setPointerCapture(ev.pointerId); });
  ov.addEventListener('pointerup', ev => {
    if (dragX == null) return;
    const a = dragX, b = toT(ev).px; dragX = null; sel.setAttribute('visibility', 'hidden');
    if (Math.abs(b - a) > 8 && cfg.onZoom) {
      const ta = t0 + (Math.min(a, b) - M.l) / (W - M.l - M.r) * span, tb = t0 + (Math.max(a, b) - M.l) / (W - M.l - M.r) * span;
      cfg.onZoom(Math.max(cfg.full0, ta), Math.min(cfg.full1, tb));
    }
  });
  ov.addEventListener('dblclick', () => cfg.onZoom && cfg.onZoom(null, null));
}

function drawStack(sg, p, bars, cfg, X, plotW) {
  const t0 = cfg.t0, t1 = cfg.t1;
  const red = bars.map(s => reduceSeries(s.t, s.v, t0, t1, plotW, 'sum'));
  // align by bucket time
  const byT = new Map(); let bw = 0;
  red.forEach((r, i) => { bw = Math.max(bw, r.bw); r.pts.forEach(q => { const k = q.t.toFixed(3); let o = byT.get(k); if (!o) { o = { t: q.t, v: bars.map(() => 0) }; byT.set(k, o); } o.v[i] = r.bw ? q.sum : q.mean; }); });
  const pps = plotW / (t1 - t0);   // pixels per second
  const colW = Math.max(2, Math.min(24, bw ? bw * pps - 1 : pps * 0.8));
  for (const o of byT.values()) {
    let acc = 0;
    o.v.forEach((v, i) => {
      if (!v) return;
      const ya = p.Y(Math.min(p.yMax, acc)), yb = p.Y(Math.min(p.yMax, acc + v));
      sg.append(sv('rect', { x: X(o.t) - colW / 2, y: yb, width: colW, height: Math.max(2, ya - yb - 1), rx: 2, style: `fill:${bars[i].color}` }));
      acc += v;
    });
  }
}

// ================================================================== ANALYZE
async function loadSessions() {
  try { S.sessions = (await api('/sessions')).sessions; } catch (e) { S.sessions = []; }
  renderSessions();
}
function renderSessions() {
  const host = $('#sess-list'); host.textContent = '';
  if (!S.sessions.length) { host.append(h('p', { class: 'muted' }, 'No recordings yet. Go to the Monitor tab and press Record.')); return; }
  for (const s of S.sessions) {
    const on = S.current && S.current.meta.id === s.id;
    const chs = s.channels.map(c => `${c} ${s.names[c] || ''}`).join(' · ');
    const card = h('div', { class: 'sess' + (on ? ' on' : ''), tabindex: 0 },
      h('div', { class: 't' }, s.label || fmtDT(s.start)),
      h('div', { class: 'd' }, (s.label ? fmtDT(s.start) + ' · ' : '') + fmtDur((s.end || s.start) - s.start)),
      h('div', { class: 'd' }, chs),
      h('div', { class: 'tags' }, `${s.samples} readings · ${s.markers} marked` + (s.live ? ' · recording now' : s.interrupted ? ' · interrupted' : '')));
    card.addEventListener('click', () => openSession(s.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter') openSession(s.id); });
    host.append(card);
  }
}
async function openSession(id) {
  try {
    const d = await api('/sessions/' + encodeURIComponent(id));
    prepare(d);
    S.current = d; S.zoom = null; S.confirmDel = null;
    renderSessions(); renderReport();
    window.scrollTo({ top: 0 });
  } catch (e) { $('#report').textContent = ''; $('#report').append(h('div', { class: 'card' }, 'Could not open that recording: ' + e.message)); }
}
function prepare(d) {   // derive plotting arrays once
  d.full0 = Infinity; d.full1 = -Infinity;
  for (const ch of Object.keys(d.series)) {
    const c = d.series[ch], n = c.t.length;
    c.mbps = c.rx_bps.map(v => v == null ? null : v / 1e6);
    c.stall = c.t.map((_, i) => c.warm[i] ? null : ((c.max_gap_ms[i] || 0) > 750 || c.rx_bps[i] === 0 || !c.connected[i]) ? 1 : 0);
    c.cc0 = c.cc_err.map(v => v == null ? null : v);
    if (n) { d.full0 = Math.min(d.full0, c.t[0]); d.full1 = Math.max(d.full1, c.t[n - 1]); }
  }
  d.markers = d.glitches;
  if (!isFinite(d.full0)) { d.full0 = d.meta.start; d.full1 = d.meta.start + 1; }
  d.full1 = Math.max(d.full1, d.full0 + 5);
}

const RESULT = {
  rf: ['pill-r', 'Radio-signal dip'], stream: ['pill-s', 'Stream errors'], both: ['pill-b', 'Signal + stream'],
  none: ['pill-n', 'Nothing wrong seen'], nodata: ['pill-n', 'No data'],
};
function pill(res) { const [c, t] = RESULT[res]; return h('span', { class: c }, t); }
function icon(level) { return { good: '✓', warn: '▲', bad: '✖', info: 'ⓘ' }[level]; }

function renderReport() {
  const d = S.current, host = $('#report');
  host.textContent = '';
  if (!d) { host.append(h('div', { class: 'card empty' }, h('h2', {}, 'Pick a recording on the left'))); return; }
  const m = d.meta, dur = (m.end || d.full1) - m.start;
  const title = m.label || ('Recording · ' + fmtDT(m.start));

  // header + toolbar
  const mag = h('input', { type: 'checkbox' }); mag.checked = S.magnify;
  mag.addEventListener('change', () => { S.magnify = mag.checked; renderCharts(); });
  const del = h('button', { class: 'btn ghost small' }, S.confirmDel === m.id ? 'Really delete? Click again' : 'Delete');
  del.addEventListener('click', async () => {
    if (S.confirmDel !== m.id) { S.confirmDel = m.id; renderReport(); return; }
    try { await api(`/sessions/${encodeURIComponent(m.id)}/delete`, {}); S.current = null; S.confirmDel = null; await loadSessions(); renderReport(); } catch (e) { flash(e.message); }
  });
  host.append(h('div', { class: 'rep-head' },
    h('div', {}, h('h2', {}, title),
      h('div', { class: 'sub' }, `${fmtDT(m.start)} → ${fmtClock(m.end || d.full1, false)} · ${fmtDur(dur)} · ${(m.device && m.device.FriendlyName) || 'HDHomeRun'} (${m.device_ip})` +
        (m.link && m.link !== 'unknown' ? ` · this computer on ${m.link}` : ''))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'check small' }, mag, 'Magnify small changes'),
      h('a', { class: 'btn ghost small', href: `/api/sessions/${encodeURIComponent(m.id)}/csv`, download: m.id + '.csv', style: 'text-decoration:none' }, 'Download data (CSV)'),
      h('button', { class: 'btn ghost small', title: 'Graph pages print in landscape, one channel per page. If your browser ignores that, choose Landscape in the print window.', onclick: () => window.print() }, 'Print / save as PDF'),
      del)));

  // findings
  const F = d.findings;
  if (F.length) {
    host.append(findingEl(F[0], true));
    if (F.length > 1) {
      host.append(h('div', { class: 'sec-title' }, 'What else we noticed'));
      F.slice(1).forEach(f => host.append(findingEl(f)));
    }
  }

  // glitches
  if (d.glitches.length) {
    host.append(h('div', { class: 'sec-title' }, 'Moments you marked'));
    host.append(h('p', { class: 'hint' }, 'For each mark we look at the 15 seconds before and 3 seconds after your click. Click a row to zoom the graphs to that moment.'));
    const tb = h('tbody');
    d.glitches.forEach(g => {
      const tr = h('tr', { class: 'clickable', title: 'Click to zoom the graphs to this moment' },
        h('td', {}, h('b', {}, '#' + g.n)), h('td', {}, fmtClock(g.t)), h('td', {}, KIND_LABEL[g.kind] || g.kind),
        h('td', {}, g.ch ? `${g.ch} ${(m.names || {})[g.ch] || ''}` : 'any'), h('td', {}, pill(g.result)),
        h('td', { class: 'num' }, g.min_s == null ? '–' : g.min_s + '%'), h('td', { class: 'num' }, g.min_q == null ? '–' : g.min_q + '%'),
        h('td', { class: 'num' }, g.result === 'nodata' ? '–' : String(g.cc)), h('td', { class: 'num' }, g.result === 'nodata' ? '–' : g.gap + ' ms'));
      tr.addEventListener('click', () => { setZoom(Math.max(d.full0, g.t - 60), Math.min(d.full1, g.t + 30)); document.getElementById('charts-anchor').scrollIntoView({ behavior: 'smooth' }); });
      tb.append(tr);
    });
    host.append(h('div', { class: 'card' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['#', 'Time', 'You marked', 'Channel', 'What the instruments saw around then', 'Lowest strength', 'Lowest quality', 'Bad packets', 'Longest pause'].map((t, i) => h('th', { class: i > 4 ? 'num' : '' }, t)))), tb)));
  }

  // zoom bar + charts
  host.append(h('div', { id: 'charts-anchor' }));
  host.append(h('div', { class: 'sec-title no-print' }, 'Detailed graphs'));
  host.append(h('div', { class: 'zoombar', id: 'zoombar' }));
  const chartsHost = h('div', { id: 'charts-host' });
  host.append(chartsHost);
  renderCharts();

  // channel summary table
  host.append(h('div', { class: 'sec-title' }, 'Numbers at a glance'));
  host.append(summaryTable(d));

  // events
  const evRows = [];
  d.channels.forEach(c => c.events.forEach(e => evRows.push({ c, e })));
  evRows.sort((a, b) => a.e.t0 - b.e.t0);
  host.append(h('div', { class: 'sec-title' }, `Every problem the instruments detected (${evRows.length})`));
  if (!evRows.length) host.append(h('div', { class: 'card muted' }, 'None. Strength stayed above 40%, quality above 90%, and no video data was lost or stalled.'));
  else {
    const tb = h('tbody');
    evRows.slice(0, 300).forEach(({ c, e }) => {
      const det = [];
      if (e.rf) det.push(`lowest strength ${e.min_s}%, quality ${e.min_q}%` + (e.min_y != null && e.min_y < 90 ? `, symbol ${e.min_y}%` : ''));
      if (e.stream) det.push([e.cc ? `${e.cc} lost-packet event(s) (~${e.lost} packets)` : '', e.tei ? `${e.tei} error-flagged packets` : '', e.max_gap > 750 ? `pause of ${e.max_gap} ms` : ''].filter(Boolean).join(', ') || 'stream down');
      const tr = h('tr', { class: 'clickable' }, h('td', {}, fmtClock(e.t0)), h('td', {}, `${c.ch} ${c.name}`), h('td', { class: 'num' }, e.dur + ' s'),
        h('td', {}, pill(e.kind === 'rf' ? 'rf' : e.kind === 'stream' ? 'stream' : 'both')), h('td', {}, det.join(' · ')));
      tr.addEventListener('click', () => { setZoom(Math.max(d.full0, e.t0 - 30), Math.min(d.full1, e.t1 + 30)); document.getElementById('charts-anchor').scrollIntoView({ behavior: 'smooth' }); });
      tb.append(tr);
    });
    host.append(h('div', { class: 'card' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Start'), h('th', {}, 'Channel'), h('th', { class: 'num' }, 'Length'), h('th', {}, 'Type'), h('th', {}, 'Details'))), tb),
      evRows.length > 300 ? h('p', { class: 'hint' }, `Showing the first 300 of ${evRows.length}. The full data is in the CSV download.`) : null));
  }
  const log = d.events.filter(e => e.type !== 'marker');
  if (log.length) host.append(h('details', { class: 'card' }, h('summary', {}, 'Recording log'), h('div', { class: 'messages' }, ...log.map(e => h('div', {}, `${fmtClock(e.t)}  ${e.ch ? e.ch + ': ' : ''}${e.msg}`)))));
}
function findingEl(f, head) {
  return h('div', { class: `finding ${f.level}` + (head ? ' head' : '') }, h('div', { class: 'ic' }, icon(f.level)), h('div', {}, h('div', { class: 'ft' }, f.title), h('p', { class: 'fx' }, f.text)));
}
function summaryTable(d) {
  const f = (s, k) => s ? s[k] : '–';
  const tb = h('tbody');
  d.channels.forEach((c, i) => tb.append(h('tr', {},
    h('td', {}, h('span', { class: 'key', style: `display:inline-block;width:16px;height:4px;border-radius:2px;margin-right:.5rem;background:${CH_COLORS[i]}` }), `${c.ch} ${c.name}`),
    h('td', { class: 'num' }, fmtDur(c.seconds)),
    h('td', { class: 'num' }, `${f(c.strength, 'min')} / ${f(c.strength, 'avg')} / ${f(c.strength, 'max')} %`),
    h('td', { class: 'num' }, `${f(c.quality, 'min')} / ${f(c.quality, 'avg')} / ${f(c.quality, 'max')} %`),
    h('td', { class: 'num' }, c.pct_quality_low == null ? '–' : c.pct_quality_low + '%'),
    h('td', { class: 'num' }, `${f(c.rx_mbps, 'avg')} Mbps`),
    h('td', { class: 'num' }, `${c.cc_err} (~${c.cc_lost})`), h('td', { class: 'num' }, String(c.tei)),
    h('td', { class: 'num' }, String(c.stall_secs)), h('td', { class: 'num' }, String(c.events.length)))));
  return h('div', { class: 'card', style: 'overflow:auto' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, ...['Channel', 'Recorded', 'Strength min / avg / max', 'Quality min / avg / max', 'Time quality < 90%', 'Video rate (avg)', 'Lost-packet events (~packets)', 'Error-flagged packets', 'Stalled seconds', 'Problem events'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))), tb));
}

function printCaption(d) {
  const m = d.meta;
  return (m.label || 'Recording') + ' · ' + fmtDT(m.start) + ' · ' + fmtDur((m.end || d.full1) - m.start) + (S.zoom ? ' · zoomed to ' + fmtClock(S.zoom[0]) + '–' + fmtClock(S.zoom[1]) : '');
}
function setZoom(a, b) { S.zoom = a == null ? null : [a, b]; renderCharts(); }

function renderCharts() {
  const d = S.current, host = $('#charts-host');
  if (!d || !host) return;
  host.textContent = '';
  const t0 = S.zoom ? S.zoom[0] : d.full0, t1 = S.zoom ? S.zoom[1] : d.full1;
  const zb = $('#zoombar'); zb.textContent = '';
  zb.append(S.zoom ? `Zoomed to ${fmtClock(t0)} – ${fmtClock(t1)} (${fmtDur(t1 - t0)}). ` : 'Showing the whole recording. ',
    S.zoom ? h('button', { class: 'btn ghost small', onclick: () => setZoom(null) }, 'Show whole recording') : 'Tip: drag across any graph to zoom in; double-click to zoom back out.');
  const common = { t0, t1, full0: d.full0, full1: d.full1, onZoom: setZoom, markers: d.markers, width: S.printW || null };

  // data-driven y floor for "magnify"
  const lowest = key => { let lo = 100; d.channels.forEach(c => { for (const v of d.series[c.ch][key]) if (v != null && v < lo) lo = v; }); return lo; };
  const yFloor = key => S.magnify ? Math.max(0, Math.floor((lowest(key) - 4) / 10) * 10) : 0;

  d.channels.forEach((c, i) => {
    const s = d.series[c.ch], col = CH_COLORS[i];
    let maxRate = 1, maxErr = 2;
    for (let k = 0; k < s.t.length; k++) {
      if (s.mbps[k] != null && s.mbps[k] > maxRate) maxRate = s.mbps[k];
      const e = (s.cc0[k] || 0) + (s.tei[k] || 0) + (s.stall[k] || 0);
      if (e > maxErr) maxErr = e;
    }
    const sFloor = yFloor('strength'), qFloor = Math.min(yFloor('quality'), yFloor('symbol'));
    const rateMax = Math.ceil(maxRate * 1.15), rateTick = Math.max(1, Math.ceil(rateMax / 4));
    const wrap = h('div', { class: 'chart-wrap' });
    const kp = (l, v) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
    const fm = (o, k, u = '%') => o ? o[k] + u : '–';
    const card = h('div', { class: 'card chart-card' },
      h('div', { class: 'print-only sub' }, printCaption(d)),
      h('div', { class: 'chart-head' }, h('span', { class: 'key', style: `background:${col}` }), h('h3', {}, `${c.ch}  ${c.name}`)),
      h('div', { class: 'kpis' }, kp('average strength', fm(c.strength, 'avg')), kp('lowest strength', fm(c.strength, 'min')), kp('average quality', fm(c.quality, 'avg')), kp('lowest quality', fm(c.quality, 'min')),
        kp('video rate', fm(c.rx_mbps, 'avg', ' Mbps')), kp('lost packets', String(c.cc_lost)), kp('stalled seconds', String(c.stall_secs)), kp('problem events', String(c.events.length))),
      wrap,
      h('div', { class: 'legend' }, h('span', {}, h('i', { style: `background:${col}` }), 'Channel reading'), h('span', {}, h('i', { style: 'background:var(--ink-2)' }), 'Secondary reading (symbol quality / error-flagged packets)'),
        h('span', {}, h('i', { class: 'sw', style: 'background:var(--crit)' }), 'Detected problem'), h('span', {}, h('i', { class: 'gl' }), 'Moment you marked'),
        h('span', { class: 'muted' }, 'Shaded band around a line = the lowest-to-highest reading in that stretch; gaps = tuner connecting.')));
    host.append(card);
    const chMarkers = d.markers.filter(g => !g.ch || g.ch === c.ch);
    drawChart(wrap, Object.assign({}, common, {
      label: `Graphs for channel ${c.ch}`, markers: chMarkers, events: c.events,
      panels: [
        { title: 'Signal strength', sub: 'how much radio power reaches the tuner', h: 118, yMin: sFloor, yMax: 100, ticks: ticks(sFloor, 100),
          zones: [{ from: 0, to: 40, color: 'var(--crit)', label: 'weak' }, { from: 40, to: 60, color: 'var(--warn)', label: 'low margin' }],
          series: [{ name: 'Strength', color: col, t: s.t, v: s.strength, width: 2, ringBelow: 60 }] },
        { title: 'Signal quality', sub: 'how cleanly the signal can be decoded (should stay at 100%)', h: 118, yMin: qFloor, yMax: 100, ticks: ticks(qFloor, 100),
          zones: [{ from: 0, to: 70, color: 'var(--crit)', label: 'bad' }, { from: 70, to: 90, color: 'var(--warn)', label: 'marginal' }],
          series: [{ name: 'Symbol quality', color: 'var(--ink-2)', t: s.t, v: s.symbol, width: 1.5, ringBelow: 90 }, { name: 'Quality', color: col, t: s.t, v: s.quality, width: 2, ringBelow: 90 }] },
        { title: 'Video received by this computer', sub: 'Mbps; flat zero or a sudden fall means the stream stalled', h: 100, yMin: 0, yMax: rateMax, ticks: rangeTicks(0, rateMax, rateTick), series: [{ name: 'Video rate', color: col, t: s.t, v: s.mbps, width: 2 }] },
        { title: 'Stream trouble per second', sub: 'lost packets · error-flagged packets · stalls (network problems show here, not above)', h: 84, yMin: 0, yMax: maxErr, ticks: rangeTicks(0, maxErr, Math.max(1, Math.ceil(maxErr / 3))),
          series: [{ name: 'Stalled', type: 'bars', color: 'var(--ink)', t: s.t, v: s.stall }, { name: 'Error-flagged packets', type: 'bars', color: 'var(--ink-2)', t: s.t, v: s.tei }, { name: 'Lost-packet events', type: 'bars', color: col, t: s.t, v: s.cc0 }] },
      ],
      hover: tt => hoverFor(d, c, s, col, tt),
    }));
  });

  if (d.channels.length > 1) {
    const wrap = h('div', { class: 'chart-wrap' });
    host.append(h('div', { class: 'card chart-card' }, h('div', { class: 'print-only sub' }, printCaption(d)), h('div', { class: 'chart-head' }, h('h3', {}, 'All channels compared')),
      h('p', { class: 'sub' }, 'If the lines dip together, the cause is common to all channels (antenna, cable, interference). If only one dips, look at that channel.'), wrap,
      h('div', { class: 'legend' }, ...d.channels.map((c, i) => h('span', {}, h('i', { style: `background:${CH_COLORS[i]}` }), `${c.ch} ${c.name}`)))));
    const sFloor = yFloor('strength'), qFloor = yFloor('quality');
    drawChart(wrap, Object.assign({}, common, {
      label: 'All channels compared', events: d.channels.flatMap(c => c.events.filter(e => e.rf)),
      panels: [
        { title: 'Signal strength', h: 110, yMin: sFloor, yMax: 100, ticks: ticks(sFloor, 100), zones: [{ from: 0, to: 40, color: 'var(--crit)', label: 'weak' }],
          series: d.channels.map((c, i) => ({ name: c.ch, color: CH_COLORS[i], t: d.series[c.ch].t, v: d.series[c.ch].strength, width: 2 })) },
        { title: 'Signal quality', h: 110, yMin: qFloor, yMax: 100, ticks: ticks(qFloor, 100), zones: [{ from: 0, to: 90, color: 'var(--warn)', label: 'below 90%' }],
          series: d.channels.map((c, i) => ({ name: c.ch, color: CH_COLORS[i], t: d.series[c.ch].t, v: d.series[c.ch].quality, width: 2 })) },
      ],
      hover: tt => {
        const rows = []; let snap = null;
        d.channels.forEach((c, i) => { const s = d.series[c.ch], k = nearest(s.t, tt); if (k < 0) return; snap = snap == null ? s.t[k] : snap;
          rows.push({ name: `${c.ch} strength`, color: CH_COLORS[i], val: s.strength[k] == null ? '–' : s.strength[k] + '%' }, { name: `${c.ch} quality`, color: CH_COLORS[i], val: s.quality[k] == null ? '–' : s.quality[k] + '%' }); });
        return snap == null ? null : { snap, title: fmtClock(snap), rows };
      },
    }));
  }
}
function ticks(lo, hi) { const st = (hi - lo) > 60 ? 50 : 10; const out = []; for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) out.push(v); return out.length > 1 ? out : [lo, hi]; }
function rangeTicks(lo, hi, st) { const out = []; for (let v = lo; v <= hi + 1e-9; v += st) out.push(Math.round(v * 100) / 100); return out; }
function nearest(t, x) {
  if (!t.length) return -1;
  const i = bsearch(t, x);
  if (i <= 0) return 0; if (i >= t.length) return t.length - 1;
  return (x - t[i - 1] < t[i] - x) ? i - 1 : i;
}
function hoverFor(d, c, s, col, tt) {
  const k = nearest(s.t, tt);
  if (k < 0 || Math.abs(s.t[k] - tt) > Math.max(3, (d.full1 - d.full0) / 600)) return null;
  const pc = v => v == null ? '–' : v + '%';
  const rows = [
    { name: 'Strength', color: col, val: pc(s.strength[k]) }, { name: 'Quality', color: col, val: pc(s.quality[k]) },
    { name: 'Symbol quality', color: 'var(--ink-2)', val: pc(s.symbol[k]) },
    { name: 'Video rate', color: col, val: s.mbps[k] == null ? '–' : s.mbps[k].toFixed(1) + ' Mbps' },
    { name: 'Lost-packet events', color: col, val: s.cc_err[k] == null ? '–' : String(s.cc_err[k]) },
    { name: 'Error-flagged packets', color: 'var(--ink-2)', val: s.tei[k] == null ? '–' : String(s.tei[k]) },
    { name: 'Longest pause', color: 'var(--ink)', val: s.max_gap_ms[k] == null ? '–' : s.max_gap_ms[k] + ' ms' },
  ];
  let title = fmtClock(s.t[k]);
  if (s.warm[k]) title += ' · tuner connecting';
  const g = d.markers.find(m => Math.abs(m.t - s.t[k]) < 8);
  if (g) title += ` · near your mark #${g.n}`;
  return { snap: s.t[k], title, rows };
}

function setPrintMode(on) {
  const w = on ? 930 : null;     // width of a landscape page's printable area, in CSS px
  if (S.printW === w) return;
  S.printW = w;
  if (S.current && S.tab === 'analyze') renderCharts();
}
window.addEventListener('beforeprint', () => setPrintMode(true));
window.addEventListener('afterprint', () => setPrintMode(false));
try { const mq = window.matchMedia('print'); const f = e => setPrintMode(e.matches); mq.addEventListener ? mq.addEventListener('change', f) : mq.addListener(f); } catch (e) { /* older browsers */ }
window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (S.tab === 'analyze') renderCharts(); }, 150); });
$('#sess-refresh').addEventListener('click', loadSessions);

// ------------------------------------------------------------------ go
setTab(store.get('tab', 'monitor'));
poll();
(async function deepLink() {      // e.g. http://localhost:8787/#open=2026-11-24_161523
  const m = /open=([\w-]+)/.exec(location.hash);
  if (!m) return;
  if (/print=1/.test(location.hash)) S.printW = 930;   // test hook: lay the charts out exactly as the print path does
  setTab('analyze'); await loadSessions(); await openSession(m[1]);
})();
