// app.js — Caliper v2 frontend. caliper.run design language over the live /v1 API.
// Ported from the v6 design prototype; the legacy UI is preserved at /legacy/index.html.
// No dependencies, no CDN: hand-rolled SVG charts, hash routing, guided tour, dark mode.

// ── live data layer ───────────────────────────────────────────────
// v2 UI: same renderers as the design prototype, fed by the live /v1 API.
let AGG = null, HOME = null, SESSIONS = null;
const FORESTS = {}, WORKFLOWS = {};
const state = { aggDone: false, scopePending: new Set() };
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path.split('?')[0] + ' → HTTP ' + r.status);
  return r.json();
}
const snapshotLabel = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function bootPanel(msg) {
  return '<div class="boot"><div class="b-inner"><div class="b-title">' + esc(msg) + '</div><div class="b-bar"><i></i></div></div></div>';
}

// ── shared helpers ────────────────────────────────────────────────
const isDark = () => document.documentElement.dataset.theme === 'dark';
const PALETTES = {
  light: { tiers: { opus: '#171717', fable: '#006bff', sonnet: '#8f8f8f', haiku: '#cfcfcf' },
           grid: '#eaeaea', gridSoft: '#f0f0f0', axis: '#8f8f8f', ink: '#171717', subtle: '#4d4d4d',
           segInf: '#171717', segTool: '#b5b5b5', nerf: '#dc2626', halo: '#fafafa' },
  dark:  { tiers: { opus: '#e8e8e8', fable: '#3b8bff', sonnet: '#8f8f8f', haiku: '#454545' },
           grid: '#2a2a2a', gridSoft: '#242424', axis: '#8f8f8f', ink: '#ededed', subtle: '#b9b9b9',
           segInf: '#e8e8e8', segTool: '#555555', nerf: '#f26d6d', halo: '#0a0a0a' },
};
const PAL = () => PALETTES[isDark() ? 'dark' : 'light'];
const TIER_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];
// dominant model ids as observed in this snapshot's sessions
const TIER_MODEL = { opus: 'claude-opus-4-8', fable: 'claude-fable-5', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' };
const tc = t => PAL().tiers[t] || (isDark() ? '#666' : '#c0c0c0');
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const usd = (n, dp) => {
  if (n == null || isNaN(n)) return '—';
  const d = dp != null ? dp : (n >= 100 ? 0 : 2);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const tok = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n ?? 0);
const fmtDur = ms => {
  if (!ms || ms < 0) return '—';
  if (ms >= 36e5) return Math.floor(ms/36e5) + 'h ' + Math.round((ms % 36e5)/6e4) + 'm';
  if (ms >= 6e4) return Math.floor(ms/6e4) + 'm ' + Math.round((ms % 6e4)/1e3) + 's';
  return (ms/1e3).toFixed(1) + 's';
};
const dayMs = 864e5;
const plural = (n, w) => n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's');
const parseDay = d => new Date(d + 'T00:00:00Z').getTime();
const fmtDay = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtWhen = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const cleanTitle = raw => {
  let t = String(raw || '(untitled)').replace(/\s+/g, ' ').trim();
  const m = t.match(/^Base directory for this skill: \S*skills\/([A-Za-z0-9_-]+)/);
  if (m) t = m[1] + ' skill session';
  t = t.replace(/^\[Image: [^\]]*\]\s*/, '') || '(pasted image)';
  return t;
};
const trunc = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
// same repo grouping the app uses (sessions.mjs repoOfCwd)
const repoOfCwd = cwd => {
  const m = String(cwd || '').match(/\/conductor\/workspaces\/([^/]+)\/[^/]+\/?$/);
  if (m) return m[1] + ' (worktrees)';
  return String(cwd || '').split('/').filter(Boolean).pop() || 'unknown';
};
const shortPath = cwd => String(cwd || '').split('/').filter(Boolean).slice(-2).join('/');

let T = null, ALL = [], LIVE_IDS = new Set(), byId = new Map(), byDay = [], lastDay = 0, w7 = null, w30 = null;
let homeSort = 'recent'; // survives the re-renders that happen while the machine scan streams in
let REPO_LAST = new Map();
const windowSum = days => {
  const from = lastDay - (days - 1) * dayMs;
  const rows = byDay.filter(r => parseDay(r.day) >= from);
  return { cost: rows.reduce((a, r) => a + r.costUsd, 0), sessions: rows.reduce((a, r) => a + r.sessions, 0) };
};
function computeDerived() {
  T = AGG ? AGG.totals : null;
  ALL = (SESSIONS && SESSIONS.sessions) || [];
  LIVE_IDS = new Set(((HOME && HOME.live) || []).map(s => s.id));
  byId = new Map(ALL.map(s => [s.id, s]));
  byDay = AGG ? [...AGG.byDay].sort((a, b) => a.day < b.day ? -1 : 1) : [];
  lastDay = byDay.length ? parseDay(byDay[byDay.length - 1].day) : Date.now();
  w7 = windowSum(7); w30 = windowSum(30);
  REPO_LAST = new Map();
  for (const x of ALL) { const r = repoOfCwd(x.cwd); const t = x.startedAt || ''; if (!REPO_LAST.has(r) || t > REPO_LAST.get(r)) REPO_LAST.set(r, t); }
}
function applyChrome() {
  const el = document.getElementById('hdr-live');
  if (LIVE_IDS.size) { el.hidden = false; el.textContent = LIVE_IDS.size + ' live'; } else { el.hidden = true; }
  const prog = AGG && AGG.progress ? AGG.progress.scannedSessions + '/' + AGG.progress.totalSessions : '…';
  document.getElementById('prov').textContent =
    'Live data from ~/.claude/projects — ' + (state.aggDone ? 'scanned ' + prog + ' sessions' : 'scanning ' + prog + ' sessions…') +
    '. Tier ink: opus=ink, fable=blue, sonnet/haiku=grays.';
}

// ── reusable renderers ────────────────────────────────────────────
function kpiHtml(items, cls) {
  return '<div class="kpis' + (cls ? ' ' + cls : '') + '">' + items.map(x =>
    '<div class="kpi' + (x.hero ? ' hero-kpi' : '') + '"' + (x.tour ? ' data-tour="' + x.tour + '"' : '') + '>' +
    '<div class="k"' + (x.tip ? ' title="' + esc(x.tip) + '"' : '') + '>' + x.k + '</div>' +
    '<div class="n">' + x.n + '</div><div class="d">' + x.d + '</div>' + (x.action || '') + '</div>').join('') + '</div>';
}
function sessRowHtml(s) {
  const title = trunc(cleanTitle(s.title), 86);
  const isPrompt = !/skill session$|^\(pasted image\)$/.test(title);
  return '<a class="sess-row" href="#/session/' + s.id + '">' +
    '<span class="dot" style="background:' + tc(s.tier) + '" title="' + esc(s.tier) + '"></span>' +
    '<span class="t">' + (isPrompt ? '&ldquo;' + esc(title) + '&rdquo;' : esc(title)) + (LIVE_IDS.has(s.id) ? '<span class="row-live">live</span>' : '') +
    '<small>' + esc(shortPath(s.cwd)) + ' · ' + esc(s.gitBranch || '') + ' · ' + (s.turns || 0) + ' turns</small></span>' +
    '<span class="when">' + fmtWhen(s.startedAt) + '</span>' +
    '<span class="cost">' + usd(s.costUsd) + '</span><span class="chev">›</span></a>';
}
function dailyChartSvg() {
  const DAYS = 30;
  const from = lastDay - (DAYS - 1) * dayMs;
  const map = new Map(byDay.map(r => [parseDay(r.day), r]));
  const rows = [];
  for (let t = from; t <= lastDay; t += dayMs) rows.push({ t, r: map.get(t) || null });
  const max = Math.max(...rows.map(x => x.r ? x.r.costUsd : 0), 0.01);
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = [1, 2, 5, 10].map(m => m * pow).find(v => v >= max);
  const W = 1140, H = 290, padL = 56, padB = 30, padT = 16;
  const cw = (W - padL) / DAYS, bw = Math.min(22, cw * 0.55);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img" aria-label="Daily spend, last 30 days">';
  for (let g = 0; g <= 4; g++) {
    const v = yMax * g / 4, y = H - padB - (H - padB - padT) * g / 4;
    s += '<line x1="' + padL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="' + PAL().grid + '" stroke-width="1"/>';
    s += '<text x="' + (padL - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="' + PAL().axis + '">' + usd(v, 0) + '</text>';
  }
  rows.forEach((x, i) => {
    const cx = padL + i * cw + cw / 2;
    if (new Date(x.t).getUTCDay() === 1) s += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="' + PAL().axis + '">' + fmtDay(x.t) + '</text>';
    if (!x.r || !x.r.costUsd) return;
    const segs = TIER_ORDER.filter(t => x.r.tiers[t]).concat(Object.keys(x.r.tiers).filter(t => !TIER_ORDER.includes(t)));
    const tipRows = segs.map(t =>
      '<div class="t-row"><span class="l"><i style="background:' + tc(t) + '"></i>' + esc(t) + '</span><span class="v">' + usd(x.r.tiers[t]) + '</span></div>').join('') +
      '<div class="t-row t-total"><span class="l">total · ' + x.r.sessions + ' session' + (x.r.sessions === 1 ? '' : 's') + '</span><span class="v">' + usd(x.r.costUsd) + '</span></div>' +
      (x.r.fallbacks ? '<div class="t-row"><span class="l"><i style="background:' + PAL().nerf + ';border-radius:50%"></i>nerfed</span><span class="v" style="color:' + PAL().nerf + '">' + x.r.fallbacks + '</span></div>' : '');
    const tip = '<div class="t-head">' + fmtDay(x.t) + '</div>' + tipRows;
    let g = '<g class="day-g" data-tip="' + esc(tip) + '">';
    g += '<rect x="' + (padL + i * cw) + '" y="' + padT + '" width="' + cw + '" height="' + (H - padB - padT) + '" fill="transparent"/>';
    let y = H - padB;
    segs.forEach(t => {
      const h = (x.r.tiers[t] / yMax) * (H - padB - padT);
      y -= h;
      g += '<rect class="bar" x="' + (cx - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h - 1, 0.5) + '" rx="3" fill="' + tc(t) + '"/>';
    });
    if (x.r.fallbacks) g += '<circle cx="' + cx + '" cy="' + (y - 9) + '" r="4.5" fill="' + PAL().nerf + '" stroke="' + PAL().halo + '" stroke-width="1.5"/>';
    s += g + '</g>';
  });
  return s + '</svg>';
}

// ── shared hover tooltip (charts + waterfall) ─────────────────────
(function tipEngine() {
  const tip = () => document.getElementById('tip');
  let current = null;
  const move = e => {
    const el = tip();
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + w > window.innerWidth - 12) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 12) y = e.clientY - h - 12;
    el.style.left = x + 'px'; el.style.top = y + 'px';
  };
  document.addEventListener('mousemove', e => {
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    const el = tip();
    if (!el) return;
    if (t) {
      if (current !== t) { current = t; el.innerHTML = t.getAttribute('data-tip'); el.style.display = 'block'; }
      move(e);
    } else if (current) { current = null; el.style.display = 'none'; }
  }, true);
})();
const legendHtml = () =>
  TIER_ORDER.map(t => '<span class="cl"><i style="background:' + tc(t) + '"></i>' + t + '</span>').join('') +
  '<span class="cl"><i style="background:' + PAL().nerf + ';border-radius:50%"></i>nerfed</span>';

// ── views ─────────────────────────────────────────────────────────
function renderHome() {
  setCrumbs([{ label: '⌂ All folders' }]);
  const view = document.getElementById('view');
  if (!AGG || !AGG.byRepo || !AGG.byRepo.length) { view.innerHTML = bootPanel('Scanning your sessions…'); return; }
  const repoRows = [...AGG.byRepo].sort((a, b) => b.costUsd - a.costUsd);
  const top = repoRows.slice(0, 8), rest = repoRows.slice(8);
  const maxRepo = top[0].costUsd;
  const restCost = rest.reduce((a, r) => a + r.costUsd, 0);
  const tierRows = [...AGG.byTier].sort((a, b) => b.costUsd - a.costUsd);
  const F = T.fallbacks;
  const cats = Object.entries(F.categories || {}).map(([k, v]) => k + ' × ' + v).join(', ') || 'none recorded';

  view.innerHTML =
    kpiHtml([
      { k: 'Total spend', n: usd(T.costUsd, 0), d: T.sessions + ' sessions · ' + T.folders + ' folders' + (state.aggDone ? '' : ' · scanning…'), hero: true, tour: 'total',
        tip: 'Cache-aware metered estimate from your own run logs — not a provider invoice',
        action: '<button class="btn-opt on-ink" type="button" data-opt-machine>⧉ Optimize my spend</button>' },
      { k: 'Last 7 days', n: usd(w7.cost, 0), d: plural(w7.sessions, 'session') },
      { k: 'Last 30 days', n: usd(w30.cost, 0), d: plural(w30.sessions, 'session') },
      { k: 'Tokens', n: tok(T.tokens.in) + ' · ' + tok(T.tokens.out), d: 'fresh input · output', tip: 'Fresh (uncached) input tokens and output tokens across all sessions' },
      { k: 'Cache reads', n: tok(T.tokens.cacheRd), d: tok(T.tokens.cacheWr) + ' cache writes', tip: 'Input context served from prompt cache — billed at roughly a tenth of fresh input' },
    ]) +
    '<div class="panel" data-tour="daily"><div class="panel-head"><span class="panel-title">Daily spend — last 30 days</span>' +
    '<span class="chart-legend">' + legendHtml() + '</span></div>' +
    '<div class="panel-body">' + dailyChartSvg() + '</div></div>' +
    '<div class="two-up">' +
      '<div class="panel" data-tour="tiers"><div class="panel-head"><span class="panel-title">Spend by model tier</span>' +
      '<span class="panel-meta">' + usd(T.costUsd, 0) + ' total</span></div><div class="panel-body">' +
      tierRows.map(r => '<div class="list-row"><span class="name"><i style="background:' + tc(r.tier) + '"></i>' + esc(r.tier) +
        ' <small>' + (r.costUsd / T.costUsd * 100).toFixed(1) + '% · ' + esc(TIER_MODEL[r.tier] || '') + '</small></span><span class="v">' + usd(r.costUsd, 0) + '</span></div>').join('') +
      '</div></div>' +
      '<div class="panel" data-tour="fallbacks"><div class="panel-head"><span class="panel-title">Fable fallbacks</span>' +
      '<span class="panel-meta"><button class="btn-opt" type="button" data-fb-analyze style="font-size:11px;padding:5px 11px">⧉ Analyze reasons</button>' +
      '<button class="btn-opt" type="button" data-fb-disable style="font-size:11px;padding:5px 11px">⧉ Disable auto-fallback</button>' +
      '<span>' + (F.switches + F.refusals) + ' events</span></span></div><div class="panel-body">' +
      '<div class="fb-grid">' + [
        { n: '<em>' + F.refusals + '</em>', l: 'refusals — Fable declined, harness moved on' },
        { n: '<em>' + F.switches + '</em>', l: 'switches away from Fable mid-session' },
        { n: F.mainTotal + ' · ' + F.subTotal, l: 'main chat · inside subagents' },
        { n: F.sessionsAffected, l: 'of ' + T.sessions + ' sessions affected' },
      ].map(x => '<div class="fb"><div class="n">' + x.n + '</div><div class="l">' + esc(x.l) + '</div></div>').join('') + '</div>' +
      '<div class="fb-foot">categories: ' + esc(cats) + ' · workflow agents involved: ' + F.wfAgents + '</div>' +
      '</div></div>' +
    '</div>' +
    '<div class="panel" data-tour="folders"><div class="panel-head"><span class="panel-title">Spend by folder</span>' +
    '<span class="panel-meta">' + repoRows.length + ' folders</span></div>' +
    top.map(r => folderRowHtml(r, maxRepo, false)).join('') +
    (rest.length ? '<a class="more-note" href="#/folders">+ ' + rest.length + ' more folders totalling ' + usd(restCost, 0) + ' — top 8 cover ' +
      (top.reduce((a, r) => a + r.costUsd, 0) / T.costUsd * 100).toFixed(0) + '% of all spend. <b>See all ' + AGG.byRepo.length + ' folders ›</b></a>' : '') +
    '</div>' +
    '<div class="panel" data-tour="recents"><div class="panel-head"><span class="panel-title">Sessions — all folders</span>' +
    '<span class="seg-mini" role="group"><button type="button" class="' + (homeSort === 'recent' ? 'on' : '') + '" data-sort="recent">Recent</button><button type="button" class="' + (homeSort === 'cost' ? 'on' : '') + '" data-sort="cost">Top cost</button></span></div>' +
    '<div id="home-sess-list">' + homeSessRows() + '</div>' +
    '</div>';
  const optBtn = view.querySelector('[data-opt-machine]');
  if (optBtn) optBtn.addEventListener('click', () => openModal('machine'));
  const fbA = view.querySelector('[data-fb-analyze]');
  if (fbA) fbA.addEventListener('click', () => openModal('fallback-analyze'));
  const fbD = view.querySelector('[data-fb-disable]');
  if (fbD) fbD.addEventListener('click', () => openModal('fallback-disable'));
  view.querySelectorAll('.seg-mini [data-sort]').forEach(b => b.addEventListener('click', () => {
    homeSort = b.dataset.sort;
    view.querySelectorAll('.seg-mini [data-sort]').forEach(x => x.classList.toggle('on', x === b));
    document.getElementById('home-sess-list').innerHTML = homeSessRows();
  }));
}
function homeSessRows() {
  const rows = homeSort === 'cost'
    ? [...ALL].sort((a, z) => (z.costUsd || 0) - (a.costUsd || 0)).slice(0, 8)
    : (HOME.recents || []).slice(0, 8).map(r => byId.get(r.id) || r);
  return rows.map(sessRowHtml).join('');
}

function renderFolder(repo) {
  const sess = ALL.filter(s => repoOfCwd(s.cwd) === repo).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  setCrumbs([{ label: '⌂ All folders', href: '#/' }, { label: 'Folders', href: '#/folders' }, { label: repo }]);
  const view = document.getElementById('view');
  if (!sess.length) { view.innerHTML = '<div class="panel"><div class="note-empty">No sessions found for “' + esc(repo) + '” in this snapshot.</div></div>'; return; }
  const cost = sess.reduce((a, s) => a + (s.costUsd || 0), 0);
  const worktrees = new Set(sess.map(s => s.cwd)).size;
  const fb = sess.reduce((a, s) => a + ((s.fallbacks?.switches || 0) + (s.fallbacks?.refusals || 0)), 0);
  const turns = sess.reduce((a, s) => a + (s.turns || 0), 0);

  // group by local day
  const groups = new Map();
  for (const s of sess) {
    const dt = new Date(s.startedAt);
    const d = (s.startedAt && dt.getFullYear() > 2000) ? dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Unknown date';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(s);
  }
  view.innerHTML =
    kpiHtml([
      { k: 'Folder spend', n: usd(cost, 0), d: repo, hero: true,
        action: '<button class="btn-opt on-ink" type="button" data-opt-folder>⧉ Optimize spend</button>' },
      { k: 'Sessions', n: String(sess.length), d: plural(turns, 'turn') + ' total' },
      { k: 'Worktrees', n: String(worktrees), d: 'distinct working dirs' },
      { k: 'Fallbacks', n: String(fb), d: 'refusals + switches' },
    ], 'four') +
    '<div class="panel" data-tour="folder-days"><div class="panel-head"><span class="panel-title">Sessions — by day</span>' +
    '<span class="panel-meta">' + plural(sess.length, 'session') + '</span></div>' +
    [...groups.entries()].map(([d, rows]) =>
      '<div class="day-head">' + esc(d) + ' · ' + usd(rows.reduce((a, s) => a + s.costUsd, 0)) + '</div>' + rows.map(sessRowHtml).join('')
    ).join('') +
    '</div>';
  const ob = view.querySelector('[data-opt-folder]');
  if (ob) ob.addEventListener('click', () => openModal('folder', repo));
}

function renderSession(id) {
  const s = byId.get(id);
  const view = document.getElementById('view');
  if (!s) { setCrumbs([{ label: '⌂ All folders', href: '#/' }, { label: 'Session' }]); view.innerHTML = '<div class="panel"><div class="note-empty">Session ' + esc(id) + ' isn\'t in this snapshot.</div></div>'; return; }
  const repo = repoOfCwd(s.cwd);
  const title = cleanTitle(s.title);
  setCrumbs([{ label: '⌂ All folders', href: '#/' }, { label: repo, href: '#/folder/' + encodeURIComponent(repo) }, { label: trunc(title, 44) }]);
  const sc = sessionScope(id, s);
  const forest = sc.forest;
  const fb = s.fallbacks || {};
  const fbN = (fb.switches || 0) + (fb.refusals || 0);

  const isPrompt = !/skill session$|^\(pasted image\)$/.test(title);
  let html =
    '<div class="panel" data-tour="session-head"><div class="sess-head" style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start">' +
    '<div>' + (isPrompt ? '<div class="panel-title" style="margin-bottom:8px">First prompt</div>' : '') +
    '<h1>' + (isPrompt ? '&ldquo;' + esc(trunc(title, 120)) + '&rdquo;' : esc(trunc(title, 120))) + (LIVE_IDS.has(id) ? '<span class="row-live">live</span>' : '') + '</h1>' +
    '<div class="meta"><span>' + esc(shortPath(s.cwd)) + '</span><span>⎇ ' + esc(s.gitBranch || '?') + '</span>' +
    '<span>' + fmtWhen(s.startedAt) + '</span><span>' + esc(s.model || s.tier) + '</span></div></div>' +
    '<button class="btn-opt" type="button" data-opt-session="' + esc(id) + '">⧉ Optimize spend</button></div></div>' +
    kpiHtml([
      { k: 'Session cost', n: usd(s.costUsd), d: s.tier + '-dominant', hero: true,
        tip: 'Cache-aware metered estimate for this session — not a provider invoice' },
      { k: 'Duration', n: fmtDur(s.ms), d: (s.turns || 0) + ' turns · ' + (s.toolCalls || 0) + ' tool calls' },
      { k: 'Tokens', n: tok(s.tokens?.in) + ' · ' + tok(s.tokens?.out), d: 'fresh input · output', tip: 'Fresh (uncached) input tokens and output tokens' },
      { k: 'Cache reads', n: tok(s.tokens?.cacheRd), d: tok(s.tokens?.cacheWr) + ' cache writes', tip: 'Input context served from prompt cache — roughly a tenth the price of fresh input' },
      { k: 'Launched', n: (s.workflows || 0) + ' · ' + (s.subagents || 0), d: 'workflows · subagents' },
    ]);

  if (fbN) {
    html += '<div class="panel"><div class="panel-head"><span class="panel-title">Fable fallbacks in this session</span>' +
      '<span class="panel-meta">' + fbN + ' events</span></div><div class="panel-body"><div class="fb-grid">' + [
        { n: '<em>' + (fb.refusals || 0) + '</em>', l: 'refusals' },
        { n: '<em>' + (fb.switches || 0) + '</em>', l: 'switches away from Fable' },
        { n: String(fb.stickyTurns || 0), l: 'turns stuck off Fable after a switch' },
        { n: String(s.subagents || 0), l: 'subagents in session' },
      ].map(x => '<div class="fb"><div class="n">' + x.n + '</div><div class="l">' + esc(x.l) + '</div></div>').join('') + '</div></div></div>';
  }

  const wf = sc.workflows;
  if (wf && wf.summaries && wf.summaries.length) {
    const totalWfCost = wf.summaries.reduce((a, r) => a + (r.costUsd || 0), 0);
    html += '<div class="panel" data-tour="workflows"><div class="panel-head"><span class="panel-title">Workflows launched</span>' +
      '<span class="panel-meta"><span class="chart-legend"><span class="cl"><i style="background:' + PAL().segInf + '"></i>inference</span><span class="cl"><i style="background:' + PAL().segTool + '"></i>tool</span></span>' +
      '<span>' + wf.summaries.length + ' runs · ' + usd(totalWfCost) + '</span></span></div>' +
      wf.summaries.map(r => {
        const d = wf.details && wf.details[r.runId]; // lazily filled on expand
        const head = '<summary>' +
          '<span class="wf-status' + (r.status === 'error' ? ' err' : '') + '" title="' + esc(r.status || 'done') + '"></span>' +
          '<span class="wname">' + esc(r.name || r.runId) + '</span>' +
          '<span class="m">' + (r.agentCount || 0) + ' agents</span>' +
          '<span class="m">' + tok(r.totalTokens || 0) + ' tok</span>' +
          '<span class="m">' + fmtDur(r.durationMs) + '</span>' +
          '<span class="cost">' + usd(r.costUsd) + '</span>' +
          '<span class="caret">' + (d ? '▶' : '') + '</span></summary>';
        if (!d) return '<details class="wf-run" data-run="' + esc(r.runId) + '">' + head + '<div class="wf-detail"><div class="wf-note">Expanding reconstructs this run\'s per-call timeline from its transcript…</div></div></details>';
        const R = d.run || {};
        const stats = '<div class="wf-stats">' +
          '<span class="wf-stat"><b>' + (R.calls || d.calls.length) + '</b> calls</span>' +
          '<span class="wf-stat">wall <b>' + fmtDur(R.wallMs) + '</b></span>' +
          '<span class="wf-stat">naive sum <b>' + fmtDur(R.sumMs) + '</b></span>' +
          (R.speedup ? '<span class="wf-stat">speedup <b>' + R.speedup.toFixed(2) + '×</b></span>' : '') +
          (R.concurrencySavingMs ? '<span class="wf-stat">saved <b>' + fmtDur(R.concurrencySavingMs) + '</b></span>' : '') +
          '</div>';
        return '<details class="wf-run">' + head + '<div class="wf-detail">' + stats + runGanttSvg(d) + '</div></details>';
      }).join('') + '</div>';
  }

  if (forest && forest.rollup && forest.root) {
    const nodes = flattenForest(forest.root);
    const withTime = nodes.filter(n => n.startedAtMs && n.ms);
    // plain-language insight: biggest single cost, honest arithmetic
    const biggest = [...nodes].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0];
    if (biggest && biggest.costUsd && s.costUsd) {
      html += '<div class="insight-line">Biggest single cost: <b>' + esc(trunc(String(biggest.description || biggest.agentType || 'subagent'), 60)) + '</b>' +
        ' (' + esc(biggest.tier || '?') + ') — <b>' + usd(biggest.costUsd) + '</b> of the session\'s ' + usd(s.costUsd) +
        ' (' + (biggest.costUsd / s.costUsd * 100).toFixed(0) + '%).</div>';
    }
    if (withTime.length) {
      const tiersPresent = [...new Set([forest.root.tier, ...nodes.map(n => n.tier)].filter(Boolean))].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
      // span shown = exactly what the chart draws (main + timed subagents), so header and axis agree
      const spanRows = (forest.root.startedAtMs && forest.root.ms ? [forest.root] : []).concat(withTime);
      const chartSpan = Math.max(...spanRows.map(n => n.startedAtMs + n.ms)) - Math.min(...spanRows.map(n => n.startedAtMs));
      html += '<div class="panel" data-tour="waterfall"><div class="panel-head"><span class="panel-title">Session waterfall — main + subagents</span>' +
        '<span class="panel-meta"><span class="chart-legend">' + tierLegendHtml(tiersPresent) + '</span><span>span ' + fmtDur(chartSpan) + '</span></span></div>' +
        '<div class="panel-body">' + waterfallSvg(forest.root, withTime) + '</div></div>';
    }
    html += '<div class="panel" data-tour="subagents"><div class="panel-head"><span class="panel-title">Subagents — by cost</span>' +
      '<span class="panel-meta">' + forest.rollup.totalSubagents + ' agents · ' + usd(forest.rollup.totalCostUsd) + '</span></div>' +
      nodes.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).map(n =>
        '<div class="sub-row"><span class="dot" style="background:' + tc(n.tier) + ';width:9px;height:9px;border-radius:3px"></span>' +
        '<span class="t">' + esc(trunc(String(n.description || n.agentType || n.agentId), 76)) +
        '<small>' + esc(n.agentType || '') + (n.orphan ? ' · orphan' : '') + '</small></span>' +
        '<span class="m">' + (n.turns || 0) + ' turns</span><span class="m">' + (n.toolCalls || 0) + ' tools</span>' +
        '<span class="m">' + fmtDur(n.ms) + '</span><span class="cost">' + usd(n.costUsd) + '</span></div>').join('') +
      '</div>';
  } else if (sc.status === 'pending' && ((s.subagents || 0) > 0 || (s.workflows || 0) > 0)) {
    html += '<div class="panel"><div class="panel-head"><span class="panel-title">Subagents & workflows</span></div>' +
      '<div class="panel-body">' + bootPanel('Reconstructing subagents and workflows from transcripts…') + '</div></div>';
  } else if ((s.subagents || 0) > 0 || (s.workflows || 0) > 0) {
    html += '<div class="panel"><div class="panel-head"><span class="panel-title">Subagents & workflows</span></div>' +
      '<div class="note-empty">This session launched ' + (s.workflows || 0) + ' workflow(s) and ' + (s.subagents || 0) +
      ' subagent(s), but nothing reconstructable was found in its session directory — the transcripts may have been cleaned up.</div></div>';
  }

  view.innerHTML = html;
  const btn = view.querySelector('[data-opt-session]');
  if (btn) btn.addEventListener('click', () => openModal('session', id));
  // lazy per-run detail: first expand fetches + renders the gantt
  view.querySelectorAll('details.wf-run[data-run]').forEach(el => el.addEventListener('toggle', async () => {
    if (!el.open || el.dataset.loaded) return;
    el.dataset.loaded = '1';
    const runId = el.dataset.run;
    try {
      const d = await api('/v1/session-scope/observed/' + encodeURIComponent(runId) + '?slug=' + encodeURIComponent(s.projectSlug) + '&id=' + id);
      if (WORKFLOWS[id]) WORKFLOWS[id].details[runId] = d;
      const R = d.run || {};
      el.querySelector('.wf-detail').innerHTML = '<div class="wf-stats">' +
        '<span class="wf-stat"><b>' + (R.calls || (d.calls || []).length) + '</b> calls</span>' +
        '<span class="wf-stat">wall <b>' + fmtDur(R.wallMs) + '</b></span>' +
        '<span class="wf-stat">naive sum <b>' + fmtDur(R.sumMs) + '</b></span>' +
        (R.speedup ? '<span class="wf-stat">speedup <b>' + R.speedup.toFixed(2) + '×</b></span>' : '') +
        (R.concurrencySavingMs ? '<span class="wf-stat">saved <b>' + fmtDur(R.concurrencySavingMs) + '</b></span>' : '') +
        '</div>' + runGanttSvg(d);
    } catch (e) {
      el.querySelector('.wf-detail').innerHTML = '<div class="wf-note">Could not reconstruct this run: ' + esc(String(e.message || e)) + '</div>';
    }
  }));
}

function sessionScope(id, s) {
  if (id in FORESTS || id in WORKFLOWS) return { status: 'ready', forest: FORESTS[id] || null, workflows: WORKFLOWS[id] || null };
  if (!state.scopePending.has(id)) {
    state.scopePending.add(id);
    const q = 'slug=' + encodeURIComponent(s.projectSlug || '') + '&id=' + encodeURIComponent(id);
    Promise.all([
      api('/v1/session-scope/subagents?' + q).catch(() => null),
      api('/v1/session-scope/observed?' + q).catch(() => []),
    ]).then(([forest, runs]) => {
      FORESTS[id] = forest && forest.rollup && forest.root ? forest : null;
      WORKFLOWS[id] = runs && runs.length ? { summaries: [...runs].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)), details: {} } : null;
      state.scopePending.delete(id);
      if (location.hash.startsWith('#/session/' + id)) route();
    });
  }
  return { status: 'pending', forest: null, workflows: null };
}

function flattenForest(root) {
  const out = [];
  const walk = n => { for (const c of n.children || []) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

function waterfallSvg(root, nodes) {
  const rows = [];
  if (root.startedAtMs && root.ms) rows.push({ label: 'main conversation', tier: root.tier, t0: root.startedAtMs, ms: root.ms, cost: root.costUsd, main: true });
  for (const n of nodes) rows.push({ label: String(n.description || n.agentType || n.agentId), tier: n.tier, t0: n.startedAtMs, ms: n.ms, cost: n.costUsd });
  rows.sort((a, b) => a.t0 - b.t0);
  const min = Math.min(...rows.map(r => r.t0));
  const max = Math.max(...rows.map(r => r.t0 + r.ms));
  const span = Math.max(max - min, 1);
  const W = 1140, labelW = 250, valW = 76, rowH = 30, padT = 26, padB = 8;
  const H = padT + rows.length * rowH + padB;
  const x = t => labelW + ((t - min) / span) * (W - labelW - valW - 12);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img" aria-label="Session waterfall">';
  for (let g = 0; g <= 4; g++) {
    const gx = labelW + (W - labelW - valW - 12) * g / 4;
    s += '<line x1="' + gx + '" y1="' + padT + '" x2="' + gx + '" y2="' + (H - padB) + '" stroke="' + PAL().gridSoft + '" stroke-width="1"/>';
    s += '<text x="' + gx + '" y="' + 14 + '" text-anchor="' + (g === 0 ? 'start' : 'middle') + '" font-size="10" fill="' + PAL().axis + '">+' + fmtDur(span * g / 4) + '</text>';
  }
  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const bx = x(r.t0), bw = Math.max(x(r.t0 + r.ms) - bx, 3);
    const tip = '<div class="t-head">' + (r.main ? 'Main conversation' : esc(trunc(r.label, 60))) + '</div>' +
      '<div class="t-row"><span class="l"><i style="background:' + tc(r.tier) + '"></i>' + esc(r.tier || '?') + '</span><span class="v">' + usd(r.cost) + '</span></div>' +
      '<div class="t-row"><span class="l">ran for</span><span class="v">' + fmtDur(r.ms) + '</span></div>' +
      '<div class="t-row"><span class="l">started at</span><span class="v">+' + fmtDur(r.t0 - min) + '</span></div>';
    s += '<g class="wf-row" data-tip="' + esc(tip) + '">';
    s += '<rect x="0" y="' + y + '" width="' + W + '" height="' + rowH + '" fill="transparent"/>';
    s += '<text x="0" y="' + (y + 17) + '" font-size="11" fill="' + (r.main ? PAL().ink : PAL().subtle) + '"' + (r.main ? ' font-weight="600"' : '') + '>' +
      esc(trunc(r.label, 34)) + '</text>';
    s += '<rect class="wbar" x="' + bx + '" y="' + (y + 7) + '" width="' + bw + '" height="14" rx="4" fill="' + tc(r.tier) + '"' + (r.main ? ' opacity="0.25"' : '') + '/>';
    s += '<text x="' + W + '" y="' + (y + 17) + '" text-anchor="end" font-size="11" fill="' + PAL().subtle + '">' + usd(r.cost) + '</text>';
    s += '</g>';
  });
  return s + '</svg>';
}
function folderRowHtml(r, max, showActive) {
  const segs = TIER_ORDER.filter(t => r.tiers[t])
    .map(t => '<span style="width:' + (r.tiers[t] / max * 100) + '%;background:' + tc(t) + '"></span>').join('');
  const last = REPO_LAST.get(r.repo);
  return '<a class="folder-row" href="#/folder/' + encodeURIComponent(r.repo) + '">' +
    '<span class="n">' + esc(r.repo) + '<small>' + plural(r.sessions, 'session') +
    (r.fallbacks ? ' · ' + plural(r.fallbacks, 'fallback') : '') +
    (showActive && last ? ' · active ' + fmtWhen(last).split(',')[0] : '') + '</small></span>' +
    '<span class="track">' + segs + '</span>' +
    '<span class="v">' + usd(r.costUsd, 0) + '<small>' + usd(r.costUsd / r.sessions) + ' per session</small></span><span class="chev">›</span></a>';
}
const foldersState = { sort: 'spend', q: '' };
function renderFolders() {
  setCrumbs([{ label: '⌂ All folders', href: '#/' }, { label: 'Spend by folder' }]);
  const view = document.getElementById('view');
  if (!AGG || !AGG.byRepo || !AGG.byRepo.length) { view.innerHTML = bootPanel('Scanning your sessions…'); return; }
  const SORTS = [['spend', 'Spend'], ['sessions', 'Sessions'], ['persession', '$/session'], ['recent', 'Recent'], ['fallbacks', 'Fallbacks']];
  view.innerHTML =
    '<div class="panel"><div class="panel-head"><span class="panel-title">Spend by folder — all folders</span>' +
    '<span class="panel-meta"><input class="filter-input" id="folder-q" type="search" placeholder="Filter folders…" value="' + esc(foldersState.q) + '" aria-label="Filter folders"/>' +
    '<span class="seg-mini" role="group">' + SORTS.map(([k, l]) =>
      '<button type="button" data-fsort="' + k + '" class="' + (foldersState.sort === k ? 'on' : '') + '">' + l + '</button>').join('') + '</span></span></div>' +
    '<div id="folders-list"></div>' +
    '<div class="more-note" id="folders-note"></div></div>';
  const relist = () => {
    let rows = [...AGG.byRepo];
    const q = foldersState.q.trim().toLowerCase();
    if (q) rows = rows.filter(r => r.repo.toLowerCase().includes(q));
    const keyFn = {
      spend: r => r.costUsd, sessions: r => r.sessions,
      persession: r => r.costUsd / Math.max(r.sessions, 1),
      fallbacks: r => r.fallbacks || 0, recent: r => REPO_LAST.get(r.repo) || '',
    }[foldersState.sort];
    rows.sort((a, b) => keyFn(b) > keyFn(a) ? 1 : keyFn(b) < keyFn(a) ? -1 : 0);
    const max = Math.max(...rows.map(r => r.costUsd), 0.01);
    document.getElementById('folders-list').innerHTML =
      rows.map(r => folderRowHtml(r, max, true)).join('') ||
      '<div class="note-empty">No folders match “' + esc(foldersState.q) + '”.</div>';
    document.getElementById('folders-note').textContent =
      rows.length + ' of ' + AGG.byRepo.length + ' folders · ' + usd(rows.reduce((a, r) => a + r.costUsd, 0), 0) + ' shown';
  };
  relist();
  document.getElementById('folder-q').addEventListener('input', e => { foldersState.q = e.target.value; relist(); });
  view.querySelectorAll('[data-fsort]').forEach(b => b.addEventListener('click', () => {
    foldersState.sort = b.dataset.fsort;
    view.querySelectorAll('[data-fsort]').forEach(x => x.classList.toggle('on', x === b));
    relist();
  }));
}
function tierLegendHtml(tiers) {
  return tiers.map(t => '<span class="cl"><i style="background:' + tc(t) + '"></i>' + esc(t) + '</span>').join('');
}

// per-run gantt: one row per agent call, bars split into inference/tool segments
function runGanttSvg(d) {
  const calls = (d.calls || []).filter(c => c.segments && c.segments.length);
  if (!calls.length) return '<div class="wf-note">No per-call timing recorded for this run.</div>';
  const shown = calls.slice(0, 14);
  const min = Math.min(...shown.map(c => c.segments[0].startMs));
  const max = Math.max(...shown.map(c => c.segments[c.segments.length - 1].endMs));
  const span = Math.max(max - min, 1);
  const W = 1080, labelW = 230, valW = 74, rowH = 28, padT = 24, padB = 6;
  const H = padT + shown.length * rowH + padB;
  const x = t => labelW + ((t - min) / span) * (W - labelW - valW - 12);
  const SEG = { inference: PAL().segInf, tool: PAL().segTool };
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" role="img" aria-label="Workflow run timeline">';
  for (let g = 0; g <= 4; g++) {
    const gx = labelW + (W - labelW - valW - 12) * g / 4;
    s += '<line x1="' + gx + '" y1="' + padT + '" x2="' + gx + '" y2="' + (H - padB) + '" stroke="' + PAL().grid + '" stroke-width="1"/>';
    s += '<text x="' + gx + '" y="13" text-anchor="' + (g === 0 ? 'start' : 'middle') + '" font-size="10" fill="' + PAL().axis + '">+' + fmtDur(span * g / 4) + '</text>';
  }
  shown.forEach((c, i) => {
    const y = padT + i * rowH;
    const tip = '<div class="t-head">' + esc(trunc(String(c.label || 'agent ' + c.id), 60)) + '</div>' +
      '<div class="t-row"><span class="l"><i style="background:' + tc(c.tier) + '"></i>' + esc(c.tier || '?') + '</span><span class="v">' + usd(c.costUsd) + '</span></div>' +
      '<div class="t-row"><span class="l">total</span><span class="v">' + fmtDur(c.ms) + '</span></div>' +
      (c.inferenceMs != null ? '<div class="t-row"><span class="l"><i style="background:#171717"></i>inference</span><span class="v">' + fmtDur(c.inferenceMs) + '</span></div>' : '') +
      (c.toolMs != null ? '<div class="t-row"><span class="l"><i style="background:#b5b5b5"></i>tools' + (c.toolCalls ? ' × ' + c.toolCalls : '') + '</span><span class="v">' + fmtDur(c.toolMs) + '</span></div>' : '') +
      '<div class="t-row"><span class="l">tokens</span><span class="v">' + tok(c.inTok || 0) + ' · ' + tok(c.outTok || 0) + '</span></div>';
    s += '<g class="wf-row" data-tip="' + esc(tip) + '">';
    s += '<rect x="0" y="' + y + '" width="' + W + '" height="' + rowH + '" fill="transparent"/>';
    s += '<circle cx="6" cy="' + (y + 14) + '" r="4" fill="' + tc(c.tier) + '"/>';
    s += '<text x="18" y="' + (y + 18) + '" font-size="11" fill="' + PAL().subtle + '">' + esc(trunc(String(c.label || 'agent ' + c.id), 28)) + '</text>';
    for (const g of c.segments) {
      const bx = x(g.startMs), bw2 = Math.max(x(g.endMs) - bx, 2);
      s += '<rect class="wbar" x="' + bx + '" y="' + (y + 8) + '" width="' + bw2 + '" height="12" rx="3" fill="' + (SEG[g.kind] || '#8f8f8f') + '"/>';
    }
    s += '<text x="' + W + '" y="' + (y + 18) + '" text-anchor="end" font-size="11" fill="' + PAL().subtle + '">' + usd(c.costUsd) + '</text>';
    s += '</g>';
  });
  s += '</svg>';
  if (calls.length > shown.length) s += '<div class="wf-note">+ ' + (calls.length - shown.length) + ' more calls not shown</div>';
  return s;
}

// ── optimize prompts (mirrors app.js buildOptimizePrompt) ─────────
function optimizeFooter() {
  return '\n## How to work\n'
    + '1. Ground every conclusion in the numbers above (or fetch more via the live API below).\n'
    + '2. Identify the 3-5 biggest cost levers you can actually change (model tier per task type, delegation to cheaper subagents, workflow model mix, prompt/cache stability, avoiding re-reading the same files).\n'
    + '3. Propose concrete changes with expected impact, clearly labeled as estimates.\n'
    + '4. Then OFFER (ask first) to write a personalized cost-discipline skill to ~/.claude/skills/cost-discipline/SKILL.md capturing the durable rules you found — rules grounded in MY observed usage, not generic advice.\n'
    + '\n## Live data API (while the Caliper dashboard is running)\n'
    + '- ' + location.origin + '/v1/aggregate — machine-wide totals, by-day/by-repo/by-tier\n'
    + '- ' + location.origin + '/v1/sessions/all — every session with costs\n'
    + '- ' + location.origin + '/v1/observed and /v1/observed/:id — workflow runs with per-call telemetry\n'
    + 'If the API is unreachable, use the snapshot above — it is sufficient.\n'
    + '\n## Honesty requirements\n'
    + '- All dollar figures are cache-aware ESTIMATES reconstructed from transcripts, not billed amounts. Say so when you cite them.\n'
    + '- Note sample sizes; do not overfit rules to a single session.\n'
    + '- Cheaper models may need more attempts — present savings as token-economics ceilings, not promises.\n';
}
function buildPrompt(scope, id) {
  if (scope === 'fallback-analyze') {
    const F = T.fallbacks;
    const affected = ALL.filter(x => x.fallbacks && ((x.fallbacks.switches || 0) + (x.fallbacks.refusals || 0)) > 0)
      .sort((a, b) => ((b.fallbacks.switches || 0) + (b.fallbacks.refusals || 0)) - ((a.fallbacks.switches || 0) + (a.fallbacks.refusals || 0)))
      .slice(0, 10)
      .map(x => '- ' + x.id + ' (' + shortPath(x.cwd) + ', ' + fmtWhen(x.startedAt) + '): ' +
        (x.fallbacks.refusals || 0) + ' refusals, ' + (x.fallbacks.switches || 0) + ' switches — first prompt: "' + cleanTitle(x.title).slice(0, 70) + '"').join('\n');
    return '# Analyze my Fable fallback events — find the real reasons\n\n'
      + 'You are Claude Code on my machine. Caliper (caliper.run, snapshot ' + snapshotLabel() + ') found ' + (F.switches + F.refusals)
      + ' Fable fallback events: ' + F.refusals + ' refusals and ' + F.switches + ' mid-session switches away from claude-fable-5, across '
      + F.sessionsAffected + ' sessions (' + F.mainTotal + ' events in main chats, ' + F.subTotal + ' inside subagents, ' + F.wfAgents + ' workflow agents involved).\n'
      + 'The API stop_details category was "unspecified" for every refusal, so the dashboard cannot show WHY — reconstruct the reasons from my transcripts.\n\n'
      + '## Affected sessions (top ' + Math.min(10, F.sessionsAffected) + ' by event count)\n' + affected + '\n\n'
      + '## What to do\n'
      + '1. For each affected session, read ~/.claude/projects/<slug>/<session-id>.jsonl and its <session-id>/subagents/*.jsonl. Locate the fallback turns: assistant messages whose model changes from claude-fable-5 to another model between consecutive turns, and refusal stop markers (stop_reason/stop_details).\n'
      + '2. For each event, quote (~200 chars) the user/tool content immediately preceding it, and classify the likely trigger — e.g. security/dual-use content in context, credentials or secrets pasted, exploit-adjacent code, or a false positive.\n'
      + '3. Summarize: the common triggers, which are avoidable (rephrasing, splitting tasks, keeping certain files out of context), and which agents/workflows trip them most.\n\n'
      + '## Honesty requirements\n'
      + '- Quote real transcript text only; never invent a reason. If a trigger is unclear, say unclear.\n'
      + '- These are ' + (F.switches + F.refusals) + ' events across ' + F.sessionsAffected + ' sessions — note sample size before calling anything a pattern.\n';
  }
  if (scope === 'fallback-disable') {
    const F = T.fallbacks;
    return '# Stop Claude Code from auto-switching off Fable\n\n'
      + 'You are Claude Code on my machine — inspect and, with my approval, change YOUR OWN fallback configuration.\n'
      + 'Context (Caliper snapshot ' + snapshotLabel() + '): ' + F.switches + ' automatic switches away from claude-fable-5 and ' + F.refusals + ' refusals across ' + F.sessionsAffected + ' of my sessions.\n\n'
      + '## What the docs say\n'
      + '- Claude Code has a `fallbackModel` setting (changelog v2.1.166): up to three fallback models tried in order when the primary model is overloaded or unavailable; `--fallback-model` also applies to interactive sessions.\n'
      + '- IMPORTANT: refusal-triggered switches (Fable safety classifier declining) may NOT be governed by the same setting as availability fallbacks. Verify against the current docs before changing anything, and tell me plainly if this behavior cannot be disabled.\n\n'
      + '## What to do\n'
      + '1. Show my current model + fallback config: `model` and `fallbackModel` in ~/.claude/settings.json and any project settings, plus relevant env vars (ANTHROPIC_MODEL, FALLBACK_FOR_ALL_PRIMARY_MODELS) and shell aliases passing --fallback-model.\n'
      + '2. Explain what each does, then propose the minimal change to stop automatic switching away from Fable — and spell out the tradeoff (refusals/unavailability will surface as visible errors instead of silent switches).\n'
      + '3. ASK before writing any settings change.\n';
  }
  if (scope === 'folder') {
    const repo = id;
    const sess = ALL.filter(x => repoOfCwd(x.cwd) === repo);
    const cost = sess.reduce((a, x) => a + (x.costUsd || 0), 0);
    const turns = sess.reduce((a, x) => a + (x.turns || 0), 0);
    const fb = sess.reduce((a, x) => a + ((x.fallbacks?.switches || 0) + (x.fallbacks?.refusals || 0)), 0);
    const agg = AGG.byRepo.find(r => r.repo === repo);
    const tiers = agg ? TIER_ORDER.filter(t => agg.tiers[t]).map(t => '- ' + t + ' (' + (TIER_MODEL[t] || '') + '): ' + usd(agg.tiers[t], 0)).join('\n') : '(tier split unavailable)';
    const top = [...sess].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10)
      .map(x => '- ' + usd(x.costUsd) + ' · ' + (x.turns || 0) + ' turns · ' + fmtWhen(x.startedAt) + ' · "' + cleanTitle(x.title).slice(0, 60) + '"'
        + ' · ' + (x.workflows || 0) + ' wf · ' + (x.subagents || 0) + ' sub · ' + (x.model || x.tier) + ' · id ' + x.id).join('\n');
    const byTitle = new Map();
    for (const x of sess) { const t = cleanTitle(x.title); const e = byTitle.get(t) || { n: 0, cost: 0 }; e.n++; e.cost += x.costUsd || 0; byTitle.set(t, e); }
    const repeats = [...byTitle.entries()].filter(([, e]) => e.n > 1).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5)
      .map(([t, e]) => '- "' + t.slice(0, 60) + '" × ' + e.n + ' — ' + usd(e.cost, 0) + ' total, ' + usd(e.cost / e.n) + ' avg').join('\n');
    return '# Make this folder cheaper: ' + repo + '\n\n'
      + 'You are Claude Code. Below is my real usage for one folder, reconstructed from ~/.claude/projects transcripts by Caliper (caliper.run, snapshot ' + snapshotLabel() + '). '
      + 'Analyze where this spend could have been cheaper, and what to do differently going forward.\n\n'
      + '## Folder\n'
      + '- ' + repo + ': ' + usd(cost, 0) + ' across ' + plural(sess.length, 'session') + ' · ' + turns.toLocaleString() + ' turns · ' + new Set(sess.map(x => x.cwd)).size + ' worktrees'
      + (fb ? ' · ' + fb + ' Fable fallback events' : '') + '\n'
      + '\n### Spend by model tier\n' + tiers + '\n'
      + '\n### Top 10 sessions by cost\n' + top + '\n'
      + (repeats ? '\n### Repeated activities (same first prompt, multiple runs)\n' + repeats + '\n' : '')
      + '\n## Specific asks\n'
      + '1. Where was the money? Read the top sessions\' transcripts (~/.claude/projects/<slug>/<id>.jsonl) and attribute cost to activities: exploration vs implementation vs review vs repeated re-reading of the same files.\n'
      + '2. Where could it have been cheaper? Model tier vs task type (mechanical work on opus?), repeated activities with high cost variance (compare the cheap runs of the same activity to the expensive ones — what did the expensive ones do differently?), cache behavior, and oversized context.\n'
      + '3. Going forward: concrete, folder-specific rules — which task types to route to cheaper models/subagents, what to keep out of context, whether recurring workflows deserve a fixed workflow script instead of ad-hoc sessions.\n'
      + optimizeFooter();
  }
  if (scope === 'machine') {
    const tiers = [...AGG.byTier].sort((a, b) => b.costUsd - a.costUsd).map(x => '- ' + x.tier + ': ' + usd(x.costUsd, 0)).join('\n');
    const repos = [...AGG.byRepo].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8).map(r => '- ' + r.repo + ': ' + usd(r.costUsd, 0) + ' across ' + r.sessions + ' sessions').join('\n');
    const cacheRatio = T.tokens.in > 0 ? Math.round(T.tokens.cacheRd / (T.tokens.cacheRd + T.tokens.in) * 100) : 0;
    return '# Optimize my Claude Code spend (machine-wide)\n\n'
      + 'You are Claude Code running on my machine. Below is my real usage, reconstructed from ~/.claude/projects transcripts by the Caliper dashboard (caliper.run) (snapshot ' + snapshotLabel() + ').\n\n'
      + '## Snapshot — all folders, all time\n'
      + '- Total estimated spend: ' + usd(T.costUsd, 0) + ' across ' + T.sessions + ' sessions in ' + T.folders + ' folders (complete scan).\n'
      + '- Tokens: ' + tok(T.tokens.out) + ' output · ' + tok(T.tokens.in) + ' fresh input · ' + tok(T.tokens.cacheRd) + ' cache reads (' + cacheRatio + '% of input context came from cache) · ' + tok(T.tokens.cacheWr) + ' cache writes.\n'
      + '- Fable fallbacks: ' + T.fallbacks.refusals + ' refusals, ' + T.fallbacks.switches + ' switches across ' + T.fallbacks.sessionsAffected + ' sessions.\n'
      + '\n### Spend by model tier\n' + tiers + '\n\n### Top repos by spend\n' + repos + '\n'
      + optimizeFooter();
  }
  const s = byId.get(id);
  if (!s) return '';
  const f = FORESTS[id];
  const subLines = f && f.root ? flattenForest(f.root).sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10)
    .map(n => '- ' + (n.description || n.agentType || n.agentId) + ' (' + (n.tier || '?') + '): ' + usd(n.costUsd) + ' · ' + fmtDur(n.ms) + ' · ' + (n.turns || 0) + ' turns').join('\n') : null;
  return '# Make sessions like this one cheaper and more effective\n\n'
    + 'You are Claude Code. Analyze this real session of mine (Caliper snapshot ' + snapshotLabel() + ') and tell me how to run sessions like it better.\n\n'
    + '## Session\n'
    + '- Title (first prompt): ' + cleanTitle(s.title) + '\n'
    + '- Session id: ' + s.id + '\n'
    + '- Folder: ' + s.cwd + ' (branch ' + (s.gitBranch || '?') + ')\n'
    + '- Total estimated cost: ' + usd(s.costUsd) + ' · ' + (s.turns || 0) + ' turns · ' + fmtDur(s.ms) + '\n'
    + '- Tokens: ' + tok(s.tokens?.out) + ' output · ' + tok(s.tokens?.in) + ' fresh input · ' + tok(s.tokens?.cacheRd) + ' cache reads\n'
    + '- Dominant model: ' + (s.model || s.tier) + ' · launched ' + (s.workflows || 0) + ' workflows and ' + (s.subagents || 0) + ' subagents\n'
    + (s.fallbacks && (s.fallbacks.refusals || s.fallbacks.switches) ? '- Fable fallbacks: ' + (s.fallbacks.refusals || 0) + ' refusals, ' + (s.fallbacks.switches || 0) + ' switches\n' : '')
    + (subLines ? '\n### Top subagents by cost\n' + subLines + '\n' : '')
    + optimizeFooter();
}

// ── modal ─────────────────────────────────────────────────────────
function openModal(scope, id) {
  const mount = document.getElementById('modal-mount');
  const text = buildPrompt(scope, id);
  const title = scope === 'machine' ? 'Optimize my spend — machine-wide prompt'
    : scope === 'folder' ? 'Optimize spend — this folder'
    : scope === 'fallback-analyze' ? 'Analyze Fable fallback reasons — prompt'
    : scope === 'fallback-disable' ? 'Disable auto-fallback — prompt'
    : 'Optimize spend — this session';
  mount.innerHTML = '<div class="modal-scrim"><div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="modal-head"><span class="modal-title">' + esc(title) + '</span>' +
    '<button class="modal-close" type="button" aria-label="Close">✕</button></div>' +
    '<div class="modal-body"><textarea readonly spellcheck="false">' + esc(text) + '</textarea></div>' +
    '<div class="modal-foot"><span class="hint">Paste this into a Claude Code session — it analyzes your real usage and proposes concrete savings.</span>' +
    '<button class="btn-opt primary" type="button" id="btn-copy">⧉ Copy prompt</button></div></div></div>';
  const close = () => { mount.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  mount.querySelector('.modal-scrim').addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
  mount.querySelector('.modal-close').addEventListener('click', close);
  mount.querySelector('#btn-copy').addEventListener('click', async () => {
    const btn = mount.querySelector('#btn-copy');
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      try { mount.querySelector('textarea').select(); ok = document.execCommand('copy'); } catch { ok = false; }
    }
    btn.textContent = ok ? '✓ Copied' : 'Copy failed — text selected, press ⌘C';
    if (!ok) mount.querySelector('textarea').select();
    setTimeout(() => { btn.textContent = '⧉ Copy prompt'; }, ok ? 1600 : 3200);
  });
  mount.querySelector('#btn-copy').focus();
}

// ── tutorial tour ─────────────────────────────────────────────────
// Targets are chosen from the user's own data at tour start.
let TOUR_FOLDER = '#/';
let TOUR_SESSION = '#/';
let TOUR_STEPS = [];
function buildTourSteps() {
  const repoRows = AGG ? [...AGG.byRepo].sort((a, b) => b.costUsd - a.costUsd) : [];
  const topRepo = repoRows.length ? repoRows[0].repo : null;
  const cand = [...ALL].filter(x => (x.subagents || 0) > 0).sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0]
    || [...ALL].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0];
  TOUR_FOLDER = topRepo ? '#/folder/' + encodeURIComponent(topRepo) : '#/';
  TOUR_SESSION = cand ? '#/session/' + cand.id : '#/';
  if (cand) sessionScope(cand.id, cand); // prefetch drill-down so tour panels exist
  TOUR_STEPS = TOUR_TEMPLATE.filter(st => {
    if (st.needs === 'folder') return !!topRepo;
    if (st.needs === 'session') return !!cand;
    if (st.needs === 'workflows') return !!(cand && (cand.workflows || 0) > 0);
    if (st.needs === 'subagents') return !!(cand && (cand.subagents || 0) > 0);
    return true;
  }).map(st => ({ ...st, hash: st.at === 'folder' ? TOUR_FOLDER : st.at === 'session' ? TOUR_SESSION : '#/',
    body: typeof st.body === 'function' ? st.body(cand) : st.body }));
}
const TOUR_TEMPLATE = [
  { at: 'home', sel: '[data-tour="total"]', title: 'Your total spend, from your own logs',
    body: 'Caliper reconstructs every session on this machine from the Claude Code transcripts in ~/.claude/projects — token by token, cache-aware. No billing API, nothing leaves your machine. "Optimize my spend" turns this data into a prompt you can hand back to Claude Code.' },
  { at: 'home', sel: '[data-tour="daily"]', title: 'Where the days went',
    body: 'Each bar is one day, stacked by model tier — black is Opus, blue is Fable, grays are Sonnet and Haiku. A red dot above a bar marks a nerfed day — Fable refused a request or the harness switched models.' },
  { at: 'home', sel: '[data-tour="tiers"]', title: 'The model mix',
    body: 'Spend split by model tier across everything. If most of your money is going to frontier tiers for mechanical work, this is the first place it shows.' },
  { at: 'home', sel: '[data-tour="fallbacks"]', title: 'When Fable stepped back',
    body: 'Fable 5 sometimes declines a request and the harness falls back to Opus. Caliper counts every refusal and switch — in your main chat and inside subagents — so you know how often it happens and where.' },
  { at: 'home', sel: '[data-tour="folders"]', title: 'Spend by folder',
    body: 'Every repo and worktree Claude Code has touched, ranked by cost. The bar shows each folder\'s model mix. Click any row to drill into that folder — let\'s do that now.' },
  { at: 'folder', needs: 'folder', sel: '[data-tour="folder-days"]', title: 'A folder, day by day',
    body: 'Inside a folder: every session grouped by day, with day subtotals. The breadcrumb up top always shows where you are — click any level to jump back.' },
  { at: 'session', needs: 'session', sel: '[data-tour="session-head"]', title: 'One session, fully reconstructed',
    body: (cand) => 'This is a real ' + usd(cand && cand.costUsd) + ' session of yours. Title, branch, model, and the full cost anatomy below. "Optimize spend" here builds a prompt about THIS session specifically.' },
  { at: 'session', needs: 'workflows', sel: '[data-tour="workflows"]', title: 'Workflows, reconstructed',
    body: 'Every workflow this session launched, with real cost and timing. Expand a run to see each agent call on a timeline — dark segments are model inference, gray segments are tool calls.' },
  { at: 'session', needs: 'subagents', sel: '[data-tour="waterfall"]', title: 'The session waterfall',
    body: 'The main conversation and every subagent it spawned, positioned on the real time axis. Long quiet stretches and bursts of parallel agents become obvious at a glance.' },
  { at: 'session', needs: 'subagents', sel: '[data-tour="subagents"]', title: 'Subagents, ranked by cost',
    body: 'Each subagent with its task, turns, tool calls, duration, and cost. This is usually where surprise spend hides — one expensive delegate inside an innocent-looking session.' },
  { at: 'session', needs: 'session', sel: '[data-opt-session]', title: 'Close the loop',
    body: 'That\'s the whole flow: see where money goes, drill to why, then hand Claude Code a grounded optimization prompt. Everything you saw is a metered estimate from your own logs — never a bill.' },
];
let tourI = -1, tourNodes = null, tourReposition = null;
function tourEnd() {
  tourI = -1;
  if (tourNodes) { tourNodes.ring.remove(); tourNodes.card.remove(); tourNodes = null; }
  if (tourReposition) { window.removeEventListener('resize', tourReposition); window.removeEventListener('scroll', tourReposition, true); tourReposition = null; }
  document.removeEventListener('keydown', tourKeys);
  try { localStorage.setItem('caliper-tour-done', '1'); } catch {}
}
function tourKeys(e) {
  // NOTE: Enter is deliberately NOT handled here — the focused Next button already
  // activates on Enter natively; handling it too double-fires and skips a step.
  if (e.key === 'Escape') { e.preventDefault(); tourEnd(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); tourGo(tourI + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); tourGo(tourI - 1); }
}
function tourGo(i) {
  if (i < 0) i = 0;
  if (i >= TOUR_STEPS.length) return tourEnd();
  const step = TOUR_STEPS[i];
  tourI = i;
  // retry until the view has rendered the target (route changes render async);
  // ending the tour on a transient miss was a dead end under slow renders.
  let tries = 0;
  const proceed = () => {
    if (tourI !== i) return; // superseded by another navigation
    const el = document.querySelector(step.sel);
    if (!el) {
      if (++tries < 50) return setTimeout(proceed, 140);
      return tourEnd();
    }
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    requestAnimationFrame(() => requestAnimationFrame(() => tourShow(step, el)));
  };
  if (location.hash !== step.hash) {
    location.hash = step.hash;
    setTimeout(proceed, 120);
  } else proceed();
}
function tourShow(step, el) {
  if (!tourNodes) {
    const ring = document.createElement('div'); ring.className = 'tour-ring';
    const card = document.createElement('div'); card.className = 'tour-card';
    document.body.appendChild(ring); document.body.appendChild(card);
    tourNodes = { ring, card };
    document.addEventListener('keydown', tourKeys);
    tourReposition = () => { if (tourI >= 0) { const e2 = document.querySelector(TOUR_STEPS[tourI].sel); if (e2) placeTour(e2); } };
    window.addEventListener('resize', tourReposition);
    window.addEventListener('scroll', tourReposition, true);
  }
  const { card } = tourNodes;
  const last = tourI === TOUR_STEPS.length - 1;
  card.innerHTML = '<button class="tclose" type="button" aria-label="End tour">✕</button>' +
    '<div class="step">Step ' + (tourI + 1) + ' of ' + TOUR_STEPS.length + '</div>' +
    '<h3>' + esc(step.title) + '</h3><p>' + esc(step.body) + '</p>' +
    '<div class="row"><span class="dots">' + TOUR_STEPS.map((_, j) => '<i class="' + (j <= tourI ? 'on' : '') + '"></i>').join('') + '</span>' +
    '<span class="btns">' + (tourI > 0 ? '<button class="tbtn back" type="button">Back</button>' : '') +
    '<button class="tbtn next" type="button">' + (last ? 'Done' : 'Next') + '</button></span></div>';
  card.querySelector('.tclose').addEventListener('click', tourEnd);
  card.querySelector('.next').addEventListener('click', () => tourGo(tourI + 1));
  const back = card.querySelector('.back');
  if (back) back.addEventListener('click', () => tourGo(tourI - 1));
  placeTour(el);
  card.querySelector('.next').focus({ preventScroll: true });
}
function placeTour(el) {
  if (!tourNodes) return;
  const r = el.getBoundingClientRect();
  const pad = 8;
  const { ring, card } = tourNodes;
  ring.style.top = (r.top + window.scrollY - pad) + 'px';
  ring.style.left = (r.left + window.scrollX - pad) + 'px';
  ring.style.width = (r.width + pad * 2) + 'px';
  ring.style.height = (r.height + pad * 2) + 'px';
  const cw = Math.min(380, window.innerWidth - 48);
  const ch = card.offsetHeight || 220;
  const below = r.bottom + 16 + ch < window.innerHeight;
  let top = below ? r.bottom + window.scrollY + 14 : Math.max(window.scrollY + 24, r.top + window.scrollY - 14 - ch);
  let left = r.left + window.scrollX;
  if (left + cw > window.scrollX + window.innerWidth - 24) left = window.scrollX + window.innerWidth - cw - 24;
  left = Math.max(window.scrollX + 24, left);
  // never cover the spotlighted target: if the card rect intersects it, slide left of the target
  const tTop = r.top + window.scrollY, tBot = r.bottom + window.scrollY;
  const overlapsV = top < tBot + 10 && top + ch > tTop - 10;
  const overlapsH = left < r.right + window.scrollX && left + cw > r.left + window.scrollX;
  if (overlapsV && overlapsH) {
    const tryLeft = r.left + window.scrollX - cw - 24;
    if (tryLeft >= window.scrollX + 24) left = tryLeft;
    else top = tBot + 14;
  }
  // hard clamp: the card (and its Done button) must always stay inside the visible
  // viewport, even if the page scrolls away from the target after placement
  const vTop = window.scrollY + 12;
  const vBot = window.scrollY + window.innerHeight - ch - 12;
  top = Math.min(Math.max(top, vTop), Math.max(vBot, vTop));
  card.style.top = top + 'px';
  card.style.left = left + 'px';
}
function tourStart() { document.getElementById('tour-hint')?.remove(); buildTourSteps(); if (TOUR_STEPS.length) tourGo(0); }
document.getElementById('btn-tour').addEventListener('click', tourStart);

// first-visit hint
try {
  if (!localStorage.getItem('caliper-tour-done')) {
    const hint = document.createElement('div');
    hint.className = 'tour-hint'; hint.id = 'tour-hint';
    hint.innerHTML = '<p><b>New here?</b> Take a 60-second tour — it walks every panel and explains what each number means.</p>' +
      '<div class="row"><button class="tbtn next btn-opt primary" type="button" id="hint-start" style="font-size:12px;padding:7px 14px">✦ Start the tour</button>' +
      '<button class="btn-ghost" type="button" id="hint-skip">Dismiss</button></div>';
    document.body.appendChild(hint);
    hint.querySelector('#hint-start').addEventListener('click', tourStart);
    hint.querySelector('#hint-skip').addEventListener('click', () => { hint.remove(); try { localStorage.setItem('caliper-tour-done', '1'); } catch {} });
  }
} catch {}

// ── theme ───────────────────
(function themeInit() {
  let saved = null;
  try { saved = localStorage.getItem('caliper-theme'); } catch {}
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.dataset.theme = 'dark';
  const btn = document.getElementById('btn-theme');
  const paint = () => { btn.textContent = isDark() ? '☀' : '☾'; };
  paint();
  btn.addEventListener('click', () => {
    document.documentElement.dataset.theme = isDark() ? '' : 'dark';
    try { localStorage.setItem('caliper-theme', isDark() ? 'dark' : 'light'); } catch {}
    paint();
    route(); // re-render so JS-drawn SVGs pick up the theme palette
  });
})();

// ── router ────────────────────────────────────────────────────────
function setCrumbs(items) {
  document.getElementById('crumbs').innerHTML = items.map((c, i) => {
    const last = i === items.length - 1;
    const inner = last ? '<span class="here">' + esc(c.label) + '</span>' : '<a href="' + esc(c.href || '#/') + '">' + esc(c.label) + '</a>';
    return inner + (last ? '' : ' <span class="sep">›</span> ');
  }).join('');
}
function route() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/session\/([0-9a-f-]+)/))) renderSession(m[1]);
  else if (h === '#/folders') renderFolders();
  else if ((m = h.match(/^#\/folder\/(.+)$/))) renderFolder(decodeURIComponent(m[1]));
  else renderHome();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ── boot ──────────────────────────────────────────────────────────
(async function boot() {
  try {
    const [home, sessions] = await Promise.all([api('/v1/home'), api('/v1/sessions/all?limit=2000')]);
    HOME = home; SESSIONS = sessions;
    const first = await api('/v1/aggregate?budgetMs=2500');
    AGG = first; state.aggDone = !!first.done;
    computeDerived(); applyChrome(); route();
    while (!state.aggDone) {
      await new Promise(r => setTimeout(r, 300));
      let a; try { a = await api('/v1/aggregate?budgetMs=2500'); } catch { break; }
      AGG = a; state.aggDone = !!a.done;
      computeDerived(); applyChrome();
      const h = location.hash || '#/';
      if (h === '#/' || (state.aggDone && h === '#/folders')) route();
    }
  } catch (e) {
    document.getElementById('view').innerHTML =
      '<div class="panel"><div class="err-panel"><b>Could not load data:</b> ' + esc(String(e.message || e)) +
      '<br/>Is the Caliper server running? Reload to retry.</div></div>';
  }
})();
