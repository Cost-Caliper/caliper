/**
 * Control Tower — vanilla JS controller (type:module, no framework, no bundler)
 * Talks to the node:http server over /v1/* JSON + SSE.
 */

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtUsd = (n) => '$' + Number(n || 0).toFixed(6);
const fmtMs  = (n) => {
  const ms = Number(n || 0);
  if (ms < 1000) return ms.toFixed(0) + " ms";
  const s = ms / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : s.toFixed(0)) + " s";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return h + "h " + m + "m" + (sec ? " " + sec + "s" : "");
  return m + "m " + sec + "s";
};
const fmtN   = (n) => Number(n || 0).toLocaleString();
// Compact variants for narrow table cells (full value goes in the cell's title attr).
const fmtNshort = (n) => {
  const v = Number(n || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(v);
};
const fmtUsdShort = (n) => {
  const v = Number(n || 0);
  // Thousands separators so real values read as real (e.g. $16,965, not $16965)
  // and whole-dollar rounding above $100 doesn't look artificially clean.
  if (v >= 100) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  mode: 'live',           // 'live' | 'replay'
  workflowId: null,
  workflowDetail: null,   // full /v1/workflows/:id payload
  editable: null,         // /v1/workflows/:id/editable payload
  health: null,
  cassettes: [],
  runId: null,
  runStatus: 'idle',      // 'idle' | 'running' | 'done' | 'error' | 'over-budget'
  currentRun: null,       // final done payload
  optimizeData: null,     // /v1/runs/:id/optimize payload
  appliedRunId: null,     // run id of the apply-optimization re-run
  theme: 'dark',

  // Timeline state
  calls: [],              // { seq, label, tier, phase, ms, startMs, endMs, costUsd, ... }
  pendingCalls: new Map(),// seq -> DOM elements
  phaseOrder: [],         // phases seen in order

  // Rollup accumulators (live-updated)
  rollup: { calls: 0, inTok: 0, outTok: 0, costUsd: 0, sumMs: 0, wallMs: 0, speedup: 1, concurrencySavingMs: 0 },
  prevRunRollup: null,    // for before/after delta
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const els = {
  picker:          $('#workflow-picker'),
  editorPanel:     $('#editor-panel'),
  editorNote:      $('#editor-note'),
  editorAgents:    $('#editor-agents'),
  btnModeLive:     $('#btn-mode-live'),
  btnModeReplay:   $('#btn-mode-replay'),
  btnRun:          $('#btn-run'),
  btnTheme:        $('#btn-theme'),
  themeIcon:       $('#theme-icon'),
  capInput:        $('#cap-input'),
  budgetWrap:      $('#budget-wrap'),
  cassettePicker:  $('#cassette-picker'),
  cassetteWrap:    $('#cassette-wrap'),
  chipRouter:      $('#chip-router'),
  chipGate:        $('#chip-gate'),
  credWarn:        $('#cred-warn'),
  runStatusLabel:  $('#run-status-label'),
  reportLink:      $('#report-link'),
  errorBanner:     $('#error-banner'),
  errorTitle:      $('#error-title'),
  errorDetail:     $('#error-detail'),
  errorNext:       $('#error-next'),
  governorBanner:  $('#governor-banner'),
  governorMsg:     $('#governor-msg'),
  btnRaiseCap:     $('#btn-raise-cap'),
  // Stat cards
  statCallsN:      $('#stat-calls-n'),
  statCostN:       $('#stat-cost-n'),
  statTokN:        $('#stat-tok-n'),
  statWallN:       $('#stat-wall-n'),
  statSumN:        $('#stat-sum-n'),
  statSpeedupN:    $('#stat-speedup-n'),
  statSavedBadge:  $('#stat-saved-badge'),
  // Graph
  graphSvgWrap:    $('#graph-svg-wrap'),
  lintBadge:       $('#lint-badge'),
  lintFindings:    $('#lint-findings'),
  // Timeline
  timelineCanvas:  $('#timeline-canvas'),
  runLog:          $('#run-log'),
  // Tables
  callsTbody:      $('#calls-tbody'),
  phaseTbody:      $('#phase-tbody'),
  phaseTableWrap:  $('#phase-table-wrap'),
  // Optimize
  optimizeCard:    $('#optimize-card'),
  optimizeBody:    $('#optimize-body'),
  btnApplyOpt:     $('#btn-apply-opt'),
  btnDismissOpt:   $('#btn-dismiss-opt'),
  deltaCard:       $('#delta-card'),
  deltaCostBefore: $('#delta-cost-before'),
  deltaCostAfter:  $('#delta-cost-after'),
  deltaCostSaved:  $('#delta-cost-saved'),
  deltaWallBefore: $('#delta-wall-before'),
  deltaWallAfter:  $('#delta-wall-after'),
  deltaWallSaved:  $('#delta-wall-saved'),
  deltaSpeedupBefore: $('#delta-speedup-before'),
  deltaSpeedupAfter:  $('#delta-speedup-after'),
  // Learnings
  learningsPanel:  $('#learnings-panel'),
  learningsList:   $('#learnings-list'),
  distillingIndicator: $('#distilling-indicator'),
  btnWriteLearnings: $('#btn-write-learnings'),
  learningsDlLink: $('#learnings-dl-link'),
};

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  els.themeIcon.textContent = theme === 'dark' ? '☀' : '☾';
  els.btnTheme.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

els.btnTheme.addEventListener('click', () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('ct-theme', next); } catch { /* private mode */ }
});

// First load: explicit user choice (persisted) wins; else respect OS preference.
{
  let saved = null;
  try { saved = localStorage.getItem('ct-theme'); } catch { /* private mode */ }
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
  else if (window.matchMedia('(prefers-color-scheme: light)').matches) applyTheme('light');
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

function setMode(mode) {
  state.mode = mode;
  els.btnModeLive.setAttribute('aria-pressed', String(mode === 'live'));
  els.btnModeReplay.setAttribute('aria-pressed', String(mode === 'replay'));

  if (mode === 'live') {
    els.budgetWrap.classList.remove('hidden');
    els.cassetteWrap.classList.remove('visible');
    els.btnRun.textContent = 'Run Workflow';
    els.chipRouter.hidden = false;
    els.chipGate.hidden = false;
  } else {
    els.budgetWrap.classList.add('hidden');
    els.cassetteWrap.classList.add('visible');
    els.btnRun.textContent = 'Replay Cassette';
    els.chipRouter.hidden = true;
    els.chipGate.hidden = true;
  }
  updateCredentialState();
}

els.btnModeLive.addEventListener('click', () => setMode('live'));
els.btnModeReplay.addEventListener('click', () => setMode('replay'));

// ── Credential gate display ───────────────────────────────────────────────────

function updateCredentialState() {
  const health = state.health;
  if (!health) return;
  const hasKey = health.providers?.anthropic || health.providers?.openrouter;
  const isLive = state.mode === 'live';

  if (isLive && !hasKey) {
    els.credWarn.classList.remove('hidden');
    els.btnRun.disabled = true;
    els.btnRun.classList.remove('btn-primary');
    els.btnRun.classList.add('btn-tertiary');
  } else {
    els.credWarn.classList.add('hidden');
    els.btnRun.disabled = (state.runStatus === 'running');
    els.btnRun.classList.add('btn-primary');
    els.btnRun.classList.remove('btn-tertiary');
  }
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    // Server errors are shaped {error:{code,message}} — never let an object reach
    // Error() or the UI prints "[object Object]" (walker finding F-011-1).
    try {
      const j = await res.json();
      const e = j.error;
      detail = j.message || (e && typeof e === 'object' ? (e.message || e.code) : e) || detail;
    } catch { /* non-JSON body */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.json();
}

// ── Init: health + workflows + cassettes ──────────────────────────────────────

async function init() {
  try {
    const [health, workflows, cassettes] = await Promise.all([
      apiFetch('/v1/health'),
      apiFetch('/v1/workflows'),
      apiFetch('/v1/cassettes'),
    ]);
    state.health = health;
    state.cassettes = cassettes;

    // Populate workflow picker
    els.picker.innerHTML = '<option value="">— Select Workflow —</option>' +
      workflows.map(w =>
        `<option value="${esc(w.id)}">${esc(w.name)}${w.lintOk ? '' : ' ⚠'}</option>`
      ).join('');

    // Populate cassette picker
    if (cassettes.length) {
      els.cassettePicker.innerHTML = cassettes.map(c =>
        `<option value="${esc(c.path)}">${esc(c.metaName || c.path)} (${c.calls} calls)</option>`
      ).join('');
    } else {
      els.cassettePicker.innerHTML = '<option value="">No cassettes recorded yet</option>';
    }

    updateCredentialState();
  } catch (err) {
    showError('INTERNAL', 'Could not connect to server — is it running?', err.message);
  }
}

// ── Workflow picker ───────────────────────────────────────────────────────────

els.picker.addEventListener('change', async () => {
  const id = els.picker.value;
  if (!id) {
    els.graphSvgWrap.innerHTML = '<div class="graph-empty">Select a workflow to view its graph.</div>';
    resetLintBadge();
    resetStatCards();
    state.workflowId = null;
    state.workflowDetail = null;
    els.editorPanel.hidden = true;
    state.editable = null;
    return;
  }
  state.workflowId = id;
  try {
    const detail = await apiFetch(`/v1/workflows/${encodeURIComponent(id)}`);
    state.workflowDetail = detail;
    renderWorkflowDetail(detail);
    loadEditable(id);
  } catch (err) {
    showError('INTERNAL', `Could not load workflow "${id}"`, err.message);
  }
});

function renderWorkflowDetail(detail) {
  // Graph SVG
  if (detail.graphSvg) {
    els.graphSvgWrap.innerHTML = detail.graphSvg;
  } else {
    els.graphSvgWrap.innerHTML = '<div class="graph-empty">Graph not available.</div>';
  }

  // Lint badge
  const lint = detail.lint || {};
  if (lint.ok || !lint.findings?.length) {
    els.lintBadge.className = 'badge badge-green';
    els.lintBadge.textContent = '✓ Lint Pass';
    els.lintFindings.innerHTML = '';
  } else {
    els.lintBadge.className = 'badge badge-red';
    els.lintBadge.textContent = `⚠ ${lint.findings.length} Finding${lint.findings.length !== 1 ? 's' : ''}`;
    els.lintFindings.innerHTML = lint.findings.map(f => `<li>${esc(f)}</li>`).join('');
  }

  // Pre-run stat cards from estimate
  const est = detail.estimate;
  if (est) {
    const mid = est.costUsd ?? est.costMid ?? 0;
    els.statCallsN.textContent = est.calls ?? '?';
    els.statCallsN.classList.toggle('muted', true);
    els.statCostN.textContent = fmtUsd(mid);
    els.statCostN.classList.toggle('muted', true);
    els.statWallN.textContent = est.wallMs != null ? fmtMs(est.wallMs) : '?';
    els.statWallN.classList.toggle('muted', true);
    els.statSumN.textContent = est.sumMs != null ? fmtMs(est.sumMs) : '?';
    els.statSumN.classList.toggle('muted', true);
    els.statTokN.textContent = '?';
    els.statTokN.classList.toggle('muted', true);
    els.statSpeedupN.textContent = est.speedup != null ? est.speedup + '×' : '?';
    els.statSpeedupN.classList.toggle('muted', true);
    // Show ±200% caption
    $('#stat-cost').querySelector('.stat-label').textContent = 'Total Cost (est ±200%)';
  }
}

async function loadEditable(id) {
  try {
    const data = await apiFetch(`/v1/workflows/${encodeURIComponent(id)}/editable`);
    state.editable = data;
    renderEditor(data);
    els.editorPanel.hidden = false;
  } catch (err) {
    els.editorPanel.hidden = true;
    state.editable = null;
    console.warn('editable load failed', err);
  }
}

function renderEditor(data) {
  els.editorNote.textContent = data.note || '';
  els.editorAgents.innerHTML = '';
  const agents = data.agents || [];
  const modelOptions = data.modelOptions || ['haiku', 'sonnet', 'opus', 'fable'];
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = 'editor-agent';
    row.dataset.index = String(agent.index);

    const head = document.createElement('div');
    head.className = 'editor-agent-head';

    const label = document.createElement('span');
    label.className = 'editor-agent-label';
    label.textContent = agent.label || ('agent #' + (agent.index + 1));
    head.appendChild(label);

    const sel = document.createElement('select');
    sel.dataset.field = 'model';
    modelOptions.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === agent.model) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = (agent.modelEditable === false);
    head.appendChild(sel);

    if (!agent.promptEditable) {
      const tag = document.createElement('span');
      tag.className = 'editor-agent-tag';
      tag.textContent = 'dynamic prompt';
      head.appendChild(tag);
    }
    if (agent.phase) {
      const ptag = document.createElement('span');
      ptag.className = 'editor-agent-tag';
      ptag.textContent = agent.phase;
      head.appendChild(ptag);
    }
    row.appendChild(head);

    const ta = document.createElement('textarea');
    ta.dataset.field = 'prompt';
    ta.value = agent.prompt;
    ta.disabled = !agent.promptEditable;
    row.appendChild(ta);

    const markDirty = () => {
      const orig = data.agents[agent.index];
      const dirty = (sel.value !== orig.model) || (agent.promptEditable && ta.value !== orig.prompt);
      row.classList.toggle('editor-dirty', dirty);
    };
    sel.addEventListener('change', markDirty);
    ta.addEventListener('input', markDirty);

    els.editorAgents.appendChild(row);
  });
}

function gatherEdits() {
  const edits = [];
  if (!state.editable || !state.editable.agents) return edits;
  els.editorAgents.querySelectorAll('.editor-agent').forEach((row) => {
    const index = Number(row.dataset.index);
    const orig = state.editable.agents[index];
    if (!orig) return;
    const sel = row.querySelector('select[data-field="model"]');
    const ta = row.querySelector('textarea[data-field="prompt"]');
    const edit = { index };
    let changed = false;
    if (sel && sel.value !== orig.model) { edit.model = sel.value; changed = true; }
    if (ta && orig.promptEditable && ta.value !== orig.prompt) { edit.prompt = ta.value; changed = true; }
    if (changed) edits.push(edit);
  });
  return edits;
}

function resetLintBadge() {
  els.lintBadge.className = 'badge badge-gray';
  els.lintBadge.textContent = 'Select a workflow';
  els.lintFindings.innerHTML = '';
}

function resetStatCards() {
  ['statCallsN','statCostN','statTokN','statWallN','statSumN','statSpeedupN'].forEach(k => {
    els[k].textContent = '—';
    els[k].classList.add('muted');
  });
  els.statSavedBadge.hidden = true;
  $('#stat-cost').querySelector('.stat-label').textContent = 'Total Cost';
}

// ── Toggle chips ──────────────────────────────────────────────────────────────

[els.chipRouter, els.chipGate].forEach(chip => {
  chip.addEventListener('click', () => {
    const pressed = chip.getAttribute('aria-pressed') === 'true';
    chip.setAttribute('aria-pressed', String(!pressed));
  });
});

// ── Run ───────────────────────────────────────────────────────────────────────

els.btnRun.addEventListener('click', startRun);

async function startRun() {
  if (!state.workflowId) {
    alert('Select a workflow first.');
    return;
  }
  if (state.runStatus === 'running') return;

  clearRunState();
  state.runStatus = 'running';
  setRunningUI(true);

  const body = {
    workflowId: state.workflowId,
    mode: state.mode,
    useRouter: els.chipRouter.getAttribute('aria-pressed') === 'true',
    useGate: els.chipGate.getAttribute('aria-pressed') === 'true',
  };

  if (state.mode === 'live') {
    const cap = parseFloat(els.capInput.value);
    if (!isNaN(cap) && cap > 0) body.capUsd = cap;
    const hasOpenRouter = state.health?.providers?.openrouter && !state.health?.providers?.anthropic;
    body.provider = hasOpenRouter ? 'openrouter' : 'anthropic';
  } else {
    body.cassette = els.cassettePicker.value || undefined;
  }

  let runUrl = '/v1/runs';
  if (state.editable && state.editable.agents && state.editable.agents.length) {
    body.edits = gatherEdits();
    runUrl = `/v1/workflows/${encodeURIComponent(state.workflowId)}/edit-run`;
  }

  try {
    const { runId, streamUrl } = await apiFetch(runUrl, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.runId = runId;
    listenToStream(streamUrl);
  } catch (err) {
    handleRunError('INTERNAL', err.message, 'Check that the server is running and the workflow is valid.');
  }
}

function setRunningUI(running) {
  els.btnRun.disabled = running;
  if (running) {
    els.btnRun.textContent = 'Running…';
    els.btnRun.classList.add('run-status-running');
    els.runStatusLabel.textContent = 'Running…';
    els.runStatusLabel.classList.remove('hidden');
    els.runStatusLabel.className = 'label-13 run-status-running';
    els.reportLink.classList.add('hidden');
  } else {
    els.btnRun.textContent = state.mode === 'live' ? 'Run Workflow' : 'Replay Cassette';
    els.btnRun.classList.remove('run-status-running');
    els.runStatusLabel.classList.add('hidden');
  }
  updateCredentialState();
}

// ── SSE stream ────────────────────────────────────────────────────────────────

let currentEvtSource = null;

function listenToStream(url) {
  if (currentEvtSource) { currentEvtSource.close(); currentEvtSource = null; }

  const es = new EventSource(url);
  currentEvtSource = es;

  es.addEventListener('run-start', (e) => {
    const data = JSON.parse(e.data);
    // Show estimate in stat cards from the run-start event
    if (data.estimate) {
      const est = data.estimate;
      updateStatCards({
        calls: est.calls ?? 0,
        inTok: 0, outTok: 0,
        costUsd: est.costUsd ?? 0,
        wallMs: est.wallMs ?? 0,
        sumMs: est.sumMs ?? 0,
        speedup: est.speedup ?? 1,
        concurrencySavingMs: est.concurrencySavingMs ?? 0,
      }, true);
    }
    if (data.graphSvg) els.graphSvgWrap.innerHTML = data.graphSvg;
    resetTimeline();
  });

  es.addEventListener('phase', (e) => {
    const { phase } = JSON.parse(e.data);
    if (phase && !state.phaseOrder.includes(phase)) {
      state.phaseOrder.push(phase);
    }
    appendLog(phase ? `Phase: ${phase}` : 'New phase', 'info');
  });

  es.addEventListener('agent-start', (e) => {
    const data = JSON.parse(e.data);
    addPendingBar(data);
  });

  es.addEventListener('agent-end', (e) => {
    const data = JSON.parse(e.data);
    // agent-end uses 'id' (ledger id) which matches the 'seq' in agent-start
    // (runner uses the same counter). Map id -> seq for the pending bar lookup.
    completePendingBar({ ...data, seq: data.id ?? data.seq });
    state.calls.push(data);
    appendCallRow(data);

    // Live-update rollup from individual calls
    state.rollup.calls++;
    state.rollup.inTok  += data.inTok  || 0;
    state.rollup.outTok += data.outTok || 0;
    state.rollup.costUsd += data.costUsd || 0;
    updateStatCards(state.rollup);
  });

  es.addEventListener('log', (e) => {
    const { message } = JSON.parse(e.data);
    appendLog(message);
  });

  es.addEventListener('rollup', (e) => {
    const data = JSON.parse(e.data);
    if (data.run) {
      Object.assign(state.rollup, data.run);
      updateStatCards(data.run);
    }
    if (data.perPhase) renderPhaseTable(data.perPhase);
  });

  es.addEventListener('governor-trip', (e) => {
    const { spent, cap, tripCall } = JSON.parse(e.data);
    state.runStatus = 'over-budget';
    showGovernorBanner(spent, cap, tripCall);
    freezeRemainingBars();
  });

  es.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    state.runStatus = 'done';
    state.currentRun = data;
    es.close();
    currentEvtSource = null;

    // Final stats
    const thisRunRollup = data.telemetry?.run;
    if (thisRunRollup) {
      updateStatCards(thisRunRollup);
    }
    if (data.telemetry?.perPhase) renderPhaseTable(data.telemetry.perPhase);

    setRunningUI(false);

    // Report link — construct from runId (server serves it at /v1/runs/:id/report.html)
    const reportUrl = `/v1/runs/${state.runId}/report.html`;
    els.reportLink.href = reportUrl;
    els.reportLink.classList.remove('hidden');

    // If this is an apply-optimization re-run, show before/after delta
    if (state.appliedRunId && state.appliedRunId === state.runId && state.prevRunRollup && thisRunRollup) {
      renderDelta(state.prevRunRollup, thisRunRollup);
    }

    // Update prevRunRollup for future comparisons
    if (thisRunRollup) {
      state.prevRunRollup = thisRunRollup;
    }

    // Show learnings panel
    els.learningsPanel.classList.add('visible');

    // Load optimization suggestion
    if (data.optimizeAvailable !== false) {
      loadOptimization(state.runId);
    }
  });

  es.addEventListener('error', (e) => {
    if (!e.data) {
      // Connection error (not an app-level error event)
      if (state.runStatus === 'running') {
        handleRunError('INTERNAL', 'SSE connection lost', 'Reload and try again.');
      }
      es.close();
      currentEvtSource = null;
      setRunningUI(false);
      return;
    }
    const data = JSON.parse(e.data);
    handleRunError(data.code, data.message, nextStepFor(data));
    es.close();
    currentEvtSource = null;
    setRunningUI(false);
  });

  es.addEventListener('distill-start', () => {
    els.distillingIndicator.classList.add('visible');
    els.btnWriteLearnings.disabled = true;
  });

  es.addEventListener('distill-progress', (e) => {
    const data = JSON.parse(e.data);
    appendLog(`Distilling: ${data.message || ''}`, 'info');
  });

  es.addEventListener('distill-done', (e) => {
    const data = JSON.parse(e.data);
    els.distillingIndicator.classList.remove('visible');
    els.btnWriteLearnings.disabled = false;
    renderLearnings(data.learnings || []);
    if (data.mdUrl) {
      els.learningsDlLink.href = data.mdUrl;
      els.learningsDlLink.classList.remove('hidden');
    }
  });
}

function nextStepFor(data) {
  switch (data.code) {
    case 'MISSING_CREDENTIAL': return `Set the ${data.envVar || 'ANTHROPIC_API_KEY'} environment variable and restart the server, or switch to Replay mode.`;
    case 'CACHE_MISS': return 'The cassette lacks this call — re-record with a live run (add ?record=1) or choose a different cassette.';
    case 'BUDGET_EXCEEDED': return 'Raise the budget cap or choose a cheaper workflow / tier.';
    case 'PROVIDER_UNAVAILABLE': return `Provider "${data.provider}" is unavailable — check connectivity and try again.`;
    case 'HITL_DENIED': return 'Human-in-the-loop denied the call — the gate blocked execution as configured.';
    default: return 'Check server logs for details.';
  }
}

// ── Timeline rendering ────────────────────────────────────────────────────────

function resetTimeline() {
  state.calls = [];
  state.pendingCalls.clear();
  state.phaseOrder = [];
  state.rollup = { calls: 0, inTok: 0, outTok: 0, costUsd: 0, sumMs: 0, wallMs: 0, speedup: 1, concurrencySavingMs: 0 };
  els.timelineCanvas.innerHTML = '<div id="timeline-rows"></div>';
  els.runLog.classList.remove('hidden');
  els.runLog.innerHTML = '';
  els.callsTbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:12px">Waiting for first call…</td></tr>';
  els.phaseTableWrap.hidden = true;
  els.phaseTbody.innerHTML = '';
  els.statSavedBadge.hidden = true;
  els.statSavedBadge.textContent = '';
  els.governorBanner.classList.remove('visible');
  els.errorBanner.classList.remove('visible');
  els.optimizeCard.classList.remove('visible');
  els.deltaCard.classList.remove('visible');
  els.learningsPanel.classList.remove('visible');
  els.learningsList.innerHTML = '';
  els.reportLink.classList.add('hidden');
}

// Categorical palette — distinct hues, medium-high saturation (Monarch-style), each
// legible on both dark and light. fable = hero violet; opus = cyan; sonnet = clean
// gold (was a muddy brown); haiku = bright emerald (separated from opus cyan).
const TIER_COLOR = {
  haiku:  '#2fb888',
  sonnet: '#d99a2b',
  opus:   '#22a5c7',
  fable:  '#8b5cf6',
};

function addPendingBar(data) {
  const rows = $('#timeline-rows');
  if (!rows) return;

  const row = document.createElement('div');
  row.className = 't-row bar-entering';
  row.setAttribute('data-seq', data.seq);

  const label = document.createElement('div');
  label.className = 't-row-label';
  label.textContent = (data.label || `call-${data.seq}`).slice(0, 18);

  const track = document.createElement('div');
  track.className = 't-track';

  const bar = document.createElement('div');
  bar.className = 't-bar t-bar-pending';
  bar.style.left = '0%';
  bar.style.width = '100%';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${data.label} running`);

  const meta = document.createElement('div');
  meta.className = 't-row-meta';
  meta.textContent = data.tier || '';

  track.appendChild(bar);
  row.appendChild(label);
  row.appendChild(track);
  row.appendChild(meta);
  rows.appendChild(row);

  state.pendingCalls.set(data.seq, { row, bar, meta, track });
}

function completePendingBar(data) {
  const pending = state.pendingCalls.get(data.seq);
  if (!pending) return;
  const { bar, meta } = pending;

  bar.classList.remove('t-bar-pending');
  if (data.error) {
    bar.classList.add('t-bar-error');
    bar.setAttribute('aria-label', `${data.label} error`);
  } else {
    bar.classList.add('t-bar-ok');
    bar.setAttribute('aria-label', `${data.label} ${fmtMs(data.ms)}`);
  }

  // Style with tier color
  const color = TIER_COLOR[data.tier] || '#777';
  bar.style.background = data.error ? 'var(--red)' : color;

  // Tooltip content
  bar.title = [
    data.label || '',
    data.tier,
    fmtMs(data.ms),
    `${fmtN(data.inTok)}in / ${fmtN(data.outTok)}out`,
    fmtUsd(data.costUsd),
    data.requestId ? `req: ${data.requestId}` : '',
  ].filter(Boolean).join(' · ');

  meta.textContent = fmtMs(data.ms) + ' · ' + fmtUsd(data.costUsd);
  meta.classList.add('mono');

  state.pendingCalls.delete(data.seq);
}

function freezeRemainingBars() {
  for (const { bar } of state.pendingCalls.values()) {
    bar.classList.remove('t-bar-pending');
    bar.classList.add('t-bar-frozen');
  }
}

// ── Log strip ─────────────────────────────────────────────────────────────────

function appendLog(message, type = '') {
  const el = document.createElement('div');
  el.className = `run-log-entry${type ? ' ' + type : ''}`;
  el.textContent = message;
  els.runLog.appendChild(el);
  els.runLog.scrollTop = els.runLog.scrollHeight;
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function updateStatCards(run, isEst = false) {
  const muted = isEst;
  const setN = (el, text) => {
    el.textContent = text;
    el.classList.toggle('muted', muted);
  };

  setN(els.statCallsN, fmtN(run.calls));
  setN(els.statCostN, fmtUsd(run.costUsd));
  setN(els.statTokN, `${fmtN(run.inTok)} / ${fmtN(run.outTok)}`);
  setN(els.statWallN, run.wallMs != null ? fmtMs(run.wallMs) : '—');
  setN(els.statSumN, run.sumMs != null ? fmtMs(run.sumMs) : '—');

  const speedup = run.speedup ?? 1;
  setN(els.statSpeedupN, speedup.toFixed(2) + '×');

  // Only show the "saved" badge when there's a real, meaningful concurrency win.
  // Guard against tiny float noise (e.g. -0.1ms) and stale values leaking across runs.
  if (run.concurrencySavingMs > 0.5) {
    els.statSavedBadge.hidden = false;
    els.statSavedBadge.textContent = fmtMs(run.concurrencySavingMs) + ' saved';
  } else {
    els.statSavedBadge.hidden = true;
    els.statSavedBadge.textContent = '';
  }
}

// ── Per-call table ────────────────────────────────────────────────────────────

let callsTableEmpty = true;

function appendCallRow(data) {
  if (callsTableEmpty) {
    els.callsTbody.innerHTML = '';
    callsTableEmpty = false;
  }
  const flags = [];
  if (data.cached)    flags.push('<span class="badge badge-blue">Cached</span>');
  if (data.replayed)  flags.push('<span class="badge badge-gray">Replayed</span>');
  if (data.routedTier) flags.push(`<span class="badge badge-amber">Routed→${esc(data.routedTier)}</span>`);

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="num mono">${esc(data.id ?? '')}</td>
    <td>${esc(data.label || '')}</td>
    <td><span class="badge ${tierBadge(data.tier)}">${esc(data.tier || '')}</span></td>
    <td>${esc(data.phase || '')}</td>
    <td class="num ms-val">${fmtMs(data.ms)}</td>
    <td class="num tok-val">${fmtN(data.inTok)}</td>
    <td class="num tok-val">${fmtN(data.outTok)}</td>
    <td class="num cost-val">${fmtUsd(data.costUsd)}</td>
    <td class="req-id">${esc(data.requestId || '')}</td>
    <td>${flags.join(' ')}</td>
  `;
  if (data.error) tr.style.background = 'color-mix(in srgb, var(--red) 8%, transparent)';
  els.callsTbody.appendChild(tr);
}

function tierBadge(tier) {
  switch (tier) {
    case 'haiku':  return 'badge-green';
    case 'sonnet': return 'badge-amber';
    case 'opus':   return 'badge-red';
    default:       return 'badge-gray';
  }
}

// ── Phase rollup table ────────────────────────────────────────────────────────

function renderPhaseTable(phases) {
  if (!phases?.length) return;
  els.phaseTableWrap.hidden = false;
  els.phaseTbody.innerHTML = phases.map(p => `
    <tr>
      <td>${esc(p.phase)}</td>
      <td class="num mono">${fmtN(p.calls)}</td>
      <td class="num mono">${fmtN(p.inTok)}</td>
      <td class="num mono">${fmtN(p.outTok)}</td>
      <td class="num cost-val">${fmtUsd(p.costUsd)}</td>
      <td class="num ms-val">${fmtMs(p.sumMs)}</td>
      <td class="num ms-val">${fmtMs(p.wallMs)}</td>
    </tr>
  `).join('');
}

// ── Error display ─────────────────────────────────────────────────────────────

function showError(code, message, next = '') {
  state.runStatus = 'error';
  els.errorBanner.classList.add('visible');
  els.errorTitle.textContent = code ? `${code}: ${message}` : message;
  els.errorDetail.textContent = '';
  els.errorNext.textContent = next;
  setRunningUI(false);
}

function handleRunError(code, message, next) {
  showError(code, message, next);
}

function clearRunState() {
  els.errorBanner.classList.remove('visible');
  els.governorBanner.classList.remove('visible');
  els.optimizeCard.classList.remove('visible');
  els.deltaCard.classList.remove('visible');
  els.runStatusLabel.classList.add('hidden');
  callsTableEmpty = true;
}

// ── Governor banner ───────────────────────────────────────────────────────────

function showGovernorBanner(spent, cap, tripCall) {
  els.governorBanner.classList.add('visible');
  els.governorMsg.textContent = `Over Budget — spent ${fmtUsd(spent)} ≥ cap ${fmtUsd(cap)} at call ${tripCall ?? '?'}`;
  setRunningUI(false);
}

els.btnRaiseCap.addEventListener('click', () => {
  // Suggest a new cap slightly above observed spend
  const run = state.currentRun?.telemetry?.run || state.rollup;
  const suggested = ((run.costUsd || 0) * 1.5).toFixed(4);
  els.capInput.value = suggested;
  els.governorBanner.classList.remove('visible');
  setMode('live');
  // Re-focus the cap input
  els.capInput.focus();
});

// ── Optimization ──────────────────────────────────────────────────────────────

async function loadOptimization(runId) {
  if (!runId) return;
  try {
    const data = await apiFetch(`/v1/runs/${runId}/optimize`);
    state.optimizeData = data;
    renderOptimize(data);
  } catch (err) {
    // Non-fatal — just don't show the card
    console.warn('Optimization suggestion failed:', err.message);
  }
}

function renderOptimize(data) {
  const suggestions = data.suggestions || [];
  if (!suggestions.length) return;

  els.optimizeCard.classList.add('visible');

  const html = suggestions.map((s, i) => `
    <div style="margin-top:${i > 0 ? 12 : 0}px">
      <div style="font-size:14px;font-weight:600;color:var(--gray-1000)">${esc(s.kind || 'Suggestion')}</div>
      <div style="margin-top:4px">${esc(s.rationale)}</div>
      ${s.cites?.length ? `<div style="margin-top:6px;font-size:12px;color:var(--gray-700)">Cited calls: ${s.cites.map(c => `<span class="optimize-cite">${esc(c)}</span>`).join(', ')} <em>(n=1 run)</em></div>` : ''}
    </div>
  `).join('<div class="divider" style="margin:12px 0"></div>');

  els.optimizeBody.innerHTML = html;
}

els.btnApplyOpt.addEventListener('click', async () => {
  if (!state.runId || !state.optimizeData) return;
  els.btnApplyOpt.disabled = true;
  els.btnApplyOpt.textContent = 'Applying…';

  // Pick the first suggestion's proposedRunBody (or merge all non-conflicting)
  const suggestions = state.optimizeData.suggestions || [];
  const proposedRunBody = suggestions.reduce((acc, s) => ({ ...acc, ...(s.proposedRunBody || {}) }), {});

  const beforeRollup = state.prevRunRollup;

  try {
    const { runId, streamUrl } = await apiFetch(`/v1/runs/${state.runId}/apply-optimization`, {
      method: 'POST',
      body: JSON.stringify({ proposedRunBody }),
    });
    state.appliedRunId = runId;
    state.runId = runId;
    clearRunState();
    state.runStatus = 'running';
    setRunningUI(true);

    // Attach listener before connecting so delta renders on done
    listenToStream(streamUrl);

    // Intercept the done event to show delta
    const origOnDone = (e) => {
      const data = JSON.parse(e.data);
      if (data.telemetry?.run && beforeRollup) {
        renderDelta(beforeRollup, data.telemetry.run);
      }
    };
    // We will handle this via the done event handler already in listenToStream;
    // store the before rollup so it's available when done fires
    state.prevRunRollup = beforeRollup;

  } catch (err) {
    els.btnApplyOpt.disabled = false;
    els.btnApplyOpt.textContent = 'Apply Optimization';
    handleRunError('INTERNAL', 'Apply optimization failed', err.message);
  }
});

els.btnDismissOpt.addEventListener('click', () => {
  els.optimizeCard.classList.remove('visible');
});

function renderDelta(before, after) {
  els.deltaCard.classList.add('visible');

  const costSaved = before.costUsd - after.costUsd;
  const wallSaved = before.wallMs - after.wallMs;

  els.deltaCostBefore.textContent = fmtUsd(before.costUsd);
  els.deltaCostAfter.textContent = fmtUsd(after.costUsd);
  els.deltaCostSaved.textContent = costSaved > 0 ? `−${fmtUsd(costSaved)} saved` : '';

  els.deltaWallBefore.textContent = fmtMs(before.wallMs);
  els.deltaWallAfter.textContent = fmtMs(after.wallMs);
  els.deltaWallSaved.textContent = wallSaved > 0 ? `−${fmtMs(wallSaved)} faster` : '';

  els.deltaSpeedupBefore.textContent = (before.speedup ?? 1).toFixed(2) + '×';
  els.deltaSpeedupAfter.textContent = (after.speedup ?? 1).toFixed(2) + '×';
}

// ── Learnings ─────────────────────────────────────────────────────────────────

els.btnWriteLearnings.addEventListener('click', async () => {
  if (!state.runId) return;
  if (!state.health?.providers?.anthropic && !state.health?.providers?.openrouter) {
    handleRunError('MISSING_CREDENTIAL', 'Write Learnings requires an API key', nextStepFor({ code: 'MISSING_CREDENTIAL' }));
    return;
  }
  els.btnWriteLearnings.disabled = true;
  els.btnWriteLearnings.textContent = 'Distilling…';
  els.distillingIndicator.classList.add('visible');

  try {
    const streamUrl = `/v1/runs/${state.runId}/learn`;
    // POST to start; the events come back on the existing stream OR a dedicated endpoint
    await apiFetch(`/v1/runs/${state.runId}/learn`, { method: 'POST' });
    // The SSE stream will emit distill-start/done events
  } catch (err) {
    els.btnWriteLearnings.disabled = false;
    els.btnWriteLearnings.textContent = 'Write Learnings';
    els.distillingIndicator.classList.remove('visible');
    handleRunError('INTERNAL', 'Write Learnings failed', err.message);
  }
});

function renderLearnings(learnings) {
  els.learningsList.innerHTML = learnings.map(l => `
    <li>
      <div>${esc(l.text || l)}</div>
      ${l.cite ? `<div class="learning-cite">${esc(l.cite)}</div>` : ''}
    </li>
  `).join('');
  els.btnWriteLearnings.disabled = false;
  els.btnWriteLearnings.textContent = 'Write Learnings';
}

// ── Keyboard accessibility ────────────────────────────────────────────────────

// Ensure segmented buttons respond to arrow keys (ARIA pattern)
const segBtns = [els.btnModeLive, els.btnModeReplay];
segBtns.forEach((btn, i) => {
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      segBtns[(i + 1) % segBtns.length].focus();
      setMode(i === 0 ? 'replay' : 'live');
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      segBtns[(i - 1 + segBtns.length) % segBtns.length].focus();
      setMode(i === 0 ? 'replay' : 'live');
    }
  });
});

// ── Observed Runs panel ───────────────────────────────────────────────────────
//
// Fetches native harness runs from GET /v1/observed.
// Renders a list of observed runs with source badge "Observed (native)".
// Clicking a run fetches GET /v1/observed/:id and renders per-call detail
// with cache columns (cacheCreationTok / cacheReadTok) and a traces strip.
//
// Also subscribes to GET /v1/observed/stream (SSE) for live beacon arrivals
// and auto-refreshes when a beacon comes in.

const observedEls = {
  panel:      $('#observed-panel'),
  empty:      $('#observed-empty'),
  list:       $('#observed-list'),
  btnRefresh: $('#btn-refresh-observed'),
};

// Each observed run is an accordion item that unfolds its detail INLINE. The full
// reconstructed run (with per-call records) is lazy-fetched on first expand + cached.
const runCache = new Map();   // runId -> /v1/observed/:id payload

// ── metadata formatting (when · branch · dir) ──────────────────────────────────
function fmtWhen(r) {
  const iso = r.timestamp || r.startedAt;
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function homeAbbrev(p) { return String(p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~'); }
function abbrevDir(cwd) {
  const p = homeAbbrev(cwd);
  if (!p) return '';
  const segs = p.split('/').filter(Boolean);
  if (segs.length <= 3) return p;
  return (p.startsWith('~') ? '~/…/' : '…/') + segs.slice(-2).join('/');
}

// One delegated handler for the whole list: drill-in Close, per-call drill-in, then
// row-toggle. Attached ONCE — renderObservedList only replaces innerHTML.
observedEls.list?.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-call]');
  if (closeBtn) { const slot = closeBtn.closest('.obs-call-detail'); if (slot) slot.hidden = true; return; }
  const scriptEl = e.target.closest('[data-script]');
  if (scriptEl) { openScriptDrawer(scriptEl.getAttribute('data-script')); return; }
  const callEl = e.target.closest('[data-call-idx]');
  if (callEl) {
    const item = callEl.closest('.obs-run-item'); if (!item) return;
    const run = runCache.get(item.dataset.runId);
    const c = run?.telemetry?.calls?.[Number(callEl.dataset.callIdx)];
    if (!c) return;
    // Agent name (data-drill="inline") → full subagent details inline.
    // A specific graph segment (data-seg-idx) → that exact tool call / inference step.
    // Anything else with a call idx (table row) → the call summary.
    if (callEl.getAttribute('data-drill') === 'inline') {
      const slot = item.querySelector('.obs-call-detail');
      if (slot) renderCallDetailInto(slot, c);
    } else {
      const segIdx = callEl.getAttribute('data-seg-idx');
      const seg = segIdx != null ? (c.segments || [])[Number(segIdx)] : null;
      openCallDrawer(c, seg);
    }
    return;
  }
  const row = e.target.closest('.obs-run-row');
  if (row) toggleItem(row.closest('.obs-run-item'));
});
// Keyboard: the run row is a <tr role=button tabindex=0>, so Enter/Space toggle it.
observedEls.list?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.obs-run-row');
  if (row) { e.preventDefault(); toggleItem(row.closest('.obs-run-item')); }
});

// ── Timeline hover tooltip ─────────────────────────────────────────────────────
// A floating tooltip that follows the cursor over the timeline and summarizes the
// segment underneath: inference vs tool, the tool name(s), and the span duration.
let lastTipSeg = null;
function showSegTip(e, seg) {
  const tip = document.getElementById('tl-tip'); if (!tip) return;
  const kind = seg.getAttribute('data-seg-kind');
  const dur = Number(seg.getAttribute('data-seg-dur') || 0);
  const toolsStr = seg.getAttribute('data-seg-tools') || '';
  const label = seg.getAttribute('data-seg-label') || '';
  const isTool = kind === 'tool';
  const title = isTool ? (toolsStr ? `Tool · ${esc(toolsStr)}` : 'Tool execution') : 'Inference (model)';
  const dot = isTool ? SEG_COLOR.tool : SEG_COLOR.inference;
  tip.innerHTML = `<div class="tl-tip-head">${esc(label)}</div>`
    + `<div class="tl-tip-row"><span class="tl-tip-dot" style="background:${dot}"></span><span>${title}</span> · <span class="mono">${fmtMs(dur)}</span></div>`
    + `<div class="tl-tip-hint">click for this ${isTool ? 'tool call' : 'inference step'} →</div>`;
  tip.hidden = false;
  positionSegTip(e);
}
function positionSegTip(e) {
  const tip = document.getElementById('tl-tip'); if (!tip || tip.hidden) return;
  const pad = 14; const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
function hideSegTip() { const tip = document.getElementById('tl-tip'); if (tip) tip.hidden = true; lastTipSeg = null; }
observedEls.list?.addEventListener('mousemove', (e) => {
  const seg = e.target.closest('[data-seg-kind]');
  if (!seg) { if (lastTipSeg) hideSegTip(); return; }
  if (seg !== lastTipSeg) { lastTipSeg = seg; showSegTip(e, seg); } else positionSegTip(e);
});
observedEls.list?.addEventListener('mouseleave', hideSegTip);

// ── Call detail drawer (right side) ────────────────────────────────────────────
function callDetailHtml(c) {
  const kv = (k, v) => `<span style="white-space:nowrap"><span style="color:var(--gray-700)">${esc(k)}</span> <span class="mono" style="color:var(--gray-1000)">${esc(String(v))}</span></span>`;
  const meta = [
    kv('model', (c.model || '').replace('claude-', '') || c.tier || '—'),
    kv('phase', c.phase || '—'),
    kv('wall', fmtMs(c.ms)),
    kv('cost', fmtUsd(c.costUsd)),
    kv('tok', fmtN(c.inTok) + '→' + fmtN(c.outTok)),
    kv('cache', fmtN(c.cacheCreationTok || 0) + 'wr/' + fmtN(c.cacheReadTok || 0) + 'rd'),
    kv('turns', String(c.turns || 0)),
    kv('tool calls', String(c.toolCalls || 0)),
  ].join('<span style="color:var(--gray-500)"> · </span>');
  const split = (c.inferenceMs != null && c.toolMs != null)
    ? `<div style="display:flex;gap:14px;align-items:center;margin:8px 0 2px;font-size:12px">`
      + `<span><span class="tl-tip-dot" style="background:${SEG_COLOR.inference}"></span> Inference <span class="mono">${fmtMs(c.inferenceMs)}</span></span>`
      + `<span><span class="tl-tip-dot" style="background:${SEG_COLOR.tool}"></span> Tool <span class="mono">${fmtMs(c.toolMs)}</span></span>`
      + `</div>`
    : '';
  const tools = (c.tools || []).length
    ? `<div style="font-size:12px;color:var(--gray-900);margin:6px 0">tools: <span class="mono" style="color:var(--gray-1000)">${esc((c.tools || []).join(', '))}</span></div>`
    : '';
  return `<div style="font-size:15px;color:var(--gray-1000);margin-bottom:8px"><span class="tier-dot" style="background:${esc(tierColor(c.tier))}"></span> ${esc(c.label || '')}</div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;font-size:12px">${meta}</div>`
    + split + tools
    + `<div style="font-size:12px;color:var(--gray-900);margin:10px 0 4px">Task — the prompt this agent received</div>`
    + `<pre class="cd-pre">${esc(c.task || '(no prompt captured)')}</pre>`
    + `<div style="font-size:12px;color:var(--gray-900);margin:10px 0 4px">Output — its last assistant text</div>`
    + `<pre class="cd-pre cd-pre-tall">${esc(c.output || '(no text output — tool-only turn)')}</pre>`;
}
// Detail for ONE clicked segment: the specific tool call(s) or inference step.
function segmentDetailHtml(seg, c) {
  const dur = fmtMs((seg.endMs || 0) - (seg.startMs || 0));
  const isTool = seg.kind === 'tool';
  const dot = isTool ? SEG_COLOR.tool : SEG_COLOR.inference;
  const head = `<div style="font-size:15px;color:var(--gray-1000);margin-bottom:2px"><span class="tier-dot" style="background:${esc(tierColor(c.tier))}"></span> ${esc(c.label || '')}</div>`
    + `<div style="display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:13px;color:var(--gray-900)">`
    + `<span class="tl-tip-dot" style="background:${dot}"></span>`
    + `<strong style="color:var(--gray-1000)">${isTool ? 'Tool call' : 'Inference'}</strong> · <span class="mono">${dur}</span></div>`;
  const d = seg.detail || {};
  // Refusal-fallback banner: the headline moment — when and why this step left Fable.
  const fbBanner = (d.fallback || d.refusal)
    ? `<div class="cd-fallback-banner">`
      + (d.refusal
        ? `⛔ <strong>Fable refused this request</strong> (safety classifier${d.refusal.category ? ` · category: ${esc(d.refusal.category)}` : ''}) — the streamed partial is still billed.`
        : '')
      + (d.fallback
        ? `${d.refusal ? '<br>' : ''}⇄ <strong>Switched off Fable here</strong> — re-served by <span class="mono">${esc(String(d.fallback.to || 'fallback').replace(/^claude-/, ''))}</span>; sticky routing keeps later turns there (~1h). Priced at the serving model's own rate.`
        : '')
      + (() => {
        // The prompt that triggered it — from the transcript's fallback event log.
        const evs = (c.fallbacks && Array.isArray(c.fallbacks.events)) ? c.fallbacks.events : [];
        const ev = evs.find((e) => e && e.kind === (d.fallback ? 'switch' : 'refusal') && e.prompt) || evs.find((e) => e && e.prompt);
        return ev ? `<div style="margin-top:7px;font-size:11.5px;color:var(--gray-900)">triggering prompt: <span class="mono" style="color:var(--gray-1000)">“${esc(truncTxt(ev.prompt, 160))}”</span></div>` : '';
      })()
      + `</div>`
    : '';
  if (isTool) {
    const calls = Array.isArray(d.calls) ? d.calls : [];
    if (!calls.length) return head + `<div class="muted" style="font-size:12px">No tool-call payload captured for this span.</div>`;
    const body = calls.map((call, n) => {
      const status = call.isError
        ? '<span style="color:var(--red,#ef4444);font-size:11px" title="The tool returned an error result (is_error)">✗ error</span>'
        : '<span style="color:var(--green,#10b981);font-size:11px" title="The tool returned successfully">✓ ok</span>';
      const size = call.resultLen ? `<span class="metric" title="Size of the tool's result (characters); the preview below may be truncated." style="border-bottom:none;font-size:10.5px;color:var(--gray-700)">${fmtNshort(call.resultLen)} chars</span>` : '';
      const inputStr = call.input != null ? String(call.input) : '';
      const inputT = inputStr.trim();
      const inputHtml = (inputT.startsWith('{') || inputT.startsWith('['))
        ? `<pre class="code-block">${highlightJson(inputStr)}</pre>`            // JSON args
        : `<pre class="cd-pre">${esc(inputStr || '(no input)')}</pre>`;          // plain string arg
      return ''
        + `<div style="display:flex;align-items:center;gap:8px;margin:${n ? 14 : 0}px 0 4px"><span class="mono" style="font-size:13px;color:var(--gray-1000)">${esc(call.name || 'tool')}</span> ${status}</div>`
        + `<div style="font-size:11px;color:var(--gray-700);margin:6px 0 3px">Input</div>`
        + inputHtml
        + `<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:var(--gray-700);margin:8px 0 3px"><span>Result</span>${size}</div>`
        + `<pre class="cd-pre cd-pre-tall">${esc(call.result != null ? String(call.result) : '(no result captured)')}</pre>`;
    }).join('');
    return head + body;
  }
  const decided = Array.isArray(d.decided) && d.decided.length
    ? `<div style="font-size:12px;color:var(--gray-900);margin-bottom:8px">decided to call: <span class="mono" style="color:var(--gray-1000)">${esc(d.decided.join(', '))}</span></div>`
    : '';
  // Per-step metadata chips: tokens generated, cache reuse, cost, throughput, why it
  // stopped, model, and #turns merged into this span.
  const durMs = (seg.endMs || 0) - (seg.startMs || 0);
  const tps = (d.outTok && durMs > 0) ? Math.round(d.outTok / (durMs / 1000)) : null;
  const chip = (label, val, title) => `<span class="metric" title="${esc(title)}" style="border-bottom:none">${label} <span class="mono" style="color:var(--gray-1000)">${esc(val)}</span></span>`;
  const chips = [
    d.outTok != null ? chip('output', fmtN(d.outTok) + ' tok', 'Tokens the model generated in this inference step.') : '',
    d.inTok ? chip('input', fmtN(d.inTok) + ' tok', 'Uncached input tokens the model processed this step (the fresh prompt delta; cached context is counted under cache-read).') : '',
    d.cacheReadTok ? chip('cache-read', fmtNshort(d.cacheReadTok), 'Cached input tokens reused (charged at 0.10×) — context the model did not re-process.') : '',
    d.cacheCreationTok ? chip('cache-write', fmtNshort(d.cacheCreationTok), 'Tokens written to the prompt cache this step (charged at 1.25×).') : '',
    d.costUsd != null ? chip('cost', fmtUsdShort(d.costUsd), 'Reconstructed cost of just this inference step (cache-aware estimate).') : '',
    tps != null ? chip('speed', tps + ' tok/s', 'Output tokens ÷ this step’s wall-clock — generation throughput.') : '',
    d.stopReason ? chip('stop', d.stopReason, 'Why the model ended this turn: tool_use = it called a tool; end_turn = it finished; max_tokens = it hit the output limit.') : '',
    d.model ? chip('model', (d.model || '').replace('claude-', ''), 'The model that ran this inference step.') : '',
    (d.turns && d.turns > 1) ? chip('turns', String(d.turns), 'How many consecutive assistant turns were merged into this inference span.') : '',
  ].filter(Boolean);
  const metricsRow = chips.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:10px;font-size:11.5px;color:var(--gray-700)">${chips.join('')}</div>`
    : '';
  const thinking = d.thinking
    ? `<div style="font-size:11px;color:var(--gray-700);margin:0 0 3px">Reasoning (extended thinking)</div><pre class="cd-pre" style="max-height:30vh">${esc(d.thinking)}</pre>`
    : '';
  return head + fbBanner + decided + metricsRow + thinking
    + `<div style="font-size:11px;color:var(--gray-700);margin:8px 0 3px">Model output for this step</div>`
    + `<pre class="cd-pre cd-pre-tall">${esc(d.text || '(no text — this step only emitted a tool call)')}</pre>`;
}
// Dependency-free JS syntax highlighter (no CDN/framework — fits the dashboard's ethos).
// One master regex tokenizes the source so keywords inside strings/comments aren't touched;
// every emitted character is escaped, so the result is safe to inject as HTML.
const JS_KEYWORDS = new Set(('const let var function return if else for while await async export import ' +
  'default from new class extends of in typeof instanceof try catch finally throw switch case break ' +
  'continue do yield this super null true false undefined void delete static get set').split(' '));
function highlightJs(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`)|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;
  let out = '', m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out += `<span class="hl-comment">${esc(m[1])}</span>`;
    else if (m[2] || m[3]) out += `<span class="hl-string">${esc(m[2] || m[3])}</span>`;
    else if (m[4]) out += `<span class="hl-num">${esc(m[4])}</span>`;
    else if (m[5]) {
      const id = m[5];
      out += JS_KEYWORDS.has(id) ? `<span class="hl-kw">${esc(id)}</span>`
        : /^[A-Z]/.test(id) ? `<span class="hl-type">${esc(id)}</span>`
        : esc(id);
    } else if (m[6]) out += m[6];          // whitespace (safe verbatim)
    else out += esc(m[7]);                 // punctuation / other
  }
  return out;
}

// JSON highlighter for tool inputs (object property keys vs string values vs literals).
function highlightJson(src) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d[\d.eE+-]*\b)|(\btrue\b|\bfalse\b|\bnull\b)|(\s+)|([\s\S])/g;
  let out = '', m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out += m[2]                   // a string immediately before ":" is a key
      ? `<span class="hl-key">${esc(m[1])}</span>${esc(m[2])}`
      : `<span class="hl-string">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="hl-num">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="hl-kw">${esc(m[4])}</span>`;
    else if (m[5]) out += m[5];
    else out += esc(m[6]);
  }
  return out;
}

// Wrap any source string in a line-numbered, optionally-highlighted code block.
function codeBlockHtml(source, highlighter) {
  const code = highlighter ? highlighter(source) : esc(source);
  const lineCount = source.split('\n').length;
  let gutter = '';
  for (let i = 1; i <= lineCount; i++) gutter += (i > 1 ? '\n' : '') + i;
  return `<div class="code-wrap"><pre class="code-gutter" aria-hidden="true">${gutter}</pre><pre class="code-src"><code>${code}</code></pre></div>`;
}

// Open the workflow source for a run in the drawer: its name, on-disk path, and the
// exact script the harness executed. (Browsers can't open a local file directly, so we
// show the source + the path you can open in your editor.)
async function openScriptDrawer(runId) {
  const dr = document.getElementById('cd-drawer'); const scrim = document.getElementById('cd-scrim');
  if (!dr) return;
  const title = dr.querySelector('.cd-head strong'); if (title) title.textContent = 'Workflow source';
  const body = dr.querySelector('.cd-body'); if (body) body.innerHTML = '<div class="muted" style="font-size:12px">Loading source…</div>';
  dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false'); if (scrim) scrim.hidden = false;
  let d;
  try { const res = await fetch(`/v1/observed/${encodeURIComponent(runId)}/script`); if (!res.ok) throw new Error('HTTP ' + res.status); d = await res.json(); }
  catch (err) { if (body) body.innerHTML = `<div class="muted" style="font-size:12px">Could not load source: ${esc(err.message)}</div>`; return; }
  if (!body) return;
  const pathBlock = d.path
    ? `<div style="font-size:11px;color:var(--gray-700);margin:0 0 3px">File <span class="muted">(open in your editor)</span></div>`
      + `<pre class="cd-pre" style="white-space:pre-wrap;word-break:break-all">${esc(d.path)}</pre>`
      + `<div style="margin:4px 0 10px"><a href="vscode://file${esc(d.path)}" style="font-size:11px;color:var(--blue)">Open in VS Code ↗</a></div>`
    : '<div class="muted" style="font-size:11px;margin-bottom:8px">Inline workflow — no saved file path.</div>';
  const sourceHtml = d.source
    ? codeBlockHtml(d.source, highlightJs)
    : codeBlockHtml('(source not recorded for this run)');
  body.innerHTML =
    `<div style="font-size:15px;color:var(--gray-1000);margin-bottom:8px"><span class="mono">${esc(d.name || runId)}</span></div>`
    + pathBlock
    + `<div style="font-size:11px;color:var(--gray-700);margin:6px 0 3px">Source <span class="muted">(${(d.source || '').length.toLocaleString()} chars)</span></div>`
    + sourceHtml;
}
function openCallDrawer(c, seg) {
  const dr = document.getElementById('cd-drawer'); const scrim = document.getElementById('cd-scrim');
  if (!dr || !c) return;
  const title = dr.querySelector('.cd-head strong');
  if (title) title.textContent = seg ? (seg.kind === 'tool' ? 'Tool call' : 'Inference step') : 'Call details';
  const body = dr.querySelector('.cd-body'); if (body) body.innerHTML = seg ? segmentDetailHtml(seg, c) : callDetailHtml(c);
  dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
  if (scrim) scrim.hidden = false;
}
function closeCallDrawer() {
  const dr = document.getElementById('cd-drawer'); const scrim = document.getElementById('cd-scrim');
  if (dr) { dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); }
  if (scrim) scrim.hidden = true;
}
document.getElementById('cd-close')?.addEventListener('click', closeCallDrawer);
document.getElementById('cd-scrim')?.addEventListener('click', closeCallDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCallDrawer(); });

// ── Filter by git branch / working directory ───────────────────────────────────
const obsFilterEls = {
  bar:    $('#obs-filter-bar'),
  branch: $('#obs-filter-branch'),
  dir:    $('#obs-filter-dir'),
  count:  $('#obs-filter-count'),
};
let observedRuns = [];   // the full unfiltered list from GET /v1/observed

function obsDistinct(vals) { return [...new Set(vals.filter(Boolean))].sort(); }

function populateObservedFilters(runs) {
  const branches = obsDistinct(runs.map((r) => r.gitBranch));
  const dirs = obsDistinct(runs.map((r) => r.cwd));
  const fill = (sel, items, labelFn) => {
    if (!sel) return;
    const cur = sel.value;   // preserve current selection across refreshes
    sel.innerHTML = '<option value="all">All</option>'
      + items.map((v) => `<option value="${esc(v)}">${esc(labelFn ? labelFn(v) : v)}</option>`).join('');
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  };
  fill(obsFilterEls.branch, branches);
  fill(obsFilterEls.dir, dirs, (d) => homeAbbrev(d));
  // Show a dropdown ONLY for a dimension that actually varies — a constant branch/dir is
  // noise (and a single-value "Directory" select reads misleadingly like a folder picker).
  const showDir = dirs.length > 1, showBranch = branches.length > 1;
  const dirWrap = document.getElementById('obs-filter-dir-wrap');
  const branchWrap = document.getElementById('obs-filter-branch-wrap');
  if (dirWrap) dirWrap.hidden = !showDir;
  if (branchWrap) branchWrap.hidden = !showBranch;
  if (obsFilterEls.bar) obsFilterEls.bar.hidden = !(showDir || showBranch);
}

// Project/session context line for the Workflows view — answers "which repo/dir am I in".
async function populateObsContext(runs) {
  const el = document.getElementById('obs-context'); if (!el) return;
  if (!runs || !runs.length) { el.innerHTML = ''; return; } // empty state already shows "Watching …"
  const dirs = obsDistinct(runs.map((r) => r.cwd));
  const branches = obsDistinct(runs.map((r) => r.gitBranch));
  let sessionShort = '';
  try { const h = await apiFetch('/v1/health'); const sd = h?.bridge?.sessionDir; if (sd) sessionShort = String(sd).split('/').pop().slice(0, 8); } catch { /* non-fatal */ }
  const parts = [
    dirs.length === 1 ? `<span title="${esc(dirs[0])}">${esc(homeAbbrev(dirs[0]))}</span>` : dirs.length > 1 ? `${dirs.length} working dirs` : '',
    // Only show the branch when every run shares one (useful context). When runs span
    // several, a "N branches" summary misreads as a repo-wide claim — the Branch filter
    // (which lists exactly those branches) is the honest disclosure instead.
    branches.length === 1 ? `branch ${esc(branches[0])}` : '',
    sessionShort ? `session ${esc(sessionShort)}` : '',
  ].filter(Boolean);
  el.innerHTML = projectContextHtml(parts);
}

// Project-context line: parts[0] (the project dir) is always shown; the rest
// (branches · session) collapse into a .ctx-more span that fades in on hover.
function projectContextHtml(parts) {
  if (!parts.length) return '';
  const sep = '<span class="obs-sub-sep"> · </span>';
  const more = parts.slice(1);
  return parts[0] + (more.length ? `<span class="ctx-more">${sep}${more.join(sep)}</span>` : '');
}

function applyObservedFilters() {
  const b = obsFilterEls.branch?.value || 'all';
  const d = obsFilterEls.dir?.value || 'all';
  const filtered = observedRuns.filter((r) =>
    (b === 'all' || r.gitBranch === b) && (d === 'all' || r.cwd === d));
  if (!filtered.length && observedRuns.length) {
    observedEls.empty.style.display = 'none';
    observedEls.list.innerHTML = '<p class="muted" style="padding:12px;font-size:12px">No runs match this filter.</p>';
  } else {
    renderObservedList(filtered);
  }
  if (obsFilterEls.count) {
    obsFilterEls.count.textContent = !observedRuns.length
      ? ''
      : (b === 'all' && d === 'all')
        ? `${observedRuns.length} run${observedRuns.length === 1 ? '' : 's'}`
        : `${filtered.length} of ${observedRuns.length} runs`;
  }
}

obsFilterEls.branch?.addEventListener('change', applyObservedFilters);
obsFilterEls.dir?.addEventListener('change', applyObservedFilters);

const TIER_COLORS = { haiku: '#2fb888', sonnet: '#d99a2b', opus: '#22a5c7', fable: '#8b5cf6' };
function tierColor(tier) { return TIER_COLORS[tier] || '#666'; }

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'ok') return 'obs-run-status-completed';
  if (s === 'running')  return 'obs-run-status-running';
  if (s === 'error')    return 'obs-run-status-error';
  return 'obs-run-status-unknown';
}

function renderObservedList(runs) {
  if (!runs || !runs.length) {
    observedEls.list.innerHTML = '';
    observedEls.empty.style.display = '';
    if (obsFilterEls.bar) obsFilterEls.bar.hidden = true;       // no clutter when empty
    if (obsFilterEls.count) obsFilterEls.count.textContent = '';
    return;
  }
  observedEls.empty.style.display = 'none';
  // A tight, headed table (Geist/Vercel-ish): sticky subtle header, hairline row
  // dividers, right-aligned mono numbers. Each run is a <tbody> holding a summary row
  // + a hidden detail row that unfurls in place. (Purely presentational — revertible.)
  const colgroup = '<colgroup>'
    + '<col style="width:26px"><col style="width:32%"><col style="width:17%"><col style="width:11%">'
    + '<col style="width:10%"><col style="width:12%"><col style="width:11%"></colgroup>';
  const head = '<thead><tr>'
    + '<th aria-hidden="true"></th><th>Workflow</th><th>When</th><th>Status</th>'
    + '<th class="num">Agents</th><th class="num">Cost</th><th class="num">Wall</th>'
    + '</tr></thead>';
  const bodies = runs.map((r) => {
    const branchDir = [r.gitBranch ? esc(r.gitBranch) : '', r.cwd ? esc(homeAbbrev(r.cwd)) : ''].filter(Boolean).join(' · ');
    const nameTitle = r.scriptPath ? `Workflow file: ${r.scriptPath}` : (r.name || r.runId);
    return `<tbody class="obs-run-item" data-run-id="${esc(r.runId)}">`
      + `<tr class="obs-run-row" tabindex="0" role="button" aria-expanded="false" aria-label="Toggle detail for ${esc(r.name || r.runId)}">`
      + `<td class="wf-chev"><span class="obs-run-chevron" aria-hidden="true">▶</span></td>`
      + `<td class="wf-name"><span class="obs-run-name" title="${esc(nameTitle)}">${esc(r.name || r.runId)}</span></td>`
      + `<td class="wf-when" title="${esc(branchDir)}">${esc(fmtWhen(r))}</td>`
      + `<td><span class="obs-run-status ${esc(statusClass(r.status))}">${esc(r.status || 'unknown')}</span></td>`
      + `<td class="num">${r.agentCount || 0}</td>`
      + `<td class="num" title="$${Number(r.costUsd || 0).toFixed(6)}">${fmtUsdShort(r.costUsd || 0)}</td>`
      + `<td class="num">${fmtMs(r.durationMs || 0)}</td>`
      + `</tr>`
      + `<tr class="obs-run-detail-row" hidden><td colspan="7"><div class="obs-run-detail"></div></td></tr>`
      + `</tbody>`;
  }).join('');
  observedEls.list.innerHTML = `<table class="wf-table">${colgroup}${head}${bodies}</table>`;
}

async function loadObservedList() {
  try {
    const runs = await apiFetch('/v1/observed');
    observedRuns = runs;
    populateObservedFilters(runs);
    populateObsContext(runs);
    applyObservedFilters();
    if (!runs.length) setWatchingHint('observed-empty-hint');
  } catch (err) {
    observedEls.list.innerHTML = `<p class="muted" style="padding:12px">Could not load observed runs: ${esc(err.message)}</p>`;
  } finally {
    // Render generation marker: navigateToRun must NOT act on rows from a previous
    // render — expanding a stale row that this reload is about to wipe was walker
    // finding F-064 (repeat navigation silently failed / flashed the wrong row).
    if (observedEls.list) observedEls.list.dataset.renderGen = String((Number(observedEls.list.dataset.renderGen) || 0) + 1);
  }
}

// Tell the user which session dir the dashboard is watching (or that none is set).
async function setWatchingHint(elId) {
  const el = document.getElementById(elId); if (!el) return;
  try {
    const h = await apiFetch('/v1/health');
    const dir = h?.bridge?.sessionDir;
    el.innerHTML = dir
      ? `Watching <code>${esc(homeAbbrev(dir))}</code>`
      : 'Not watching a session — set <code>WFLENS_SESSION_DIR</code>.';
  } catch { el.textContent = ''; }
}

// Shared tidy empty-state block (matches the static Workflows empty state).
function ctEmptyHtml(title, sub, hintHtml) {
  return '<div class="ct-empty">'
    + '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/>'
    + '<path d="M6 8.2v3.3a2 2 0 0 0 2 2h2M18 8.2v3.3a2 2 0 0 1-2 2h-2"/></svg>'
    + `<div class="ct-empty-title">${esc(title)}</div>`
    + `<div class="ct-empty-sub">${esc(sub)}</div>`
    + (hintHtml ? `<div class="ct-empty-hint">${hintHtml}</div>` : '')
    + '</div>';
}

function traceChipClass(ev) {
  const map = {
    'cache-hit': 'trace-cache-hit',
    'cap-trip':  'trace-cap-trip',
    'reroute':   'trace-reroute',
    'shunt':     'trace-shunt',
    'escape':    'trace-escape',
    'beacon-fail': 'trace-beacon-fail',
    'enter':     'trace-enter',
    'return':    'trace-enter',
  };
  return map[ev] || 'trace-enter';
}

function buildTracesStrip(traceRecords) {
  if (!traceRecords || !traceRecords.length) return '';
  const chips = traceRecords.map((t) => {
    const cls = traceChipClass(t.ev);
    const label = [t.ev, t.label && t.label !== '__unknown__' ? esc(t.label) : '', t.from && t.to ? `${esc(t.from)}->${esc(t.to)}` : ''].filter(Boolean).join(' ');
    return `<span class="trace-chip ${esc(cls)}" title="${esc(JSON.stringify(t))}">${esc(label)}</span>`;
  }).join('');
  return `<div class="traces-strip" aria-label="WFLENS_TRACE events" style="margin-top:10px">${chips}</div>`;
}

function buildBeaconsStrip(beacons) {
  if (!beacons || !beacons.length) return '';
  const chips = beacons.map((b) => {
    const label = [b.ev, b.phase || ''].filter(Boolean).join(' ');
    return `<span class="beacon-chip" title="${esc(JSON.stringify(b))}">${esc(label)}</span>`;
  }).join('');
  return `<div class="beacons-strip" aria-label="Beacon events" style="margin-top:8px">${chips}</div>`;
}

// Build the inline detail HTML for one observed run: context line (when · branch ·
// dir) + stat cards + timeline + per-call table + trace/beacon strips + an empty
// drill-in slot. Returned as a string and injected into the row's .obs-run-detail.
function buildDetailHtml(run) {
  const tel = run.telemetry || {};
  const r = tel.run || {};
  const calls = tel.calls || [];

  // The run row already shows when · branch · dir, so don't repeat it here. Instead the
  // detail leads with a link to the workflow's source (the script the harness ran).
  const wfName = esc(run.meta?.name || run.runId || '');
  const wfPathTitle = run.scriptPath ? `Workflow file: ${run.scriptPath} — click to view source` : 'View the workflow script that produced this run';
  const sourceLink = `<div class="obs-detail-context"><span class="wf-source-link" data-script="${esc(run.runId)}" title="${esc(wfPathTitle)}">📄 ${wfName} — view workflow source</span>`
    + ` <span class="opt-copy"><button class="seg-mini-btn opt-btn" type="button" data-copy-optimize="workflow" data-optimize-run="${esc(run.runId)}" title="Copy a prompt asking Claude Code to optimize THIS workflow (it can edit the script file directly)">⧉ copy optimization prompt</button><button class="opt-view" type="button" data-view-optimize="workflow" data-optimize-run="${esc(run.runId)}">view</button></span></div>`;

  const stat = (n, label, desc) => `<div class="stat-card" title="${esc(desc)}"><div class="stat-n">${n}</div><div class="stat-label">${label}</div></div>`;
  const cards = '<div class="stat-cards stat-cards-sm">'
    + stat(String(r.calls ?? calls.length ?? 0), 'Agent Calls', 'How many agents this workflow run executed (each agent() call in the workflow).')
    + stat('$' + Number(r.costUsd || 0).toFixed(6), 'Cost (cache-aware)', 'Total reconstructed cost across all agents. Cache-aware: cache_creation tokens ×1.25, cache_read ×0.10. An estimate from price tables, not a billed amount.')
    + stat(fmtN(r.inTok || 0) + ' / ' + fmtN(r.outTok || 0), 'Tok In / Out', 'Total input / output tokens summed across every agent in this run.')
    + stat(fmtMs(r.wallMs || run.durationMs || 0), 'Wall-Clock', 'Real elapsed time from the first agent starting to the last agent finishing — overlap counted once (so parallel agents do not inflate it).')
    + stat((r.speedup || 1) + '×', 'Speedup', 'Sum of every agent’s own duration ÷ wall-clock. How much faster the run was than executing all agents one-after-another; ~1× means sequential, higher means more parallelism.')
    + '</div>';

  return ''
    + sourceLink
    + cards
    + '<section style="margin:14px 0">'
    +   '<div style="font-size:13px;color:var(--gray-1000);margin-bottom:6px">Timeline <span style="color:var(--gray-900);font-size:11px">— each agent split into inference vs tool time, from real transcript timestamps</span></div>'
    +   `<div style="background:var(--bg-100);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto">${buildTimelineSvg(calls)}</div>`
    +   timelineLegend(calls)
    +   '<div class="muted" style="font-size:11px;margin-top:4px">Hover a segment to see what it is. Click a <strong>segment</strong> for that exact tool call / inference step (right); click an <strong>agent name</strong> for the full subagent details (below).</div>'
    + '</section>'
    + '<div class="obs-call-detail" hidden style="margin:14px 0;background:var(--gray-100);border:1px solid var(--border);border-radius:8px;padding:12px"></div>'
    + buildCallsTable(calls)
    + buildTracesStrip(run.traceRecords || [])
    + buildBeaconsStrip(run.beacons || [])
    + '<p class="observed-caveat label-13 muted" style="margin-top:12px">Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10); timing is derived from transcript timestamps. Neither is a live billing API value.</p>';
}

// Per-call table (cache columns); rows carry data-call-idx for the inline drill-in.
function buildCallsTable(calls) {
  const colgroup = '<colgroup>'
    + '<col style="width:4%"><col style="width:18%"><col style="width:14%"><col style="width:10%"><col style="width:8%">'
    + '<col style="width:7%"><col style="width:7%"><col style="width:9%"><col style="width:9%"><col style="width:14%">'
    + '</colgroup>';
  const head = colgroup + '<thead><tr><th>#</th><th>Label</th><th>Tier / Model</th><th>Phase</th><th class="num">ms</th><th class="num">In</th><th class="num">Out</th><th class="num cache-col">Cache Wr</th><th class="num cache-col">Cache Rd</th><th class="num">Cost (cache)</th></tr></thead>';
  const body = !calls.length
    ? '<tr><td colspan="10" class="muted" style="text-align:center;padding:16px">No call data available.</td></tr>'
    : calls.map((c, i) => `
      <tr data-call-idx="${i}" style="cursor:pointer">
        <td class="mono">${esc(String(c.id || ''))}</td>
        <td class="mono" title="${esc(c.agentId || '')}">${esc(c.label || '')}</td>
        <td title="${esc(c.tier || '')}"><span class="tier-dot" style="background:${esc(tierColor(c.tier))}"></span> <span class="mono">${esc((c.model || '').replace('claude-', '') || c.tier || '—')}</span></td>
        <td class="mono">${esc(c.phase || '—')}</td>
        <td class="num mono">${fmtMs(c.ms)}</td>
        <td class="num mono" title="${fmtN(c.inTok)}">${fmtNshort(c.inTok)}</td>
        <td class="num mono" title="${fmtN(c.outTok)}">${fmtNshort(c.outTok)}</td>
        <td class="num mono cache-col" title="cache_creation: ${fmtN(c.cacheCreationTok || 0)}">${fmtNshort(c.cacheCreationTok || 0)}</td>
        <td class="num mono cache-col" title="cache_read: ${fmtN(c.cacheReadTok || 0)}">${fmtNshort(c.cacheReadTok || 0)}</td>
        <td class="num mono" title="${fmtUsd(c.costUsd)}">${fmtUsdShort(c.costUsd)}</td>
      </tr>`).join('');
  return `<div class="call-table-wrap"><table class="call-table" aria-label="Observed per-call telemetry">${head}<tbody>${body}</tbody></table></div>`;
}

// Inference-vs-tool segment colors (also used by the legend in the detail view).
const SEG_COLOR = { inference: '#3b82f6', tool: '#f59e0b' };

// Static concurrent-agent timeline — bars span each call's real startMs→endMs (from
// transcript timestamps). Each bar is split into color-coded segments: inference
// (model time) vs tool (tool execution), proportional to real per-span durations.
// A leading tier dot preserves the model tier. Bars/labels carry data-call-idx.
function buildTimelineSvg(calls) {
  if (!calls || !calls.length) return '<div class="muted" style="padding:8px;font-size:12px">No timeline data.</div>';
  const maxEnd = Math.max(1, ...calls.map((c) => c.endMs || 0));
  const W = 920, rowH = 26, padL = 150, padR = 90, innerW = W - padL - padR;
  const H = calls.length * rowH + 14;
  const xOf = (ms) => padL + (Math.max(0, ms) / maxEnd) * innerW;
  const barH = rowH - 11;
  const bars = calls.map((c, i) => {
    const y = 8 + i * rowH;
    const bx = xOf(c.startMs || 0);
    const bw = Math.max(2, xOf(c.endMs || (c.startMs || 0)) - bx);
    const label = esc((c.label || '').slice(0, 22));
    const segs = Array.isArray(c.segments) ? c.segments : [];
    const segTotal = segs.length ? segs[segs.length - 1].endMs - segs[0].startMs : 0;

    let bar;
    if (segs.length && segTotal > 0) {
      // Map each segment's real-time offset proportionally onto the agent's bar.
      bar = segs.map((s, si) => {
        const f0 = (s.startMs - segs[0].startMs) / segTotal;
        const f1 = (s.endMs - segs[0].startMs) / segTotal;
        const sx = bx + f0 * bw;
        const sw = Math.max(1, (f1 - f0) * bw);
        const segTools = esc((s.tools || []).join(', '));
        // data-seg-* feed the hover tooltip; data-seg-idx opens THAT step's detail.
        return `<rect role="button" aria-label="${s.kind === 'tool' ? 'Tool execution' : 'Inference'} step ${si + 1} · ${fmtMs(s.endMs - s.startMs)} — click for detail" data-call-idx="${i}" data-seg-idx="${si}" data-seg-kind="${s.kind}" data-seg-dur="${(s.endMs - s.startMs).toFixed(0)}" data-seg-tools="${segTools}" data-seg-label="${esc(c.label || '')}" x="${sx.toFixed(1)}" y="${y + 4}" width="${sw.toFixed(1)}" height="${barH}" fill="${SEG_COLOR[s.kind] || SEG_COLOR.inference}" style="cursor:pointer"></rect>`;
      }).join('');
      // hairline frame so adjacent same-color runs still read as one bar (non-interactive)
      bar += `<rect x="${bx}" y="${y + 4}" width="${bw}" height="${barH}" rx="2" fill="none" stroke="var(--border)" stroke-width="0.5" style="pointer-events:none"></rect>`;
      // ⚠ refusal-fallback flags: a marker at the exact step where Fable refused or the
      // request was re-served by the fallback model. Clicking it opens that step.
      bar += segs.map((s, si) => {
        const d = s.detail || {};
        if (!d.fallback && !d.refusal) return '';
        const f0 = (s.startMs - segs[0].startMs) / segTotal;
        const mx = bx + f0 * bw;
        const what = d.fallback
          ? `Switched off Fable here — re-served by ${(d.fallback.to || 'the fallback model').replace(/^claude-/, '')}`
          : `Fable refused here (safety classifier${d.refusal && d.refusal.category ? ': ' + d.refusal.category : ''})`;
        return `<g role="button" data-call-idx="${i}" data-seg-idx="${si}" style="cursor:pointer">`
          + `<line x1="${mx.toFixed(1)}" y1="${y - 1}" x2="${mx.toFixed(1)}" y2="${y + 4 + barH + 1}" stroke="#f59e0b" stroke-width="1.5"></line>`
          + `<text x="${mx.toFixed(1)}" y="${y + 1}" text-anchor="middle" style="font-size:9.5px">⚠️</text>`
          + `<title>${esc(what)} — click for the step detail</title></g>`;
      }).join('');
    } else {
      // Fallback: no per-segment data → single tier-colored bar.
      bar = `<rect data-call-idx="${i}" x="${bx}" y="${y + 4}" width="${bw}" height="${barH}" rx="3" fill="${tierColor(c.tier)}" opacity="0.88" style="cursor:pointer"><title>${esc(c.label || '')} · ${fmtMs(c.ms)} · ${fmtUsd(c.costUsd)}</title></rect>`;
    }

    const toolPct = (c.inferenceMs + c.toolMs) > 0 ? Math.round((100 * c.toolMs) / (c.inferenceMs + c.toolMs)) : null;
    const trailing = toolPct == null ? fmtMs(c.ms) : `${fmtMs(c.ms)} · ${toolPct}% tool`;
    return `<circle cx="10" cy="${y + 4 + barH / 2}" r="4" fill="${tierColor(c.tier)}"><title>${esc(c.tier || '')}</title></circle>`
      + `<text data-call-idx="${i}" data-drill="inline" x="${padL - 8}" y="${y + 14}" text-anchor="end" style="cursor:pointer;font-size:11.5px;fill:var(--gray-1000)"><title>Click the name for the full trace below</title>${label}</text>`
      + bar
      + `<text x="${bx + bw + 6}" y="${y + 14}" style="font-size:10px;fill:var(--gray-900)">${trailing}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto">${bars}</svg>`;
}

// Legend for the timeline: the bar SEGMENTS (inference vs tool, squares) and the leading
// per-agent MODEL-TIER dots (round). Only the tiers actually present are shown.
function timelineLegend(calls) {
  const sw = (color, text, round) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px">`
    + `<span style="width:11px;height:11px;border-radius:${round ? '50%' : '2px'};background:${color};display:inline-block"></span>`
    + `<span style="font-size:11px;color:var(--gray-900)">${text}</span></span>`;
  let html = `<div style="margin-top:6px">${sw(SEG_COLOR.inference, 'Inference (model)')}${sw(SEG_COLOR.tool, 'Tool execution')}</div>`;
  const order = ['opus', 'sonnet', 'haiku', 'fable'];
  const present = Array.isArray(calls) ? [...new Set(calls.map((c) => c.tier).filter(Boolean))] : order;
  const tiers = order.filter((t) => present.includes(t)).concat(present.filter((t) => !order.includes(t)));
  if (tiers.length) {
    html += `<div style="margin-top:4px"><span style="font-size:11px;color:var(--gray-700);margin-right:8px">Model tier (dot):</span>`
      + tiers.map((t) => sw(tierColor(t), esc(t), true)).join('') + `</div>`;
  }
  return html;
}

// Inline drill-in for one agent call: the task it received, its output + metadata.
// Renders into the passed slot (scoped to a single accordion item). The Close button
// carries data-close-call so the list's delegated handler hides this slot.
function renderCallDetailInto(slot, c) {
  if (!slot || !c) return;
  slot.hidden = false;
  const kv = (k, v) => `<span style="white-space:nowrap"><span style="color:var(--gray-700)">${esc(k)}</span> <span class="mono" style="color:var(--gray-1000)">${esc(String(v))}</span></span>`;
  const meta = [
    kv('model', (c.model || '').replace('claude-', '') || c.tier || '—'),
    kv('phase', c.phase || '—'),
    kv('wall', fmtMs(c.ms)),
    kv('cost', fmtUsd(c.costUsd)),
    kv('tok', fmtN(c.inTok) + '→' + fmtN(c.outTok)),
    kv('cache', fmtN(c.cacheCreationTok || 0) + 'wr/' + fmtN(c.cacheReadTok || 0) + 'rd'),
    kv('turns', String(c.turns || 0)),
    kv('tool calls', String(c.toolCalls || 0)),
    kv('tools', (c.tools || []).join(', ') || '—'),
  ].join('<span style="color:var(--gray-500)"> · </span>');

  // Full trace: every inference span + tool call in order, with durations.
  const segs = Array.isArray(c.segments) ? c.segments : [];
  const traceRows = segs.map((s, n) => {
    const isTool = s.kind === 'tool';
    const dot = isTool ? SEG_COLOR.tool : SEG_COLOR.inference;
    // A tool step is the OUTPUT of the inference right above it — chain them visually:
    // inference rows preview what they decided to run; tool rows indent under them.
    const decided = !isTool && segs[n + 1] && segs[n + 1].kind === 'tool' && segs[n + 1].tools && segs[n + 1].tools.length
      ? `<span class="trace-decided">→ ${esc(segs[n + 1].tools.join(', '))}</span>` : '';
    const name = isTool
      ? (s.tools && s.tools.length ? 'Tool · ' + esc(s.tools.join(', ')) : 'Tool execution')
      : 'Inference';
    return `<div class="trace-row${isTool ? ' trace-row-tool' : ''}" data-trace-idx="${n}" title="Click to see exactly what this step did">`
      + `<span class="mono" style="color:var(--gray-500);min-width:22px;text-align:right">${n + 1}</span>`
      + (isTool ? '<span class="trace-connector">└</span>' : '')
      + `<span class="tl-tip-dot" style="background:${dot}"></span>`
      + `<span style="color:var(--gray-1000);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}${decided}</span>`
      + `<span class="mono" style="color:var(--gray-900)">${fmtMs(s.endMs - s.startMs)}</span></div>`;
  }).join('');
  const traceSection = segs.length
    ? `<div style="font-size:12px;color:var(--gray-900);margin-bottom:4px">Trace — ${segs.length} steps (inference &amp; tool calls, in order)</div>`
      + `<div style="background:var(--bg-200);border:1px solid var(--border);border-radius:6px;max-height:240px;overflow:auto;margin:0 0 10px">${traceRows}</div>`
    : '';

  slot.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">`
    + `<div style="font-size:14px;color:var(--gray-1000)"><span class="tier-dot" style="background:${esc(tierColor(c.tier))}"></span> ${esc(c.label || '')} <span class="muted" style="font-size:11px">— full trace</span></div>`
    + `<button class="btn btn-tertiary btn-sm" type="button" data-close-call="1">Close</button></div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px;font-size:12px">${meta}</div>`
    + traceSection
    + `<div style="font-size:12px;color:var(--gray-900);margin-bottom:4px">Task — the prompt this agent received</div>`
    + `<pre style="background:var(--bg-200);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;max-height:240px;overflow:auto;color:var(--gray-1000);margin:0 0 10px">${esc(c.task || '(no prompt captured)')}</pre>`
    + conversationHtml(c)
    + `<div style="font-size:12px;color:var(--gray-900);margin-bottom:4px">Output — its last assistant text</div>`
    + `<pre style="background:var(--bg-200);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;max-height:200px;overflow:auto;color:var(--gray-1000);margin:0">${esc(c.output || '(no text output — tool-only turn)')}</pre>`;
  currentTraceDetail = c; // trace-row clicks resolve their step against this detail
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
// The full back-and-forth (every user↔assistant text, in order) — collapsed by default.
let currentTraceDetail = null;
function conversationHtml(c) {
  const conv = c.conversation || [];
  if (!conv.length) return '';
  const rows = conv.map((t) => `<div class="conv-turn conv-${t.role === 'user' ? 'user' : 'asst'}">`
    + `<span class="conv-role">${t.role === 'user' ? 'user' : 'agent'}</span>`
    + `<pre class="conv-text">${esc(t.text || '')}</pre></div>`).join('');
  const dropped = c.droppedTurns ? `<div class="muted" style="font-size:11px;padding:4px 6px">${fmtN(c.droppedTurns)} earlier turn${c.droppedTurns === 1 ? '' : 's'} not shown (showing the most recent ${fmtN(conv.length)}).</div>` : '';
  return `<details class="conv-details"><summary>Conversation — every agent ↔ user text, in order (${fmtN(conv.length)}${c.droppedTurns ? ' of ' + fmtN(conv.length + c.droppedTurns) : ''} turns)</summary>`
    + `<div class="conv-scroll">${dropped}${rows}</div></details>`;
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-trace-idx]');
  if (!t || !currentTraceDetail) return;
  const seg = (currentTraceDetail.segments || [])[Number(t.dataset.traceIdx)];
  if (seg) openCallDrawer(currentTraceDetail, seg);
});

// Expand/collapse one accordion item; lazy-fetch + cache the run on first open.
async function toggleItem(item) {
  if (!item) return;
  const row = item.querySelector('.obs-run-row');
  const detailRow = item.querySelector('.obs-run-detail-row'); // the <tr> that unfurls
  const detail = item.querySelector('.obs-run-detail');        // the div we fill
  const chev = item.querySelector('.obs-run-chevron');
  if (!row || !detail || !detailRow) return;

  const setOpen = (rw, dr, cv, open) => {
    dr.hidden = !open;
    rw.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (cv) cv.textContent = open ? '▼' : '▶';
  };

  if (row.getAttribute('aria-expanded') === 'true') { setOpen(row, detailRow, chev, false); return; }

  // accordion: collapse any other open item so the page stays tidy
  observedEls.list.querySelectorAll('.obs-run-item').forEach((other) => {
    if (other === item) return;
    const orow = other.querySelector('.obs-run-row');
    if (orow && orow.getAttribute('aria-expanded') === 'true') {
      setOpen(orow, other.querySelector('.obs-run-detail-row'), other.querySelector('.obs-run-chevron'), false);
    }
  });

  let run = runCache.get(item.dataset.runId);
  if (!run) {
    detail.innerHTML = '<div class="muted" style="padding:12px;font-size:12px">Loading…</div>';
    setOpen(row, detailRow, chev, true);
    try {
      run = await apiFetch(`/v1/observed/${encodeURIComponent(item.dataset.runId)}`);
      runCache.set(item.dataset.runId, run);
    } catch (err) {
      detail.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">Could not load run: ${esc(err.message)}</div>`;
      return;
    }
  }
  detail.innerHTML = buildDetailHtml(run);
  setOpen(row, detailRow, chev, true);
}

// Refresh button — clear the cache so re-expanding re-fetches fresh data
observedEls.btnRefresh.addEventListener('click', () => { runCache.clear(); loadObservedList(); });

// Subscribe to the observed SSE stream for live beacon updates
function subscribeObservedStream() {
  try {
    const es = new EventSource('/v1/observed/stream');
    es.addEventListener('beacon', () => {
      // A beacon arrived — refresh the list (could add a run)
      loadObservedList();
    });
    es.onerror = () => {
      // Non-fatal — bridge may not be fully configured; retry after 10s
      es.close();
      setTimeout(subscribeObservedStream, 10_000);
    };
  } catch {
    // EventSource not supported or bridge not configured; silently skip
  }
}
subscribeObservedStream();

// ── Bootstrap ────────────────────────────────────────────────────────────────

// ── Tab switching: Control (shim) vs Observe (native) ──────────────────────────
// ── Subagents view (parent→child tree of direct Task/Agent subagents) ──────────
const MAIN_SESSION_ID = '__MAIN_SESSION__';
const subEls = {
  wrap: () => document.getElementById('subagents-table-wrap'),
  context: () => document.getElementById('sub-context'),
  rollup: () => document.getElementById('sub-rollup'),
  types: () => document.getElementById('sub-types'),
  graph: () => document.getElementById('subagents-graph-wrap'),
  slot: () => document.querySelector('.sub-call-detail'),
};
const subCache = new Map();        // agentId -> /v1/subagents/:id detail
let subForest = null;              // last { sessionId, root, rollup, cwd, gitBranch }
let subFlatten = false;
let subView = 'tree';              // 'tree' | 'timeline' | 'table'
let subSelectedId = null;          // highlighted node in the graph
let currentSubDetail = null;       // the selected subagent's detail (for segment-click → drawer)
const subCollapsed = new Set();    // agentIds whose subtree is collapsed
const subFanExpanded = new Set();  // parent ids whose capped fan-out was expanded to full

function walkForest(node, fn) { if (!node) return; fn(node); for (const k of (node.children || [])) walkForest(k, fn); }
function allSubNodes(root) { const out = []; walkForest(root, (n) => { if (n.agentId !== MAIN_SESSION_ID) out.push(n); }); return out; }

async function loadSubagentTree() {
  const wrap = subEls.wrap(); if (!wrap) return;
  wrap.innerHTML = '<p class="muted" style="padding:12px;font-size:12px">Loading subagents…</p>';
  let data;
  try { const res = await fetch('/v1/subagents'); data = await res.json(); }
  catch (err) { wrap.innerHTML = `<p class="muted" style="padding:12px">Could not load subagents: ${esc(err.message)}</p>`; return; }
  subForest = data;
  renderSubHeader(data);
  // Expand/Collapse all only do anything when some subagent has children (nesting).
  // In a flat forest they'd be silent no-ops — disable them and say why.
  {
    let collapsible = false;
    walkForest(data && data.root, (n) => { if (n.agentId !== MAIN_SESSION_ID && (n.childCount || 0) > 0) collapsible = true; });
    for (const id of ['sub-expand-all', 'sub-collapse-all']) {
      const b = document.getElementById(id);
      if (b) { b.disabled = !collapsible; b.title = collapsible ? '' : 'Nothing to fold — all subagents here are direct children (no nesting)'; }
    }
  }
  if (!data || !data.root || !data.rollup || data.rollup.totalSubagents === 0) {
    const hint = data?.cwd ? `Watching <code>${esc(homeAbbrev(data.cwd))}</code>` : (data?.sessionId ? '' : 'Set <code>WFLENS_SESSION_DIR</code> to a session dir.');
    const g = subEls.graph(); if (g) g.hidden = true;
    wrap.hidden = false;
    wrap.innerHTML = ctEmptyHtml(
      'No subagents in this session',
      'Subagents you launch with the Task/Agent tool appear here as a parent → child tree. (Subagents spawned inside a Workflow show under the Workflows tab.)',
      hint,
    );
    return;
  }
  // Default expand: MAIN + roots + their direct children visible; deeper subtrees collapsed.
  subCollapsed.clear();
  subFanExpanded.clear();
  walkForest(data.root, (n) => { if ((n.depth || 0) >= 2 && n.childCount > 0) subCollapsed.add(n.agentId); });
  renderSubView();
}

// Dispatch the active Subagents view (tree graph / timeline swimlane / table).
function renderSubView() {
  const tableWrap = subEls.wrap(); const graphWrap = subEls.graph();
  if (!subForest || !subForest.root) return;
  if (subView === 'table') {
    if (graphWrap) graphWrap.hidden = true;
    if (tableWrap) tableWrap.hidden = false;
    renderSubTable();
  } else {
    if (tableWrap) tableWrap.hidden = true;
    if (graphWrap) {
      graphWrap.hidden = false;
      graphWrap.innerHTML = subView === 'timeline' ? buildSubSwimlaneSvg(subForest.root) : buildSubGraphSvg(subForest.root);
    }
  }
}

function truncTxt(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function subStatusStroke(node) {
  const s = node.orphan ? 'orphan' : (node.status || '');
  return s === 'running' ? 'var(--blue)' : s === 'orphan' ? 'var(--amber, #f59e0b)' : s === 'missing' ? 'var(--red, #ef4444)' : s === 'session' ? 'var(--gray-700)' : 'var(--green, #10b981)';
}

// Node-link SPAWN TREE (vertical, top-down): MAIN → roots → nested, honoring the same
// collapse rule as the table, with a fan-out cap. Reuses tierColor + status colors + the
// existing data-agent-id (→ selectSubagent) and data-sub-chevron (→ collapse) handlers.
function buildSubGraphSvg(root) {
  if (!root) return '';
  const COL_W = 132, ROW_H = 64, padX = 20, padTop = 16, BOX_W = 116, BOX_H = 40, FAN_CAP = 12;
  let col = 0;
  const placed = [];   // {kind, node?, parentId?, hiddenCount?, depth, _col}
  const edges = [];    // {parent, child, parentTier, dashed}

  function layout(node, depth) {
    const item = { kind: 'node', node, depth, _col: 0 };
    placed.push(item);
    const expanded = node.agentId === MAIN_SESSION_ID || !subCollapsed.has(node.agentId);
    let kids = expanded ? (node.children || []) : [];
    let fanItem = null;
    if (kids.length > FAN_CAP && !subFanExpanded.has(node.agentId)) {
      const keep = [...kids].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, FAN_CAP - 1);
      const keepSet = new Set(keep.map((k) => k.agentId));
      const shown = (node.children || []).filter((k) => keepSet.has(k.agentId)); // preserve sibling order
      fanItem = { kind: 'fan', parentId: node.agentId, depth: depth + 1, hiddenCount: kids.length - shown.length, _col: 0 };
      kids = shown;
    }
    const centers = [];
    for (const k of kids) {
      const c = layout(k, depth + 1);
      centers.push(c._col);
      edges.push({ parent: item, child: c.item, parentTier: node.tier, dashed: !!k.orphan });
    }
    if (fanItem) { fanItem._col = col++; placed.push(fanItem); centers.push(fanItem._col); edges.push({ parent: item, child: fanItem, parentTier: node.tier, dashed: false }); }
    item._col = centers.length ? (centers[0] + centers[centers.length - 1]) / 2 : col++;
    return { _col: item._col, item };
  }
  layout(root, 0);

  let maxCol = 0, maxDepth = 0;
  for (const it of placed) { maxCol = Math.max(maxCol, it._col); maxDepth = Math.max(maxDepth, it.depth); }
  const W = padX * 2 + maxCol * COL_W + BOX_W;
  const H = padTop * 2 + maxDepth * ROW_H + BOX_H;
  const bx = (it) => padX + it._col * COL_W;
  const cx = (it) => bx(it) + BOX_W / 2;
  const by = (it) => padTop + it.depth * ROW_H;

  let edgeSvg = '';
  for (const e of edges) {
    const px = cx(e.parent), py = by(e.parent) + BOX_H, ex = cx(e.child), ey = by(e.child);
    const midY = (py + ey) / 2;
    const color = e.dashed ? 'var(--amber, #f59e0b)' : tierColor(e.parentTier);
    edgeSvg += `<path d="M ${px.toFixed(1)} ${py} V ${midY.toFixed(1)} H ${ex.toFixed(1)} V ${ey}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="1.5" stroke-linecap="round"${e.dashed ? ' stroke-dasharray="3 3"' : ''}/>`;
  }

  let nodeSvg = '';
  for (const it of placed) {
    const x = bx(it), y = by(it);
    if (it.kind === 'fan') {
      nodeSvg += `<g data-expand-fan="${esc(it.parentId)}" style="cursor:pointer"><title>Show ${it.hiddenCount} more children</title>`
        + `<rect x="${x.toFixed(1)}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="var(--gray-100)" stroke="var(--border)" stroke-dasharray="4 3"/>`
        + `<text x="${(x + BOX_W / 2).toFixed(1)}" y="${y + BOX_H / 2 + 4}" text-anchor="middle" style="font-size:11px;fill:var(--gray-900)">+${it.hiddenCount} more</text></g>`;
      continue;
    }
    const n = it.node;
    const isMain = n.agentId === MAIN_SESSION_ID;
    const stroke = subStatusStroke(n);
    const sel = n.agentId === subSelectedId;
    const full = isMain ? 'main session' : (n.description || n.agentId);
    nodeSvg += `<g class="sub-gnode" data-agent-id="${esc(n.agentId)}" style="cursor:pointer">`
      + `<title>${esc(full)} · ${esc(n.tier || '')} · ${fmtMs(n.ms || 0)} · ${fmtUsdShort(n.costUsd || 0)}${n.orphan ? ' · ⚠ orphan' : ''}</title>`
      + `<rect x="${x.toFixed(1)}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="${tierColor(n.tier)}" fill-opacity="${sel ? 0.22 : 0.12}" stroke="${stroke}" stroke-width="${sel ? 2.5 : (n.orphan ? 2 : 1.25)}"/>`
      + `<circle cx="${(x + 10).toFixed(1)}" cy="${y + 12}" r="4" fill="${tierColor(n.tier)}"/>`
      + `<text x="${(x + 20).toFixed(1)}" y="${y + 16}" style="font-size:11px;fill:var(--gray-1000)">${esc(truncTxt(full, 13))}</text>`
      + `<text x="${(x + 10).toFixed(1)}" y="${y + 31}" style="font-size:9.5px;fill:var(--gray-700)">${fmtMs(n.ms || 0)} · ${fmtUsdShort(n.costUsd || 0)}</text>`;
    if ((n.childCount || 0) > 0 && !isMain) {
      const collapsed = subCollapsed.has(n.agentId);
      nodeSvg += `<g data-sub-chevron="${esc(n.agentId)}" style="cursor:pointer"><title>${collapsed ? 'Expand' : 'Collapse'} ${n.childCount} children</title>`
        + `<rect x="${(x + BOX_W - 26).toFixed(1)}" y="${y + BOX_H - 14}" width="24" height="12" rx="6" fill="var(--gray-300)"/>`
        + `<text x="${(x + BOX_W - 14).toFixed(1)}" y="${y + BOX_H - 5}" text-anchor="middle" style="font-size:8.5px;font-weight:600;fill:var(--gray-1000)">${collapsed ? ('+' + n.childCount) : '−'}</text></g>`;
    }
    nodeSvg += '</g>';
  }

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" style="max-width:none;height:auto;font-family:ui-monospace,monospace">${edgeSvg}${nodeSvg}</svg>`;
  return `<div style="overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-100);padding:8px;text-align:center">${svg}</div>${subGraphLegend()}`;
}

function subGraphLegend() {
  const dot = (c, t) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px"><span class="tier-dot" style="background:${c}"></span><span style="font-size:11px;color:var(--gray-900)">${t}</span></span>`;
  const box = (c, t) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px"><span style="width:12px;height:9px;border:1.5px solid ${c};border-radius:2px;display:inline-block"></span><span style="font-size:11px;color:var(--gray-900)">${t}</span></span>`;
  return '<div style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:3px 0">'
    + dot(tierColor('opus'), 'opus') + dot(tierColor('sonnet'), 'sonnet') + dot(tierColor('haiku'), 'haiku')
    + '<span style="width:16px"></span>'
    + box('var(--green,#10b981)', 'done') + box('var(--blue)', 'running') + box('var(--amber,#f59e0b)', 'orphan')
    + '<span style="font-size:11px;color:var(--gray-700)">· edge hue = spawning agent’s tier · dashed = parent not found</span></div>';
}

// Temporal swimlane: one bar per subagent on a shared time axis → see concurrency.
function buildSubSwimlaneSvg(root) {
  const nodes = [];
  walkForest(root, (n) => { if (n.agentId !== MAIN_SESSION_ID) nodes.push(n); });
  if (!nodes.length) return '<div class="muted" style="padding:8px;font-size:12px">No subagents.</div>';
  const starts = nodes.map((n) => n.startedAtMs || 0).filter(Boolean);
  const minStart = starts.length ? Math.min(...starts) : 0;
  const maxEnd = Math.max(1, ...nodes.map((n) => ((n.startedAtMs || minStart) - minStart) + (n.ms || 0)));
  const W = 920, rowH = 24, padL = 170, padR = 70, innerW = W - padL - padR, barH = 13;
  const H = nodes.length * rowH + 16;
  const xOf = (ms) => padL + (Math.max(0, ms) / maxEnd) * innerW;
  const rows = nodes.map((n, i) => {
    const y = 8 + i * rowH;
    const rel = (n.startedAtMs || minStart) - minStart;
    const x0 = xOf(rel), x1 = xOf(rel + (n.ms || 0));
    const bw = Math.max(2, x1 - x0);
    const label = esc(truncTxt(n.description || n.agentId, 22));
    return `<circle cx="10" cy="${y + barH / 2}" r="4" fill="${tierColor(n.tier)}"><title>${esc(n.tier || '')}</title></circle>`
      + `<text data-agent-id="${esc(n.agentId)}" x="${padL - 8}" y="${y + 11}" text-anchor="end" style="cursor:pointer;font-size:11px;fill:var(--gray-1000)">${label}</text>`
      + `<rect data-agent-id="${esc(n.agentId)}" x="${x0.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${barH}" rx="2" fill="${tierColor(n.tier)}" opacity="0.85" style="cursor:pointer"><title>${esc(n.description || n.agentId)} · ${fmtMs(n.ms || 0)} · ${fmtUsdShort(n.costUsd || 0)}</title></rect>`
      + `<text x="${(x1 + 6).toFixed(1)}" y="${y + 11}" style="font-size:9.5px;fill:var(--gray-700)">${fmtMs(n.ms || 0)}</text>`;
  }).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto">${rows}</svg>`;
  return `<div style="overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-100);padding:8px">${svg}</div>`
    + '<div class="muted" style="font-size:11px;margin-top:6px">Each bar is a subagent on a shared time axis. Overlapping bars ran concurrently; x-position ≈ when it was spawned (its first activity). Click a bar to drill in.</div>';
}

function renderSubHeader(data) {
  const ctx = subEls.context(); const roll = subEls.rollup(); const types = subEls.types();
  if (ctx) {
    // Project context first (where am I), then branch, then session — matches the Workflows view.
    const bits = [
      data?.cwd ? `<span title="${esc(data.cwd)}">${esc(homeAbbrev(data.cwd))}</span>` : '',
      data?.gitBranch ? `branch ${esc(data.gitBranch)}` : '',
      data?.sessionId ? `session ${esc(String(data.sessionId).slice(0, 8))}` : '',
    ].filter(Boolean);
    ctx.innerHTML = projectContextHtml(bits);
  }
  const r = data?.rollup;
  if (roll) {
    if (r) {
      const m = (text, desc) => `<span class="metric" title="${esc(desc)}">${text}</span>`;
      const sep = ' · ';
      roll.innerHTML = [
        m(`${r.totalSubagents} subagents`, 'Total direct subagents (spawned by the Task/Agent tool) in this session. Subagents spawned inside a Workflow are shown on the Workflows tab instead.'),
        m(`${r.rootCount} root${r.rootCount === 1 ? '' : 's'}`, 'Subagents spawned directly by the main session (depth 1) — the top level of the tree.'),
        m(`max depth ${r.maxDepth}`, 'Deepest nesting level reached: how many subagent→subagent spawn hops separate the furthest agent from the main session.'),
        m(`${r.orphanCount} orphan${r.orphanCount === 1 ? '' : 's'}`, 'Subagents whose spawning Agent tool-call could not be found in any transcript; they are re-homed under the main session and flagged. 0 is normal.'),
        m(fmtUsd(r.totalCostUsd), 'Total reconstructed cost across all subagents. Cache-aware (cache_creation ×1.25, cache_read ×0.10) — an estimate from price tables, not a billed amount.'),
        m(`${fmtN(r.totalTokens.in)}/${fmtN(r.totalTokens.out)} tok`, 'Total input / output tokens summed across every subagent.'),
        m(`span ${fmtMs(r.wallSpanMs)}`, 'Wall-clock span from the earliest subagent start to the latest subagent end (includes idle gaps; not the sum of durations).'),
      ].join(sep);
    } else { roll.innerHTML = ''; }
  }
  if (types) {
    const counts = r?.agentTypeCounts || {};
    types.innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="badge badge-gray" style="margin:0 5px 4px 0">${esc(t)} <span class="mono">${n}</span></span>`).join('');
  }
}

function subRowHtml(node) {
  const depth = node.depth || 0;
  const isMain = node.agentId === MAIN_SESSION_ID;
  const hasKids = (node.childCount || 0) > 0;
  const collapsed = subCollapsed.has(node.agentId);
  const indent = subFlatten ? 0 : depth * 16;
  // MAIN is the always-expanded structural anchor — no chevron (collapsing it would hide everything).
  const chevron = (!subFlatten && hasKids && !isMain)
    ? `<span class="obs-run-chevron" data-sub-chevron="${esc(node.agentId)}" role="button" aria-label="toggle subtree" style="cursor:pointer;display:inline-block;width:14px;user-select:none">${collapsed ? '▶' : '▼'}</span>`
    : '<span style="display:inline-block;width:14px"></span>';
  const desc = esc(isMain ? 'main session' : (node.description || node.agentId));
  const status = node.orphan ? 'orphan' : (node.status || '');
  const statusColor = status === 'running' ? 'var(--blue)' : status === 'orphan' ? 'var(--amber, #f59e0b)' : status === 'missing' ? 'var(--red, #ef4444)' : status === 'session' ? 'var(--gray-700)' : 'var(--green, #10b981)';
  // Child count is folded into the Agent cell (its own column was dropped to fit the panel).
  const kidCount = (hasKids && !subFlatten) ? ` <span style="color:var(--gray-700);font-size:10px;flex:0 0 auto">(${node.childCount})</span>` : '';
  const agentCell = `<td style="padding-left:${8 + indent}px">`
    + `<span style="display:flex;align-items:center;gap:6px;min-width:0">`
    + chevron
    + `<span class="tier-dot" style="background:${esc(tierColor(node.tier))}"></span>`
    + `<span class="tk" title="${esc(node.description || node.agentId)}"><span class="tk-in">${desc}</span></span>${kidCount}</span></td>`;
  return `<tr data-agent-id="${esc(node.agentId)}" data-depth="${depth}" style="cursor:pointer${isMain ? ';opacity:.82' : ''}">`
    + agentCell
    + `<td class="cell-sm mono" title="${esc(node.agentType || '')}">${esc(node.agentType || '')}</td>`
    + `<td class="cell-sm" style="color:${statusColor}">${esc(status)}</td>`
    + `<td class="cell-sm mono" title="${esc(node.model || '')}">${esc((node.model || '').replace('claude-', '') || node.tier || '—')}</td>`
    + `<td class="num mono">${fmtMs(node.ms || 0)}</td>`
    + `<td class="num mono" title="${fmtUsd(node.costUsd || 0)}">${fmtUsdShort(node.costUsd || 0)}</td>`
    + `<td class="num mono" title="${fmtN(node.tokens?.in || 0)} in / ${fmtN(node.tokens?.out || 0)} out">${fmtNshort(node.tokens?.in || 0)}/${fmtNshort(node.tokens?.out || 0)}</td>`
    + `<td class="cell-sm mono" title="${esc(node.startedAt || '')}">${esc(fmtWhen({ startedAt: node.startedAt }))}</td>`
    + '</tr>';
}

function subTreeRows(root) {
  const out = [];
  const visit = (node) => {
    out.push(subRowHtml(node));
    if ((node.childCount || 0) > 0 && !subCollapsed.has(node.agentId)) for (const k of node.children) visit(k);
  };
  visit(root);
  return out;
}

function renderSubTable() {
  const wrap = subEls.wrap(); if (!wrap || !subForest || !subForest.root) return;
  const rows = subFlatten
    ? allSubNodes(subForest.root).sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).map(subRowHtml)
    : subTreeRows(subForest.root);
  const colgroup = '<colgroup>'
    + '<col style="width:26%"><col style="width:10%"><col style="width:8%"><col style="width:12%">'
    + '<col style="width:10%"><col style="width:9%"><col style="width:12%"><col style="width:13%">'
    + '</colgroup>';
  const head = '<thead><tr>'
    + '<th>Agent</th><th>Type</th><th>Status</th><th>Model</th>'
    + '<th class="num">Duration</th><th class="num">Cost</th><th class="num">Tok I/O</th><th>Started</th>'
    + '</tr></thead>';
  wrap.innerHTML = `<div class="call-table-wrap"><table class="call-table" aria-label="Subagents">${colgroup}${head}<tbody>${rows.join('')}</tbody></table></div>`;
  requestAnimationFrame(() => measureTickers(wrap));
}

// Mark truncated Agent cells (.tk) and set their marquee shift/duration so the CSS
// :hover animation scrolls exactly the overflow distance at a constant speed.
function measureTickers(scope) {
  if (!scope) return;
  const tks = [...scope.querySelectorAll('.tk')];
  // One read pass (no interleaved writes → single reflow), then one write pass.
  const overflows = tks.map((tk) => {
    const inner = tk.firstElementChild;
    return inner ? inner.scrollWidth - tk.clientWidth : 0;
  });
  tks.forEach((tk, i) => {
    const over = overflows[i];
    if (over > 2) {
      tk.classList.add('tk-clip');
      tk.style.setProperty('--tk-shift', `-${over}px`);
      tk.style.setProperty('--tk-dur', `${Math.max(2.5, over / 45).toFixed(1)}s`); // ~45px/s
    } else {
      tk.classList.remove('tk-clip');
      tk.style.removeProperty('--tk-shift');
      tk.style.removeProperty('--tk-dur');
    }
  });
}

// Render one subagent's full detail into the shared slot: a clickable segmented timeline
// (segment-click → step drawer) plus the reused trace / task / output inline view.
function renderSubagentDetail(detail) {
  const slot = subEls.slot(); if (!slot || !detail) return;
  currentSubDetail = detail;
  renderCallDetailInto(slot, detail); // meta + step trace + task + output (+ Close)
  const tl = document.createElement('div');
  tl.style.margin = '4px 0 12px';
  tl.innerHTML = '<div style="font-size:12px;color:var(--gray-900);margin-bottom:4px">Timeline — inference vs tool (click a segment for the exact step)</div>'
    + `<div style="background:var(--bg-100);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto">${buildTimelineSvg([detail])}</div>`
    + timelineLegend([detail]);
  slot.insertBefore(tl, slot.children[1] || null); // after the header row
  // Breadcrumb: always know where you are and how to get back to the thread.
  const isMain = detail.agentId === MAIN_SESSION_ID || detail.isMain;
  const crumb = document.createElement('div');
  crumb.className = 'sub-crumb';
  crumb.innerHTML = `<button class="sub-crumb-btn" type="button" data-crumb-back>← all subagents</button>`
    + `<span class="sub-crumb-sep">/</span>`
    + (isMain
      ? '<span class="sub-crumb-here">main conversation (the thread itself)</span>'
      : `<button class="sub-crumb-btn" type="button" data-crumb-main title="Open the main conversation this subagent was spawned from">↑ main conversation</button>`
        + `<span class="sub-crumb-sep">/</span><span class="sub-crumb-here">this subagent</span>`);
  slot.insertBefore(crumb, slot.firstChild);
  // Clicking a row shouldn't appear to do nothing — bring the detail into view.
  requestAnimationFrame(() => slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
document.getElementById('tab-subagents')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-crumb-back]')) {
    const slot = subEls.slot(); if (slot) slot.hidden = true;
    subSelectedId = null; if (subView !== 'table') renderSubView(); // clear the selection highlight
    subEls.wrap()?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    pushNav(null); // record "back at the list" so browser Back/Forward stays coherent
    return;
  }
  if (e.target.closest('[data-crumb-main]')) selectSubagent(MAIN_SESSION_ID);
});

async function selectSubagent(agentId) {
  // Keep the graph/tree highlight in sync with what the detail actually shows —
  // a stale green "selected" node after moving on was walker finding F-035-1.
  if (subSelectedId !== agentId) { subSelectedId = agentId; if (subView !== 'table') renderSubView(); }
  let detail = subCache.get(agentId);
  if (!detail) {
    try { const res = await fetch(`/v1/subagents/${encodeURIComponent(agentId)}`); if (!res.ok) throw new Error('HTTP ' + res.status); detail = await res.json(); }
    catch (err) { const slot = subEls.slot(); if (slot) { slot.hidden = false; slot.innerHTML = `<div class="muted" style="font-size:12px">Could not load detail: ${esc(err.message)}</div>`; } return; }
    subCache.set(agentId, detail);
  }
  renderSubagentDetail(detail);
  pushNav(agentId); // drill-in gets its own history entry → browser Back closes it
}

// One delegated handler for the whole Subagents panel: drawer-close, segment → step drawer,
// chevron → collapse, row → select. Mirrors the Observed list's single-listener pattern.
const subPanel = document.getElementById('tab-subagents');
subPanel?.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-call]');
  if (closeBtn) { const slot = closeBtn.closest('.sub-call-detail'); if (slot) slot.hidden = true; return; }
  const segEl = e.target.closest('[data-seg-idx]');
  if (segEl && currentSubDetail) {
    const seg = (currentSubDetail.segments || [])[Number(segEl.dataset.segIdx)];
    if (seg) openCallDrawer(currentSubDetail, seg);
    return;
  }
  const fan = e.target.closest('[data-expand-fan]');
  if (fan) { subFanExpanded.add(fan.getAttribute('data-expand-fan')); renderSubView(); return; }
  const chev = e.target.closest('[data-sub-chevron]');
  if (chev) {
    const id = chev.getAttribute('data-sub-chevron');
    if (subCollapsed.has(id)) subCollapsed.delete(id); else subCollapsed.add(id);
    renderSubView();
    return;
  }
  const row = e.target.closest('[data-agent-id]');
  if (row) {
    subSelectedId = row.dataset.agentId;
    if (subView !== 'table') renderSubView(); // move the highlight in the graph/timeline
    selectSubagent(row.dataset.agentId);
    return;
  }
});
// Hover tooltip over the subagent detail timeline (reuses the Observed tooltip helpers).
subPanel?.addEventListener('mousemove', (e) => {
  const seg = e.target.closest('[data-seg-kind]');
  if (!seg) { if (lastTipSeg) hideSegTip(); return; }
  if (seg !== lastTipSeg) { lastTipSeg = seg; showSegTip(e, seg); } else positionSegTip(e);
});
subPanel?.addEventListener('mouseleave', hideSegTip);
// Header controls.
document.getElementById('sub-refresh')?.addEventListener('click', () => { subCache.clear(); loadSubagentTree(); });
document.getElementById('sub-expand-all')?.addEventListener('click', () => { subCollapsed.clear(); renderSubView(); });
document.getElementById('sub-collapse-all')?.addEventListener('click', () => { if (subForest?.root) { walkForest(subForest.root, (n) => { if ((n.childCount || 0) > 0 && n.agentId !== MAIN_SESSION_ID) subCollapsed.add(n.agentId); }); renderSubView(); } });
document.getElementById('sub-flatten')?.addEventListener('click', (e) => {
  // Flatten is a flat, cost-sorted LIST — only meaningful in the table; turning it on switches to Table view.
  subFlatten = !subFlatten;
  e.currentTarget.setAttribute('aria-pressed', String(subFlatten));
  e.currentTarget.classList.toggle('active', subFlatten);
  if (subFlatten) setSubView('table'); else renderSubView();
});
// View toggle: Tree | Timeline | Table.
function setSubView(v) {
  subView = v;
  document.querySelectorAll('.seg-btn[data-subview]').forEach((b) => {
    const on = b.dataset.subview === v;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('active', on);
  });
  renderSubView();
}
document.querySelectorAll('.seg-btn[data-subview]').forEach((b) => b.addEventListener('click', () => setSubView(b.dataset.subview)));

// ── Session waterfall: the main session + everything it launched, on one time axis ──
const SESSION_KIND_COLOR = { main: '#8a8f98', workflow: '#6366f1', subagent: '#14b8a6' };
let sessionView = 'waterfall';   // 'waterfall' | 'nodes'
let lastSession = null;          // cached {workflows, sub} so toggling view doesn't re-fetch
async function loadSessionWaterfall() {
  const wrap = document.getElementById('session-waterfall-wrap'); if (!wrap) return;
  wrap.innerHTML = '<p class="muted" style="padding:12px;font-size:12px">Loading session…</p>';
  let workflows = [], sub = null;
  try { [workflows, sub] = await Promise.all([apiFetch('/v1/observed'), apiFetch('/v1/subagents')]); }
  catch (err) { wrap.innerHTML = `<p class="muted" style="padding:12px">Could not load session: ${esc(err.message)}</p>`; return; }
  lastSession = { workflows, sub };
  renderSessionHeader(workflows, sub);
  renderSessionView();
  // Fetch per-workflow agent-call detail once (per-model cost), then enrich the insight bars.
  loadWfDetails().then((d) => { if (lastSession && lastSession.workflows) renderSessionInsight(lastSession.workflows, lastSession.sub, d); });
}
// Fetch + cache each workflow's /v1/observed/:id (has telemetry.calls with per-call model+cost).
// Shared by the nested node view and the session insight's per-model bar segmentation.
// The in-flight promise is memoized on lastSession so concurrent callers (initial insight
// enrichment + the Nodes view) share ONE fetch burst instead of firing duplicates.
async function loadWfDetails() {
  if (!lastSession) return new Map();
  if (lastSession.wfDetails) return lastSession.wfDetails;
  if (lastSession.wfDetailsPromise) return lastSession.wfDetailsPromise;
  const token = lastSession;
  token.wfDetailsPromise = Promise.all((token.workflows || []).map((w) =>
    apiFetch(`/v1/observed/${encodeURIComponent(w.runId)}`).then((d) => [w.runId, d]).catch(() => [w.runId, null]),
  )).then((entries) => {
    if (lastSession !== token) return (lastSession && lastSession.wfDetails) || new Map();
    token.wfDetails = new Map(entries);
    token.wfDetailsFailed = entries.filter(([, d]) => !d).length; // shown as "partial" in the insight
    return token.wfDetails;
  });
  return token.wfDetailsPromise;
}
// Lazy main-conversation trace on the Active Session tab (John: "include a trace like
// the subagents tab but for the main agent"). Fetched on first open, per session.
let mainTraceLoadedFor = null;
document.getElementById('session-main-trace')?.addEventListener('toggle', async (e) => {
  const det = e.target; if (!det.open) return;
  const body = document.getElementById('session-main-trace-body'); if (!body) return;
  if (mainTraceLoadedFor === currentSessionId && body.childElementCount) return; // cached for this session
  body.innerHTML = '<p class="muted" style="padding:10px;font-size:12px">Reconstructing the conversation…</p>';
  let detail = null;
  try { const res = await fetch(`/v1/subagents/${encodeURIComponent(MAIN_SESSION_ID)}`); if (!res.ok) throw new Error('HTTP ' + res.status); detail = await res.json(); }
  catch (err) { body.innerHTML = `<p class="muted" style="padding:10px;font-size:12px">Could not load the main trace: ${esc(err.message)}</p>`; return; }
  mainTraceLoadedFor = currentSessionId;
  detail.label = detail.label || 'main conversation';
  const inner = document.createElement('div');
  body.innerHTML = '';
  const tl = document.createElement('div');
  tl.innerHTML = '<div style="font-size:12px;color:var(--gray-900);margin:8px 0 4px">Timeline — inference vs tool (click a segment for the exact step)</div>'
    + `<div style="background:var(--bg-100);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto">${buildTimelineSvg([detail])}</div>`
    + timelineLegend([detail]);
  body.appendChild(tl);
  body.appendChild(inner);
  renderCallDetailInto(inner, detail);
});
// Timeline-segment clicks inside the main trace → the exact step (same drawer as elsewhere).
document.getElementById('session-main-trace')?.addEventListener('click', (e) => {
  const segEl = e.target.closest('[data-seg-idx]');
  if (segEl && currentTraceDetail) {
    const seg = (currentTraceDetail.segments || [])[Number(segEl.dataset.segIdx)];
    if (seg) openCallDrawer(currentTraceDetail, seg);
  }
});

async function renderSessionView() {
  const wrap = document.getElementById('session-waterfall-wrap'); if (!wrap || !lastSession) return;
  const { workflows, sub } = lastSession;
  const caveat = document.getElementById('session-waterfall-caveat'); // "Bars on a time axis" — waterfall only
  if (caveat) caveat.style.display = sessionView === 'nodes' ? 'none' : '';
  if (sessionView !== 'nodes') { wrap.innerHTML = buildSessionWaterfallSvg(workflows, sub); return; }
  // Nested node view needs each workflow's agent calls — fetch detail once, cache on lastSession.
  if (!lastSession.wfDetails) {
    wrap.innerHTML = '<p class="muted" style="padding:12px;font-size:12px">Loading nested graph…</p>';
    const token = lastSession;
    await loadWfDetails();
    if (lastSession !== token || sessionView !== 'nodes') return; // session reloaded / view switched while awaiting
  }
  wrap.innerHTML = buildSessionNodesSvg(workflows, sub, lastSession.wfDetails);
  requestAnimationFrame(applySessionNodeZoom); // fit to start
}
// (The waterfall and node views each build their own item lists — a former shared
// sessionItems() helper was dead code and was removed to prevent divergence bugs.)
function sessionLegend() {
  const sw = (c, t) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:11px;height:11px;border-radius:2px;background:${c};display:inline-block"></span><span style="font-size:11px;color:var(--gray-900)">${t}</span></span>`;
  return `<div style="margin-top:6px">${sw(SESSION_KIND_COLOR.main, 'Main conversation')}${sw(SESSION_KIND_COLOR.workflow, 'Workflow')}${sw(SESSION_KIND_COLOR.subagent, 'Subagent')}</div>`;
}

// Node/call-graph view: the main session pinned LEFT, fanning out to a vertical list of
// everything it launched on the right. Left-rooted so the root is always visible and there's
// no horizontal scroll even with a large fan-out (it scrolls vertically instead).
// Build the FULL nested tree: session → workflows → their agents; session → direct
// subagents → their nested subagents. `wfDetails` is a Map(runId → /v1/observed/:id).
function buildSessionTree(workflows, sub, wfDetails) {
  const index = new Map();
  const reg = (n) => { index.set(n.id, n); return n; };
  const root = reg({ id: 'session', kind: 'session', label: 'main session', parentId: null, children: [] });
  const wfItems = (workflows || [])
    .map((w) => ({ w, s: w.startedAt ? Date.parse(w.startedAt) : (w.timestamp && w.durationMs ? Date.parse(w.timestamp) - w.durationMs : 0) }))
    .filter((x) => x.s).sort((a, b) => a.s - b.s);
  for (const { w } of wfItems) {
    const wf = reg({ id: 'wf:' + w.runId, kind: 'workflow', label: w.name || w.runId, navKind: 'wf', navId: w.runId, cost: w.costUsd, ms: w.durationMs, parentId: root.id, children: [] });
    root.children.push(wf);
    const det = wfDetails && wfDetails.get(w.runId);
    const calls = (det && det.telemetry && det.telemetry.calls) || [];
    calls.forEach((c, i) => wf.children.push(reg({ id: wf.id + ':a' + i, kind: 'wagent', label: c.label || ('agent ' + (i + 1)), navKind: 'wf', navId: w.runId, cost: c.costUsd, ms: c.ms, tier: c.tier, parentId: wf.id, children: [] })));
  }
  const mapSub = (n, parentId) => {
    const node = reg({ id: 'sub:' + n.agentId, kind: 'subagent', label: n.description || n.agentId, navKind: 'sub', navId: n.agentId, cost: n.costUsd, ms: n.ms, tier: n.tier, parentId, children: [] });
    for (const c of (n.children || [])) node.children.push(mapSub(c, node.id));
    return node;
  };
  for (const c of ((sub && sub.root && sub.root.children) || [])) root.children.push(mapSub(c, root.id));
  return { root, index };
}
// Left-rooted layout: x = depth, y = post-order leaf row (parents centered on children).
// A node in `collapsed` is treated as a leaf — its descendants get no rows (reclaims height).
function layoutSessionTree(root, collapsed) {
  const positions = new Map();
  let rowCounter = 0, maxDepth = 0;
  const assign = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = collapsed && collapsed.has(node.id) ? [] : node.children;
    if (!kids.length) { const r = rowCounter++; positions.set(node.id, { depth, row: r }); return r; }
    const rs = kids.map((c) => assign(c, depth + 1));
    const r = (rs[0] + rs[rs.length - 1]) / 2;
    positions.set(node.id, { depth, row: r });
    return r;
  };
  assign(root, 0);
  return { positions, rows: rowCounter, maxDepth };
}

const SNODE_KC = { session: '#8a8f98', workflow: '#6366f1', wagent: '#818cf8', subagent: '#14b8a6' };
const SNODE_LEVEL_W = 200, SNODE_ROW_H = 22, SNODE_PAD_X = 12, SNODE_PAD_TOP = 12, SNODE_BOX_W = 178, SNODE_BOX_H = 17;
let sessionNestedIndex = null;    // id → node, for hover branch-highlight
let sessionTree = null;           // {root, index} for the currently-loaded data
let sessionCollapsed = new Set();  // ids of folded nodes (their children are hidden)
let sessionNodePos = null;        // VISIBLE id → {depth, row}, used for auto-scroll-into-view

// Entry point: (re)build the tree from data. Nodes-with-children default to collapsed so a
// huge session opens as a glanceable overview — but the user's fold state survives view
// toggles and refreshes: only nodes we haven't seen before get auto-collapsed.
let sessionKnownFoldIds = new Set();
function buildSessionNodesSvg(workflows, sub, wfDetails) {
  const tree = buildSessionTree(workflows, sub, wfDetails);
  if (!tree.root.children.length) return ctEmptyHtml('Nothing launched in this session yet', 'When the session runs a Workflow or spawns a subagent, it appears here.', '');
  sessionTree = tree;
  sessionNestedIndex = tree.index;
  sessionCollapsed = new Set([...sessionCollapsed].filter((id) => tree.index.has(id))); // drop stale ids
  for (const node of tree.index.values()) {
    if (node.id !== 'session' && node.children.length && !sessionKnownFoldIds.has(node.id)) sessionCollapsed.add(node.id);
  }
  sessionKnownFoldIds = new Set(tree.index.keys());
  return renderSessionNodes();
}

// Pure render from sessionTree + sessionCollapsed → zoombar + faint nested SVG + legend.
// Called both on first build and on every fold/expand toggle (no refetch).
function renderSessionNodes() {
  const tree = sessionTree; if (!tree) return '';
  const { positions, rows, maxDepth } = layoutSessionTree(tree.root, sessionCollapsed);
  sessionNodePos = positions;
  const LEVEL_W = SNODE_LEVEL_W, ROW_H = SNODE_ROW_H, padX = SNODE_PAD_X, padTop = SNODE_PAD_TOP, BOX_W = SNODE_BOX_W, BOX_H = SNODE_BOX_H, KC = SNODE_KC;
  const W = padX * 2 + (maxDepth + 1) * LEVEL_W;
  const H = padTop * 2 + Math.max(1, rows) * ROW_H;
  const edges = [], nodes = [];
  const emit = (node) => {
    const p = positions.get(node.id); if (!p) return; // hidden (ancestor collapsed)
    const px = padX + p.depth * LEVEL_W, py = padTop + p.row * ROW_H;
    const folded = sessionCollapsed.has(node.id);
    const kids = folded ? [] : node.children;
    for (const c of kids) {
      const cp = positions.get(c.id); if (!cp) continue;
      const cx = padX + cp.depth * LEVEL_W, cy = padTop + cp.row * ROW_H;
      const x1 = px + BOX_W, y1 = py + BOX_H / 2, x2 = cx, y2 = cy + BOX_H / 2, mx = (x1 + x2) / 2;
      edges.push(`<path class="sedge" data-echild="${esc(c.id)}" d="M ${x1} ${y1.toFixed(1)} H ${mx.toFixed(1)} V ${y2.toFixed(1)} H ${x2}" stroke="${KC[c.kind] || '#888'}" stroke-width="1" fill="none"/>`);
      emit(c);
    }
    const color = KC[node.kind] || '#888';
    const nav = (node.navKind && node.navId) ? ` data-nav-kind="${node.navKind}" data-nav-id="${esc(node.navId)}"` : '';
    const hasKids = node.children.length > 0 && node.id !== 'session'; // root isn't foldable
    const labelMax = hasKids ? 22 : 27;
    let fold = '';
    if (hasKids) {
      const glyph = folded ? '▸' : '▾';
      const badge = folded ? ' ' + node.children.length : '';
      fold = `<g class="sfold" data-fold="${esc(node.id)}">`
        + `<title>${folded ? 'Expand' : 'Collapse'} in place (does not navigate away)</title>`
        + `<rect x="${px + BOX_W - 30}" y="${py}" width="30" height="${BOX_H}" fill="transparent"/>`
        + `<text x="${px + BOX_W - 26}" y="${py + 12}" style="font-size:9px;fill:var(--gray-700)">${glyph}${esc(badge)}</text></g>`;
    }
    nodes.push(
      `<g class="snode" data-node-id="${esc(node.id)}"${nav} style="cursor:${nav ? 'pointer' : 'default'}">`
      + `<rect x="${px}" y="${py}" width="${BOX_W}" height="${BOX_H}" rx="3" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="0.9"/>`
      + `<circle cx="${px + 7}" cy="${py + BOX_H / 2}" r="2.4" fill="${color}"/>`
      + `<text x="${px + 14}" y="${py + 12}" style="font-size:9px;fill:var(--gray-1000)">${esc(truncTxt(node.label, labelMax))}</text>`
      + fold
      + `<title>${esc(node.label)}${node.kind !== 'session' ? ' · ' + node.kind : ''}${hasKids ? ' · ' + node.children.length + ' inside' : ''}${node.ms != null ? ' · ' + fmtMs(node.ms) : ''}${node.cost != null ? ' · ' + fmtUsdShort(node.cost) : ''}</title></g>`,
    );
  };
  emit(tree.root);
  const svg = `<svg viewBox="0 0 ${W} ${H}" data-w="${W}" data-h="${H}" width="${W}" style="height:auto;font-family:ui-monospace,monospace">${edges.join('')}${nodes.join('')}</svg>`;
  const total = tree.index.size - 1, shown = positions.size - 1;
  const allFolded = shown < total; // at least one node still collapsed
  const zoombar = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">`
    + `<button class="btn btn-tertiary btn-sm" type="button" data-nodezoom="out" aria-label="Zoom out">−</button>`
    + `<span id="node-zoom-label" class="mono" style="font-size:11px;color:var(--gray-700);min-width:42px;text-align:center"></span>`
    + `<button class="btn btn-tertiary btn-sm" type="button" data-nodezoom="in" aria-label="Zoom in">+</button>`
    + `<button class="btn btn-tertiary btn-sm" type="button" data-nodezoom="fit">Fit</button>`
    + `<span style="width:1px;height:16px;background:var(--border);margin:0 2px"></span>`
    + `<button class="btn btn-tertiary btn-sm" type="button" data-foldall="${allFolded ? 'expand' : 'collapse'}">${allFolded ? 'Expand all' : 'Collapse all'}</button>`
    + `<span class="muted" style="font-size:11px;margin-left:6px">${shown} of ${total} nodes shown · click ▸ to expand · drag/two-finger to pan · ⌘/Ctrl+scroll to zoom · hover to trace a branch</span></div>`;
  const sw = (c, t) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:11px;height:11px;border-radius:2px;background:${c};display:inline-block"></span><span style="font-size:11px;color:var(--gray-900)">${t}</span></span>`;
  const legend = `<div style="margin-top:6px">${sw(KC.workflow, 'Workflow')}${sw(KC.wagent, 'Workflow agent')}${sw(KC.subagent, 'Subagent (& nested)')}</div>`;
  return zoombar
    + `<div class="node-canvas nested" style="overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-100);padding:10px">${svg}</div>`
    + legend
    + '<div class="muted" style="font-size:11px;margin-top:6px">Everything the session ran, nested (workflow → its agents; subagent → nested). Workflows start folded — click ▸ to open one, or Expand all to see every node faintly and hover to trace a branch. Click a workflow/subagent to open it.</div>';
}

// Re-render the nested view in place after a fold/expand change, keeping the current zoom.
function rerenderSessionNodes() {
  const wrap = document.getElementById('session-waterfall-wrap'); if (!wrap || !sessionTree) return;
  wrap.innerHTML = renderSessionNodes();
  requestAnimationFrame(applySessionNodeZoom);
}
function toggleNodeCollapse(id) {
  if (sessionCollapsed.has(id)) sessionCollapsed.delete(id); else sessionCollapsed.add(id);
  rerenderSessionNodes();
}
function setAllCollapsed(collapse) {
  sessionCollapsed = new Set();
  if (collapse) for (const node of sessionTree.index.values()) { if (node.id !== 'session' && node.children.length) sessionCollapsed.add(node.id); }
  rerenderSessionNodes();
}
// Ease the hovered node's branch into view when its highlighted ancestors/leaves are off-screen.
function scrollHoveredIntoView(canvas, id) {
  const pos = sessionNodePos && sessionNodePos.get(id); if (!pos) return;
  const z = currentNodeZoom();
  const nodeY = (SNODE_PAD_TOP + pos.row * SNODE_ROW_H) * z;
  const top = canvas.scrollTop, bottom = top + canvas.clientHeight;
  if (nodeY < top + 40 || nodeY > bottom - 40) {
    canvas.scrollTo({ top: Math.max(0, nodeY - canvas.clientHeight / 2), behavior: 'smooth' });
  }
}

let sessionNodeZoom = 'fit'; // 'fit' | number
function applySessionNodeZoom() {
  const canvas = document.querySelector('#session-waterfall-wrap .node-canvas');
  const svg = canvas && canvas.querySelector('svg'); if (!svg) return;
  const W = Number(svg.getAttribute('data-w')) || 900, H = Number(svg.getAttribute('data-h')) || 600;
  let z = sessionNodeZoom;
  if (z === 'fit') {
    const availW = Math.max(140, canvas.clientWidth - 20);
    const availH = Math.max(140, canvas.clientHeight - 20);
    // The nested tree is tall & narrow — fit to WIDTH and scroll vertically so nodes stay
    // legible/hoverable; the flat view (if ever used) fits both dimensions.
    z = canvas.classList.contains('nested')
      ? Math.min(1, availW / W)
      : Math.min(1, availW / W, availH / H);
  }
  z = Math.max(0.2, Math.min(2.5, z));
  svg.style.width = (W * z).toFixed(0) + 'px';
  const lbl = document.getElementById('node-zoom-label'); if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}
function currentNodeZoom() {
  const svg = document.querySelector('#session-waterfall-wrap .node-canvas svg');
  const W = Number(svg && svg.getAttribute('data-w')) || 900;
  return svg ? (parseFloat(svg.style.width) || W) / W : 1;
}

function renderSessionHeader(workflows, sub) {
  const ctx = document.getElementById('session-context'); const roll = document.getElementById('session-rollup');
  const dir = sub?.cwd || (workflows && workflows[0] && workflows[0].cwd) || null;
  const branch = sub?.gitBranch || (workflows && workflows[0] && workflows[0].gitBranch) || null;
  const sess = sub?.sessionId || null;
  if (ctx) {
    ctx.innerHTML = projectContextHtml([
      dir ? `<span title="${esc(dir)}">${esc(homeAbbrev(dir))}</span>` : '',
      branch ? `branch ${esc(branch)}` : '',
      sess ? `session ${esc(String(sess).slice(0, 8))}` : '',
    ].filter(Boolean));
  }
  if (roll) {
    const wf = (workflows || []).length;
    const subN = sub?.rollup?.totalSubagents || 0;
    const mainCost = sub?.root?.costUsd || 0;
    const totalCost = (workflows || []).reduce((s, w) => s + (w.costUsd || 0), 0) + (sub?.rollup?.totalCostUsd || 0) + mainCost;
    const bits = [`${fmtUsdShort(totalCost)} total (est.)`];
    if (mainCost) bits.push(`main conversation ${fmtUsdShort(mainCost)}`);
    bits.push(`${wf} workflow${wf === 1 ? '' : 's'}`);
    bits.push(`${subN} subagent${subN === 1 ? '' : 's'}`);
    roll.textContent = bits.join(' · ');
  }
  renderSessionInsight(workflows, sub);
}

// DEMO: turn the bland rollup line into a plain-language readout — what happened and,
// above all, WHERE THE ESTIMATED COST WENT (a Pareto leaderboard). Pure client-side from
// data we already fetch (/v1/observed + /v1/subagents). This is the "structure → meaning" idea.
function siDur(ms) {
  if (!ms || ms < 0) return null;
  const s = ms / 1000, h = s / 3600, d = h / 24;
  if (d >= 1) return `${Math.floor(d)}d ${Math.round(h % 24)}h`;
  if (h >= 1) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${Math.round(s)}s`;
}
const MODEL_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
// Mirrors the server's tierFromModel — fable is its OWN tier ($10/$50, 2× opus).
function modelTier(m) { m = String(m || '').toLowerCase(); return m.includes('fable') ? 'fable' : m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : 'other'; }
function modelColor(tier) { return tier === 'other' ? '#8a8f98' : tierColor(tier); }
// Per-item cost split by model: {opus: $, sonnet: $, ...}. Workflows need their fetched
// telemetry.calls; subagents carry a single model. Returns null if a workflow's detail
// isn't loaded yet (→ render a plain bar until it arrives).
function itemModelSplit(item, wfDetails) {
  const m = {};
  if (item.kind !== 'workflow') { if (item.cost) m[modelTier(item.model)] = item.cost; return m; } // subagent/main: single model
  const det = wfDetails && wfDetails.get(item.navId);
  const calls = det && det.telemetry && det.telemetry.calls;
  if (!calls) return null; // not loaded yet
  for (const c of calls) { const t = modelTier(c.model || c.tier); m[t] = (m[t] || 0) + (c.costUsd || 0); }
  return m;
}
// Open-source substitutes per Anthropic tier — OpenRouter list price ($ per MILLION tokens),
// captured live 2026-07-01. Includes cached-input (cacheRd) price so the comparison is
// apples-to-apples with our cache-aware current cost. cacheWr isn't separately listed for
// these models, so it's billed at the prompt rate (small vs cacheRd, and conservative).
const SUBSTITUTE = {
  fable: { name: 'GLM-5.2', or: 'z-ai/glm-5.2', prompt: 0.93, completion: 3.00, cacheRd: 0.18 },
  opus: { name: 'GLM-5.2', or: 'z-ai/glm-5.2', prompt: 0.93, completion: 3.00, cacheRd: 0.18 },
  sonnet: { name: 'DeepSeek V4 Flash', or: 'deepseek/deepseek-v4-flash', prompt: 0.098, completion: 0.196, cacheRd: 0.02 },
  haiku: { name: 'GLM-4.7 Flash', or: 'z-ai/glm-4.7-flash', prompt: 0.06, completion: 0.40, cacheRd: 0.01 },
};
const SUBSTITUTE_ASOF = '2026-07-01';
// Anthropic list prices ($ per MILLION tokens) used for the current-cost estimate.
// Mirrors workflow-lens/src/shim.mjs PRICE; verified 2026-07-01 against the LiteLLM
// price DB + ccusage (fable-5 $10/$50 incl.). Cache-read = in × 0.10; cache-WRITE is
// priced by TTL bucket server-side: 5-minute ×1.25, 1-hour ×2.0.
const ANTHROPIC_PRICE = { fable: { in: 10, out: 50 }, opus: { in: 5, out: 25 }, sonnet: { in: 3, out: 15 }, haiku: { in: 1, out: 5 } };
// Aggregate real token usage per tier (input/output/cache) across workflow calls + direct
// subagents — needed to re-price under a substitute model. Skips workflows without loaded detail.
function sessionTierUsage(workflows, sub, wfDetails) {
  const t = {};
  // outTimed/infMs only accumulate when inference time is known → real generation tok/s.
  const add = (tier, inp, out, cw, cr, cost, infMs) => {
    const x = t[tier] || (t[tier] = { input: 0, output: 0, cacheWr: 0, cacheRd: 0, cost: 0, outTimed: 0, infMs: 0 });
    x.input += inp || 0; x.output += out || 0; x.cacheWr += cw || 0; x.cacheRd += cr || 0; x.cost += cost || 0;
    if (infMs && infMs > 0) { x.outTimed += out || 0; x.infMs += infMs; }
  };
  for (const w of (workflows || [])) {
    const det = wfDetails && wfDetails.get(w.runId);
    const calls = det && det.telemetry && det.telemetry.calls;
    if (!calls) continue;
    for (const c of calls) add(modelTier(c.model || c.tier), c.inTok, c.outTok, c.cacheCreationTok, c.cacheReadTok, c.costUsd, c.inferenceMs);
  }
  for (const c of allSubNodes(sub && sub.root)) { // full forest — nested subagents count too
    const tk = c.tokens || {}; add(modelTier(c.model), tk.in, tk.out, tk.cacheWr, tk.cacheRd, c.costUsd, c.inferenceMs);
  }
  const r = sub && sub.root; // the main conversation's own tokens count too
  if (r && r.tokens) add(modelTier(r.model), r.tokens.in, r.tokens.out, r.tokens.cacheWr, r.tokens.cacheRd, r.costUsd, r.inferenceMs);
  return t;
}
// Real measured generation throughput (tok/s) per tier = output tokens ÷ inference time.
function tierGenSpeed(usage, tier) {
  const u = usage[tier];
  return u && u.infMs > 0 ? u.outTimed / (u.infMs / 1000) : null;
}
// Hypothetical re-pricing of the session at OSS prices, CACHE-AWARE (mirrors how the current
// cost is computed): fresh input + cache-write at prompt rate, cache-read at the substitute's
// cached-input rate, output at completion rate. Apples-to-apples with the current cost.
function computeSavings(workflows, sub, wfDetails) {
  const usage = sessionTierUsage(workflows, sub, wfDetails);
  const lines = []; let cur = 0, alt = 0;
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    const u = usage[tier], s = SUBSTITUTE[tier];
    if (!u || !s || !u.cost) continue;
    const cacheRdRate = s.cacheRd != null ? s.cacheRd : s.prompt;
    const subCost = ((u.input + u.cacheWr) * s.prompt + u.cacheRd * cacheRdRate + u.output * s.completion) / 1e6;
    cur += u.cost; alt += subCost;
    lines.push({ tier, sub: s, cur: u.cost, subCost, save: u.cost - subCost });
  }
  if (!lines.length) return null;
  return { lines, cur, alt, save: cur - alt, pct: cur > 0 ? Math.round((cur - alt) / cur * 100) : 0 };
}
function renderSessionInsight(workflows, sub, wfDetails) {
  const host = document.getElementById('session-insight'); if (!host) return;
  const items = [];
  for (const w of (workflows || [])) {
    const s = w.startedAt ? Date.parse(w.startedAt) : (w.timestamp && w.durationMs ? Date.parse(w.timestamp) - w.durationMs : 0);
    const e = w.timestamp ? Date.parse(w.timestamp) : (s + (w.durationMs || 0));
    items.push({ label: w.name || w.runId, kind: 'workflow', cost: w.costUsd || 0, meta: `${w.agentCount || 0} agents`, navKind: 'wf', navId: w.runId, startMs: s, endMs: e });
  }
  for (const c of allSubNodes(sub && sub.root)) { // full forest — nested subagents count too
    const s = c.startedAtMs || (c.startedAt ? Date.parse(c.startedAt) : 0);
    const e = c.endedAt ? Date.parse(c.endedAt) : (s + (c.ms || 0));
    items.push({ label: c.description || c.agentId, kind: 'subagent', cost: c.costUsd || 0, meta: c.agentType || 'subagent', navKind: 'sub', navId: c.agentId, model: c.model, startMs: s, endMs: e });
  }
  // The main conversation is a first-class cost item — a REGULAR session with zero
  // workflows/subagents still gets a full insight card about the chat itself.
  const mainRoot = sub && sub.root;
  if (mainRoot && (mainRoot.costUsd || mainRoot.turns)) {
    const s = mainRoot.startedAtMs || 0;
    items.push({ label: 'main conversation (this chat)', kind: 'main', cost: mainRoot.costUsd || 0, meta: `${mainRoot.turns || 0} turns`, navKind: 'sub', navId: MAIN_SESSION_ID, model: mainRoot.model, startMs: s, endMs: s + (mainRoot.ms || 0) });
  }
  if (!items.length) { host.innerHTML = ''; return; }
  const total = items.reduce((a, b) => a + b.cost, 0);      // real total — displayed as-is (may be $0)
  const pctDenom = total > 0 ? total : 1;                   // division guard for percents only
  const wfCount = items.filter((i) => i.kind === 'workflow').length;
  const subCount = items.filter((i) => i.kind === 'subagent').length;
  const mainCost = items.filter((i) => i.kind === 'main').reduce((a, b) => a + b.cost, 0);
  const wfCost = items.filter((i) => i.kind === 'workflow').reduce((a, b) => a + b.cost, 0);
  const subCost = total - wfCost - mainCost;
  const starts = items.map((i) => i.startMs).filter(Boolean);
  const ends = items.map((i) => i.endMs).filter(Boolean);
  const span = (starts.length && ends.length) ? Math.max(...ends) - Math.min(...starts) : 0;
  const ranked = [...items].sort((a, b) => b.cost - a.cost);
  const maxCost = ranked[0].cost || 1;
  const pct = (c) => Math.round((c / pctDenom) * 100);
  const TOP = 5;
  const top = ranked.slice(0, TOP), rest = ranked.slice(TOP);
  let cum = 0, paretoN = 0; for (const i of ranked) { cum += i.cost; paretoN++; if (cum / pctDenom >= 0.6) break; }

  // Detail-load state: undefined = still fetching; a Map = done (nulls inside = failed fetches).
  const detailsLoaded = wfDetails instanceof Map;
  const failedDetails = detailsLoaded ? [...wfDetails.values()].filter((d) => !d).length : 0;
  const partialNote = failedDetails ? `<span class="si-legend muted"> · partial — ${failedDetails} workflow detail${failedDetails === 1 ? '' : 's'} unavailable</span>` : '';

  // Session-wide cost by model (across every item whose split is known).
  const modelTotals = {}; let modelKnown = 0;
  for (const it of items) { const sp = itemModelSplit(it, wfDetails); if (sp) { for (const [t, c] of Object.entries(sp)) modelTotals[t] = (modelTotals[t] || 0) + c; modelKnown += it.cost; } }
  const modelsPresent = MODEL_ORDER.filter((t) => modelTotals[t]);
  const legend = modelsPresent.length
    ? `<span class="si-legend">by model: ${modelsPresent.map((t) => `<span class="si-lg"><span class="si-lg-dot" style="background:${modelColor(t)}"></span>${t} ${fmtUsdShort(modelTotals[t])} (${Math.round(modelTotals[t] / (modelKnown || 1) * 100)}%)</span>`).join('')}${partialNote}</span>`
    : (wfCount ? `<span class="si-legend muted">${detailsLoaded ? 'model split unavailable' : 'computing model split…'}</span>` : '');

  // Measured generation speed per tier (real: output tokens ÷ inference time; workflow
  // agents only — the subagent list endpoint doesn't expose inference time).
  const usage = sessionTierUsage(workflows, sub, wfDetails);
  const speedTiers = MODEL_ORDER.filter((t) => tierGenSpeed(usage, t) != null);
  // Models that carry real cost here but have NO timed inference (main conversation +
  // subagents don't report per-step timing in the tree) — name them so a model can't
  // sit in the cost line yet silently vanish from the speed line (e.g. Fable).
  const untimedTiers = MODEL_ORDER.filter((t) => modelTotals[t] && tierGenSpeed(usage, t) == null);
  const untimedNote = untimedTiers.length
    ? ` <span class="si-speed-note">· ${untimedTiers.join(', ')} not timed here (spent in the main chat / subagents, which don't report per-step inference time)</span>`
    : '';
  const speedLine = speedTiers.length
    ? `<div class="si-speed" title="Output tokens ÷ model inference time, measured across this session's workflow agent calls. The main conversation and subagents don't report per-step inference time, so models spent only there (often Fable) show cost but no tok/s. Generation throughput only — excludes tool execution and prompt processing.">`
      + `measured generation speed (workflow agents): ${speedTiers.map((t) => `<span class="si-lg"><span class="si-lg-dot" style="background:${modelColor(t)}"></span>${t} <strong>${Math.round(tierGenSpeed(usage, t))}</strong></span>`).join(' · ')} tok/s <span class="si-speed-note">· output ÷ inference time, not end-to-end</span>${untimedNote}</div>`
    : (untimedTiers.length
      ? `<div class="si-speed" title="The main conversation and subagents don't report per-step inference time, so throughput can't be measured for models spent only there.">generation speed:<span class="si-speed-note"> ${untimedTiers.join(', ')} spent in the main chat / subagents — no per-step timing to measure tok/s</span></div>`
      : '');

  // Refusal-fallback rollup across the main conversation + every subagent node.
  // (Fable 5's safety classifier declines a request; Claude Code re-serves it on
  // the fallback model — sticky routing then keeps later turns there for ~1h.)
  const fbAgg = { refusals: 0, switches: 0, sticky: 0 };
  {
    const seenFb = new Set();
    const collectFb = (n) => {
      if (!n || !n.fallbacks || seenFb.has(n)) return; seenFb.add(n);
      fbAgg.refusals += n.fallbacks.refusals || 0;
      fbAgg.switches += n.fallbacks.switches || 0;
      fbAgg.sticky += (n.fallbacks.stickyTurns != null ? n.fallbacks.stickyTurns : n.fallbacks.sticky) || 0;
    };
    if (sub && sub.root) { collectFb(sub.root); for (const c of allSubNodes(sub.root)) collectFb(c); }
  }
  const fbRoot = (sub && sub.root && sub.root.fallbacks) || {};
  const shortM = (m) => String(m || '').replace(/^claude-/, '');
  const fallbackLine = (fbAgg.refusals || fbAgg.switches)
    ? `<div class="si-fallback" title="Fable 5's safety classifiers declined one or more requests (stop_reason: refusal — a mid-stream refusal still bills the discarded partial). Claude Code re-served them on the fallback model; sticky routing keeps later turns there for ~1h. Every turn is priced at the model that actually served it.">`
      + `⇄ refusal fallback: <strong>${fbAgg.refusals}</strong> refusal${fbAgg.refusals === 1 ? '' : 's'} on ${esc(shortM(fbRoot.from || 'claude-fable-5'))}`
      + ` · <strong>${fbAgg.switches}</strong> switch${fbAgg.switches === 1 ? '' : 'es'} to ${esc(shortM(fbRoot.to || 'claude-opus-4-8'))}`
      + (fbAgg.sticky ? ` · <strong>${fbAgg.sticky}</strong> sticky turn${fbAgg.sticky === 1 ? '' : 's'} served there` : '')
      + `</div>`
    : '';

  const spanTxt = siDur(span);
  const parts = [];
  if (mainCost > 0 || items.some((i) => i.kind === 'main')) parts.push('the main conversation');
  if (wfCount) parts.push(`<span style="color:var(--gray-1000)">${wfCount} workflow${wfCount === 1 ? '' : 's'}</span>`);
  if (subCount) parts.push(`<span style="color:var(--gray-1000)">${subCount} subagent${subCount === 1 ? '' : 's'}</span>`);
  const headline = `This session = ${parts.join(' + ') || 'nothing yet'} · `
    + `<span style="color:var(--gray-1000)">${fmtUsdShort(total)} estimated</span>${spanTxt ? ` · spanned ${spanTxt}` : ''}`
    + (total > 0 && items.length > 2 ? ` · the top <span style="color:var(--gray-1000)">${paretoN}</span> account for ~60% of the spend` : '');

  // Bar = width by cost share of the biggest item; internally segmented by model.
  const barHtml = (i) => {
    const w = Math.max(3, Math.round((i.cost / maxCost) * 100));
    const split = itemModelSplit(i, wfDetails);
    let inner;
    if (split && Object.keys(split).length) {
      inner = MODEL_ORDER.filter((t) => split[t]).map((t) =>
        `<span class="si-seg" style="flex:${split[t].toFixed(4)};background:${modelColor(t)}" title="${t} · ${fmtUsd(split[t])}"></span>`).join('');
    } else {
      inner = `<span class="si-seg" style="flex:1;background:#6366f1"></span>`; // pre-detail fallback
    }
    return `<span class="si-bar"><span class="si-bar-stack" style="width:${w}%">${inner}</span></span>`;
  };
  const rows = top.map((i) => `<button class="si-row" type="button" data-nav-kind="${i.navKind}" data-nav-id="${esc(i.navId)}" title="${esc(i.label)} · ${esc(i.meta)} · ${fmtUsd(i.cost)}">`
    + `<span class="si-label">${esc(truncTxt(i.label, 30))}</span>`
    + barHtml(i)
    + `<span class="si-cost">${fmtUsdShort(i.cost)}</span>`
    + `<span class="si-share">${pct(i.cost)}%</span></button>`).join('');
  const moreCost = rest.reduce((a, b) => a + b.cost, 0);
  const more = rest.length ? `<div class="si-more">+ ${rest.length} more · ${fmtUsdShort(moreCost)} (${pct(moreCost)}%)</div>` : '';

  const chip = (label, val, sub2, cls) => `<div class="si-chip${cls ? ' ' + cls : ''}"><div class="si-chip-k">${label}</div><div class="si-chip-v">${val}</div>${sub2 ? `<div class="si-chip-s">${sub2}</div>` : ''}</div>`;
  const biggest = ranked[0];
  const savings = computeSavings(workflows, sub, wfDetails);
  let chips = '';
  if (mainCost > 0) chips += chip('Main conversation', fmtUsdShort(mainCost), `${pct(mainCost)}% of spend`);
  if (wfCount) chips += chip('Workflows', fmtUsdShort(wfCost), `${pct(wfCost)}% of spend`);
  if (subCount) chips += chip('Subagents', fmtUsdShort(subCost), `${pct(subCost)}% of spend`);
  chips += chip('Biggest single', fmtUsdShort(biggest.cost), esc(truncTxt(biggest.label, 22)));
  // Chip subtitle is hedged: savings.pct's denominator is the re-priceable Claude-tier spend
  // (with loaded details), NOT the headline total — don't let it read as session-wide.
  if (savings) chips += chip('Potential savings', fmtUsdShort(savings.save), `${savings.pct}% of Claude-tier spend${failedDetails ? ' · partial' : ''}`, savings.save > 0 ? 'si-chip-save' : 'si-chip-warn');

  // Multiplier ("11× cheaper") — how many times cheaper the substitute is.
  const multTxt = (cur, alt) => {
    if (!alt || alt <= 0) return '—';
    const r = cur / alt;
    return r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× cheaper` : `${(1 / r).toFixed(1)}× pricier`;
  };

  // "What if we ran open-source models instead" panel — hypothetical, clearly labelled.
  let savePanel = '';
  if (savings) {
    const srow = (l) => `<div class="si-srow"><span class="si-lg-dot" style="background:${modelColor(l.tier)}"></span>`
      + `<span class="si-slabel">${l.tier} → ${esc(l.sub.name)}</span>`
      + `<span class="si-sfrom">${fmtUsdShort(l.cur)}</span><span class="si-sarrow">→</span><span class="si-sto">${fmtUsdShort(l.subCost)}</span>`
      + `<span class="si-ssave ${l.save >= 0 ? 'pos' : 'neg'}">${l.save >= 0 ? 'save ' : '+'}${fmtUsdShort(Math.abs(l.save))}</span>`
      + `<span class="si-smult ${l.save >= 0 ? 'pos' : 'neg'}">${multTxt(l.cur, l.subCost)}</span></div>`;
    // Collapsed by default — a one-line chevron summary carries the headline number;
    // the per-model breakdown + method live inside. Keeps the insight card scannable.
    savePanel = `<details class="si-save si-save-fold">`
      + `<summary class="si-save-sum"><span class="si-save-chev">▸</span>`
      + `<span class="si-save-head">Potential savings<a class="si-ast" href="#si-method">*</a></span>`
      + `<span class="si-save-amt">save <strong>${fmtUsdShort(savings.save)}</strong> (${savings.pct}%, ${multTxt(savings.cur, savings.alt)})</span>`
      + `<span class="si-legend muted">by swapping to open models</span></summary>`
      + `<div class="si-save-body">`
      + `<div class="si-lb-title si-save-subtitle">swap to open models <span class="si-legend muted">OpenRouter list price · ${SUBSTITUTE_ASOF}</span>${partialNote}</div>`
      + savings.lines.map(srow).join('')
      + `<div class="si-stotal">≈ <strong>${fmtUsdShort(savings.alt)}</strong> instead of <strong>${fmtUsdShort(savings.cur)}</strong> on these tiers — save <strong>${fmtUsdShort(savings.save)}</strong> (${savings.pct}%, <strong>${multTxt(savings.cur, savings.alt)}</strong>)</div>`
      + `</div></details>`;
  }

  // "*" methodology section — where every number comes from, and the idea behind it.
  let method = '';
  if (savings) {
    const curList = savings.lines.map((l) => { const p = ANTHROPIC_PRICE[l.tier]; return `<li><strong>${l.tier}</strong>: $${p.in}/M in · $${p.out}/M out · $${(p.in * 1.25).toFixed(2)}/M cache-write (in×1.25 for 5-min cache, ×2.0 for 1-hour) · $${(p.in * 0.10).toFixed(2)}/M cache-read (in×0.10)</li>`; }).join('');
    const subList = savings.lines.map((l) => { const s = l.sub; return `<li><strong>${l.tier}</strong> → ${esc(s.name)} (<code>${esc(s.or)}</code>): $${s.prompt}/M in · $${s.completion}/M out · $${s.cacheRd}/M cache-read · cache-write at in rate</li>`; }).join('');
    method = `<details class="si-method" id="si-method">`
      + `<summary>* How “potential savings” is calculated &amp; where the prices come from</summary>`
      + `<div class="si-method-body">`
      + `<p><strong>Your current cost</strong> is reconstructed from the real token counts in each run's transcript (input, output, cache-write, cache-read), priced <em>per token</em> at Anthropic's published rates, cache-aware:</p>`
      + `<p class="si-method-formula"><code>cost = input×in + cache_write_5m×in×1.25 + cache_write_1h×in×2.0 + cache_read×in×0.10 + output×out</code></p>`
      + `<p><strong>Current model prices</strong> (Anthropic list, $ per million tokens — verified against OpenRouter ${SUBSTITUTE_ASOF}, matching Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5):</p><ul class="si-method-list">${curList}</ul>`
      + `<p>It's an estimate reconstructed from token counts, not a billed invoice.</p>`
      + `<p><strong>The substitute cost</strong> re-prices those <em>same</em> token counts at an open model's <strong>OpenRouter list price</strong> (captured ${SUBSTITUTE_ASOF}), the identical cache-aware way — (input + cache-write) at the prompt rate, cache-read at the model's cached-input rate, output at the completion rate. Because most agent tokens are cache reads (re-sent context), a model's <em>cached-input</em> price — not its headline price — usually decides the comparison.</p>`
      + `<p><strong>Substitute prices used</strong> ($ per million tokens):</p><ul class="si-method-list">${subList}</ul>`
      + `<p class="si-method-warn"><strong>What this does NOT capture:</strong> whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving. Treat it as a ceiling on token economics, not a promise — and prices change, so re-check OpenRouter.</p>`
      + `</div></details>`;
  }

  lastInsightSummary = { total, mainCost, wfCost, subCost, wfCount, subCount, modelTotals, savings, usage, spanTxt, title: stripTitleCache, sessionId: currentSessionId };
  host.innerHTML = `<div class="session-insight-card">`
    + `<div class="si-headline">${headline}</div>`
    + `<div class="si-chips">${chips}</div>`
    + `<div class="si-lb"><div class="si-lb-title">Where the estimated cost went ${legend}</div>${speedLine}${fallbackLine}${rows}${more}</div>`
    + savePanel
    + `<div class="si-foot muted">$ = cache-aware <em>estimate</em>, not billed · bars split by model · shares are of the items shown here · click a bar to open it`
    + ` · <span class="opt-copy"><button class="seg-mini-btn opt-btn" type="button" data-copy-optimize="session" title="Copy a prompt asking Claude Code to make sessions like this cheaper/better">⧉ copy optimization prompt</button><button class="opt-view" type="button" data-view-optimize="session">view</button></span></div>`
    + method
    + `</div>`;
}
document.getElementById('session-insight')?.addEventListener('click', (e) => {
  if (e.target.closest('.si-ast')) { // the "*" opens the methodology section
    e.preventDefault();
    const d = document.getElementById('si-method'); if (d) { d.open = true; d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    return;
  }
  const el = e.target.closest('[data-nav-kind]'); if (!el) return;
  const kind = el.getAttribute('data-nav-kind'), id = el.getAttribute('data-nav-id');
  if (kind === 'wf') navigateToRun(id); else navigateToSubagent(id);
});

function buildSessionWaterfallSvg(workflows, sub) {
  const items = [];
  for (const w of (workflows || [])) {
    const s = w.startedAt ? Date.parse(w.startedAt) : (w.timestamp && w.durationMs ? Date.parse(w.timestamp) - w.durationMs : 0);
    if (!s) continue;
    items.push({ kind: 'workflow', navId: w.runId, label: w.name || w.runId, startMs: s, dur: w.durationMs || 0, cost: w.costUsd || 0, extra: `${w.agentCount || 0} agents` });
  }
  walkForest(sub && sub.root, (n) => {
    if (!n || n.agentId === MAIN_SESSION_ID) return;
    const s = n.startedAtMs || 0; if (!s) return;
    items.push({ kind: 'subagent', navId: n.agentId, label: n.description || n.agentId, startMs: s, dur: n.ms || 0, cost: n.costUsd || 0, extra: n.agentType || '' });
  });
  // A REGULAR session (nothing launched) still shows the conversation's own bar.
  const mainRoot = sub && sub.root;
  if (!items.length && !(mainRoot && mainRoot.startedAtMs)) {
    return ctEmptyHtml('Nothing in this session yet', 'When the session talks, runs a Workflow, or spawns a subagent, it appears here on a time axis.', '');
  }
  items.sort((a, b) => a.startMs - b.startMs || b.dur - a.dur);
  const minStart = items.length ? Math.min(...items.map((i) => i.startMs)) : mainRoot.startedAtMs;
  const maxEnd = items.length ? Math.max(...items.map((i) => i.startMs + i.dur)) : (mainRoot.startedAtMs + Math.max(1, mainRoot.ms || 0));
  const span = Math.max(1, maxEnd - minStart);
  const W = 960, rowH = 22, padL = 210, padR = 86, innerW = W - padL - padR, barH = 12;
  const xOf = (absMs) => padL + ((Math.max(minStart, absMs) - minStart) / span) * innerW;

  let y = 8;
  const parts = [];
  // Row 0: the session itself, spanning the whole window (it launched everything).
  // Clickable → opens the main conversation's own timeline (inference/tool per turn).
  const mainCostTxt = mainRoot && mainRoot.costUsd ? ` · ${fmtUsdShort(mainRoot.costUsd)}` : '';
  parts.push(
    `<circle cx="12" cy="${y + barH / 2}" r="4" fill="var(--gray-700)"></circle>`
    + `<text data-nav-kind="sub" data-nav-id="${esc(MAIN_SESSION_ID)}" x="${padL - 8}" y="${y + 10}" text-anchor="end" style="cursor:pointer;font-size:11px;font-weight:600;fill:var(--gray-1000)">main conversation</text>`
    + `<rect data-nav-kind="sub" data-nav-id="${esc(MAIN_SESSION_ID)}" x="${xOf(minStart)}" y="${y}" width="${innerW.toFixed(1)}" height="${barH}" rx="2" fill="#8a8f98" opacity="0.28" style="cursor:pointer"><title>main conversation — the chat itself (${fmtMs(span)}${mainCostTxt}). Click to inspect its timeline.</title></rect>`
    + `<text x="${(padL + innerW + 6).toFixed(1)}" y="${y + 10}" style="font-size:9.5px;fill:var(--gray-700)">${fmtMs(span)}</text>`,
  );
  y += rowH + 4;
  for (const it of items) {
    const x0 = xOf(it.startMs), x1 = xOf(it.startMs + it.dur), bw = Math.max(2, x1 - x0);
    const color = SESSION_KIND_COLOR[it.kind];
    const navKind = it.kind === 'workflow' ? 'wf' : 'sub';
    const label = esc(truncTxt(it.label, 26));
    parts.push(
      `<circle cx="24" cy="${y + barH / 2}" r="3.5" fill="${color}"><title>${it.kind}</title></circle>`
      + `<text data-nav-kind="${navKind}" data-nav-id="${esc(it.navId)}" x="${padL - 8}" y="${y + 10}" text-anchor="end" style="cursor:pointer;font-size:11px;fill:var(--gray-1000)">${label}</text>`
      + `<rect data-nav-kind="${navKind}" data-nav-id="${esc(it.navId)}" x="${x0.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${barH}" rx="2" fill="${color}" opacity="0.85" style="cursor:pointer"><title>${esc(it.label)} · ${it.kind} · ${fmtMs(it.dur)} · ${fmtUsdShort(it.cost)}${it.extra ? ' · ' + esc(it.extra) : ''}</title></rect>`
      + `<text x="${(x1 + 6).toFixed(1)}" y="${y + 10}" style="font-size:9.5px;fill:var(--gray-700)">${fmtMs(it.dur)}</text>`,
    );
    y += rowH;
  }
  const H = y + 8;
  const plainNote = !items.length
    ? '<div class="muted" style="font-size:11px;margin-top:6px">This session launched no workflows or subagents — the bar is the conversation itself. Click it to inspect the chat timeline.</div>'
    : '';
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto">${parts.join('')}</svg>`;
  return `<div style="overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:6px;background:var(--bg-100);padding:8px">${svg}</div>`
    + plainNote
    + sessionLegend()
    + '<div class="muted" style="font-size:11px;margin-top:6px">Everything the session launched, sorted by start time. Click a label or bar to open it in its tab.</div>';
}

// Navigate from the waterfall to an item's own tab + open it.
async function navigateToRun(runId) {
  // Snapshot the render generation BEFORE switching tabs: setTab('observe') always
  // reloads the list, and acting on a row from the outgoing render gets wiped.
  const genBefore = observedEls.list?.dataset.renderGen || '0';
  setTab("observe");
  const sel = (window.CSS && CSS.escape) ? CSS.escape(runId) : runId;
  // Poll until loadObservedList has rendered the row. A COLD server scan of a big
  // session can take well over 2s — the old 2s window expired silently and the jump
  // landed on an unexpanded list with no cue (walker finding F-019-1). 15s window +
  // a flash on arrival so it's obvious WHICH run was jumped to (names repeat).
  for (let i = 0; i < 150; i++) {
    const fresh = (observedEls.list?.dataset.renderGen || '0') !== genBefore;
    const item = fresh ? observedEls.list?.querySelector(`.obs-run-item[data-run-id="${sel}"]`) : null;
    if (item) {
      const row = item.querySelector('.obs-run-row');
      if (row && row.getAttribute('aria-expanded') !== 'true') toggleItem(item);
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row?.classList.add('obs-row-flash');
      setTimeout(() => row?.classList.remove('obs-row-flash'), 2400);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function navigateToSubagent(agentId) {
  setTab("subagents");
  await new Promise((r) => setTimeout(r, 320));
  selectSubagent(agentId);
}
document.getElementById('session-waterfall-wrap')?.addEventListener('click', (e) => {
  const fold = e.target.closest('[data-fold]');       // ▸/▾ glyph: fold/expand this subtree
  if (fold) { e.stopPropagation(); toggleNodeCollapse(fold.getAttribute('data-fold')); return; }
  const all = e.target.closest('[data-foldall]');      // Expand all / Collapse all
  if (all) { setAllCollapsed(all.getAttribute('data-foldall') === 'collapse'); return; }
  const el = e.target.closest('[data-nav-kind]'); if (!el) return;
  const kind = el.getAttribute('data-nav-kind'); const id = el.getAttribute('data-nav-id');
  if (kind === 'wf') navigateToRun(id); else navigateToSubagent(id);
});
document.getElementById('session-refresh')?.addEventListener('click', () => loadSessionWaterfall());
document.querySelectorAll('[data-sessionview]').forEach((b) => b.addEventListener('click', () => {
  sessionView = b.getAttribute('data-sessionview');
  document.querySelectorAll('[data-sessionview]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  b.classList.toggle('active', true);
  renderSessionView();
}));
// Node-view zoom: −/+/Fit buttons and ⌘/Ctrl+scroll.
document.getElementById('session-waterfall-wrap')?.addEventListener('click', (e) => {
  const zb = e.target.closest('[data-nodezoom]'); if (!zb) return;
  const act = zb.getAttribute('data-nodezoom'); const cur = currentNodeZoom();
  sessionNodeZoom = act === 'fit' ? 'fit' : act === 'in' ? cur * 1.25 : cur * 0.8;
  applySessionNodeZoom();
});
document.getElementById('session-waterfall-wrap')?.addEventListener('wheel', (e) => {
  const canvas = e.target.closest('.node-canvas');
  if (!canvas) return;
  // No modifier → let native overflow:auto do the two-finger / wheel pan (real momentum).
  if (!(e.ctrlKey || e.metaKey)) return;
  // ⌘/Ctrl+scroll (and trackpad pinch) → zoom anchored under the cursor, not the corner.
  e.preventDefault();
  const svg = canvas.querySelector('svg'); if (!svg) return;
  const W = Number(svg.getAttribute('data-w')) || 900;
  const cur = currentNodeZoom();
  const next = Math.max(0.2, Math.min(2.5, cur * (e.deltaY < 0 ? 1.12 : 0.9)));
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;      // cursor within canvas
  const bx = canvas.scrollLeft + cx, by = canvas.scrollTop + cy;    // content point under cursor
  sessionNodeZoom = next;
  svg.style.width = (W * next).toFixed(0) + 'px';                   // synchronous layout
  const ratio = next / cur;
  canvas.scrollLeft = bx * ratio - cx;
  canvas.scrollTop = by * ratio - cy;
  const lbl = document.getElementById('node-zoom-label'); if (lbl) lbl.textContent = Math.round(next * 100) + '%';
}, { passive: false });
// Drag-to-pan the canvas background (grab cursor). Never starts on a node/edge/fold, so
// branch-hover and click-to-open stay intact; a <4px move stays a click.
let panState = null;
document.getElementById('session-waterfall-wrap')?.addEventListener('pointerdown', (e) => {
  const canvas = e.target.closest('.node-canvas.nested'); if (!canvas) return;
  if (e.button !== 0 || e.target.closest('.snode, .sedge')) return;
  panState = { canvas, x: e.clientX, y: e.clientY, sl: canvas.scrollLeft, st: canvas.scrollTop, moved: false, pid: e.pointerId };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* no-op */ }
  e.preventDefault();
});
document.getElementById('session-waterfall-wrap')?.addEventListener('pointermove', (e) => {
  if (!panState) return;
  const dx = e.clientX - panState.x, dy = e.clientY - panState.y;
  if (!panState.moved && Math.hypot(dx, dy) > 4) panState.moved = true;
  if (panState.moved) { panState.canvas.scrollLeft = panState.sl - dx; panState.canvas.scrollTop = panState.st - dy; }
});
function endPan() { panState = null; }
document.getElementById('session-waterfall-wrap')?.addEventListener('pointerup', endPan);
document.getElementById('session-waterfall-wrap')?.addEventListener('pointercancel', endPan);
// Hover a node in the nested graph → light up its whole branch (self + ancestors + descendants).
function clearNodeHover(canvas) {
  if (!canvas) return;
  canvas.classList.remove('hovering');
  canvas.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
}
let hoverScrollT = null;
document.getElementById('session-waterfall-wrap')?.addEventListener('mouseover', (e) => {
  const canvas = e.target.closest('.node-canvas.nested'); if (!canvas || !sessionNestedIndex) return;
  if (panState && panState.moved) return; // don't fight an active drag-pan
  clearTimeout(hoverScrollT);
  const g = e.target.closest('.snode');
  if (!g) { clearNodeHover(canvas); return; }
  const id = g.getAttribute('data-node-id');
  const set = new Set([id]);
  let p = sessionNestedIndex.get(id)?.parentId; // ancestors
  while (p) { set.add(p); p = sessionNestedIndex.get(p)?.parentId; }
  const stack = [...(sessionNestedIndex.get(id)?.children || [])]; // descendants
  while (stack.length) { const c = stack.pop(); set.add(c.id); stack.push(...(c.children || [])); }
  canvas.classList.add('hovering');
  canvas.querySelectorAll('.snode').forEach((n) => n.classList.toggle('hl', set.has(n.getAttribute('data-node-id'))));
  canvas.querySelectorAll('.sedge').forEach((ed) => ed.classList.toggle('hl', set.has(ed.getAttribute('data-echild'))));
  hoverScrollT = setTimeout(() => scrollHoveredIntoView(canvas, id), 90); // ease branch into view when settled
});
document.getElementById('session-waterfall-wrap')?.addEventListener('mouseleave', () => {
  clearNodeHover(document.querySelector('#session-waterfall-wrap .node-canvas.nested'));
});
window.addEventListener('resize', () => { if (sessionView === 'nodes' && sessionNodeZoom === 'fit') applySessionNodeZoom(); });

// ── Sessions browser (home tab): project folder picker + date-grouped session list ──
// The cognitive model per user feedback: pick the FOLDER you work in → see its sessions
// organized by day → click one to inspect it. Empty sessions are folded away (noise).
let sessionsData = null;   // last /v1/sessions payload
let projectsData = null;   // last /v1/projects payload
let showEmptySessions = false;

async function loadSessionsBrowser() {
  const list = document.getElementById('sessions-list'); if (!list) return;
  // The picker must exist in the DOM even when projectsData is already cached
  // (e.g. arriving here from the Home dashboard, which fetched the folder list).
  if (!projectsData || !document.getElementById('project-picker')) await loadProjectsPicker();
  await loadSessionsList();
}
// Group the folder picker so 200 near-identical worktree paths become scannable:
// conductor worktrees group under their repo ("agent-university — conductor worktrees"),
// everything else groups under its parent dir. Groups sort by recency; a filter box
// narrows the list as you type.
function projectGroupKey(p) {
  const cwd = p.cwd || p.slug;
  const m = String(cwd).match(/^(.*\/conductor\/workspaces\/([^/]+))\/[^/]+$/);
  if (m) return { key: m[1], label: `${m[2]} — conductor worktrees` };
  const parent = String(cwd).replace(/\/[^/]+\/?$/, '') || cwd;
  return { key: parent, label: homeAbbrev(parent) + '/' };
}
// Human label for a folder: conductor worktrees read as "repo · worktree" (the full
// path is useless noise); everything else reads as its directory name.
function repoLabel(cwd) {
  const s = String(cwd || '');
  const m = s.match(/\/conductor\/workspaces\/([^/]+)\/([^/]+)\/?$/);
  if (m) return { repo: m[1], wt: m[2], text: `${m[1]} · ${m[2]}` };
  const name = s.split('/').filter(Boolean).pop() || s;
  return { repo: name, wt: null, text: name };
}
function renderProjectPickerOptions(filter = '') {
  const sel = document.getElementById('project-picker'); if (!sel || !projectsData) return;
  const active = projectsData.activeProjectSlug;
  const f = filter.trim().toLowerCase();
  const groups = new Map();
  for (const p of projectsData.projects) {
    if (f && !String(p.cwd || p.slug).toLowerCase().includes(f)) continue;
    const g = projectGroupKey(p);
    if (!groups.has(g.key)) groups.set(g.key, { label: g.label, items: [], last: 0 });
    const grp = groups.get(g.key);
    grp.items.push(p); grp.last = Math.max(grp.last, p.lastActivityMs || 0);
  }
  const ordered = [...groups.values()].sort((a, b) => b.last - a.last);
  let html = '';
  for (const g of ordered) {
    g.items.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
    const opts = g.items.map((p) => {
      const name = String(p.cwd || p.slug).split('/').pop();
      return `<option value="${esc(p.slug)}"${p.slug === active ? ' selected' : ''}>${esc(name)} · ${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}</option>`;
    }).join('');
    html += g.items.length > 1 ? `<optgroup label="${esc(g.label)}">${opts}</optgroup>` : opts;
  }
  sel.innerHTML = html || '<option value="" disabled>No folders match</option>';
}
async function loadProjectsPicker() {
  if (!projectsData) {
    try { projectsData = await apiFetch('/v1/projects'); } catch { projectsData = null; return; }
  }
  const host = document.getElementById('sessions-context'); if (!host) return;
  host.innerHTML = `<div class="sess-projectbar">`
    + `<label class="sess-projectlabel" for="project-picker">Folder</label>`
    + `<input id="project-filter" class="input sess-project-filter" type="search" placeholder="filter folders…" aria-label="Filter folders">`
    + `<select id="project-picker" class="input sess-project-select" title="Every folder you've run Claude Code in — grouped by repo, most recent first.">${''}</select>`
    + `<span class="muted" style="font-size:11px">${projectsData.projects.length} folders</span></div>`;
  renderProjectPickerOptions();
  document.getElementById('project-filter')?.addEventListener('input', (e) => renderProjectPickerOptions(e.target.value));
  document.getElementById('project-picker')?.addEventListener('change', async (e) => {
    const slug = e.target.value; if (!slug) return;
    try { await apiFetch('/v1/project/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }); }
    catch (err) { alert('Could not switch project: ' + err.message); return; }
    resetSessionCaches();
    projectsData.activeProjectSlug = slug;
    renderNav();
    await loadSessionsList();
  });
}
async function loadSessionsList() {
  const list = document.getElementById('sessions-list'); if (!list) return;
  list.innerHTML = '<p class="muted" style="padding:12px;font-size:12px">Reading sessions…</p>';
  try { sessionsData = await apiFetch('/v1/sessions?limit=200'); }
  catch (err) { list.innerHTML = `<p class="muted" style="padding:12px">Could not load sessions: ${esc(err.message)}</p>`; return; }
  renderSessionsList();
}
function sessDayLabel(ms) {
  const d = new Date(ms); const today = new Date(); const yd = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, yd)) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
function sessClock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }); }
let sessionsSort = 'date'; // 'date' (day groups) | 'cost' (flat, most expensive first)
function sessRowHtml(s, activeId, isEmpty) {
  const badges = [];
  if (s.workflows) badges.push(`<span class="sess-badge" data-open="observe" title="Open this session's Workflows" style="border-color:${SESSION_KIND_COLOR.workflow};color:${SESSION_KIND_COLOR.workflow}">${s.workflows} wf</span>`);
  if (s.subagents) badges.push(`<span class="sess-badge" data-open="subagents" title="Open this session's Subagents" style="border-color:${SESSION_KIND_COLOR.subagent};color:${SESSION_KIND_COLOR.subagent}">${s.subagents} sub</span>`);
  if (s.fallbacks && (s.fallbacks.switches || s.fallbacks.refusals)) badges.push(`<span class="sess-badge sess-badge-fallback" title="Fable 5 refusal fallback: ${s.fallbacks.refusals || 0} refusal(s), ${s.fallbacks.switches || 0} switch(es) to the fallback model, ${s.fallbacks.sticky || 0} turn(s) served on it via sticky routing">⇄ ${(s.fallbacks.switches || 0) + (s.fallbacks.refusals || 0)} fallback</span>`);
  const activePill = s.id === activeId ? '<span class="sess-active-pill" title="This is the session the Active Session / Workflows / Subagents tabs are currently showing">active</span>' : '';
  const livePill = (Date.now() - (s.mtimeMs || 0)) < 120000 ? '<span class="sess-live-pill" title="Transcript updated in the last 2 minutes — this session appears to be running right now. Stats are its progress so far; hit Refresh to update.">live</span>' : '';
  const ghost = isEmpty(s) ? ' sess-row-ghost' : '';
  return `<button class="sess-row${ghost}" type="button" data-session-id="${esc(s.id)}" title="${esc(s.id)}${s.cwd ? ' · ' + esc(s.cwd) : ''}">`
    + `<span class="sess-time mono">${s._ms ? (sessionsSort === 'cost' ? sessDayLabel(s._ms) + ' ' : '') + sessClock(s._ms) : '—'}</span>`
    + `<span class="sess-title">${esc(truncTxt(s.title || '(no prompt captured)', 96))}${activePill}${livePill}</span>`
    + `<span class="sess-badges">${badges.join('')}</span>`
    + `<span class="sess-dur mono muted">${s.ms ? fmtMs(s.ms) : '—'}</span>`
    + `<span class="sess-turns mono muted" title="assistant turns">${fmtN(s.turns)}t</span>`
    + `<span class="sess-cost mono" title="${fmtUsd(s.costUsd)} — the conversation's own cost (workflow/subagent spend not included; open the session for the full total)">${fmtUsdShort(s.costUsd)}</span>`
    + `<span class="tier-dot" title="${esc(s.model || '')}" style="background:${tierColor(s.tier)}"></span></button>`;
}
function renderSessionsList() {
  const list = document.getElementById('sessions-list'); if (!list) return;
  // Never silently no-op with a stale DOM: if the data was cleared (session switch,
  // project switch) re-fetch instead — a visible-but-dead toggle was walker F-STORY-004-1.
  if (!sessionsData) { loadSessionsList(); return; }
  const all = sessionsData.sessions || [];
  const activeId = sessionsData.activeSessionId;
  if (!all.length) { list.innerHTML = ctEmptyHtml('No sessions in this folder yet', 'Run Claude Code in this project and its sessions will appear here.', ''); return; }
  const isEmpty = (s) => !s.turns && !s.costUsd;
  const shown = showEmptySessions ? all : all.filter((s) => !isEmpty(s));
  const hiddenCount = all.length - shown.length;
  // Group by calendar day of activity (start time, falling back to file mtime).
  const groups = new Map(); // label -> {ms, items:[]}
  for (const s of shown) {
    const ms = (s.startedAt ? Date.parse(s.startedAt) : 0) || s.mtimeMs || 0;
    const label = sessDayLabel(ms);
    if (!groups.has(label)) groups.set(label, { ms, items: [] });
    const g = groups.get(label); g.items.push({ ...s, _ms: ms }); g.ms = Math.max(g.ms, ms);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].ms - a[1].ms);
  // Folder rollup: total conversation spend across the loaded sessions (honest bound).
  const totCost = all.reduce((a, b) => a + (b.costUsd || 0), 0);
  const liveN = all.filter((s) => (Date.now() - (s.mtimeMs || 0)) < 120000).length;
  let html = `<div class="folder-rollup"><span class="folder-rollup-cost mono">${fmtUsdShort(totCost)}</span>`
    + `<span class="muted"> across ${all.length}${sessionsData.totalSessions > all.length ? ` of ${sessionsData.totalSessions}` : ''} session${all.length === 1 ? '' : 's'} (conversation cost, est.)</span>`
    + (liveN ? `<span class="sess-live-pill" style="margin-left:10px">${liveN} live</span>` : '')
    + `<span class="seg-mini" style="margin-left:auto" role="group" aria-label="Sort sessions">`
    + ['date', 'cost'].map((k) => `<button class="seg-mini-btn${sessionsSort === k ? ' active' : ''}" type="button" data-sessions-sort="${k}">by ${k}</button>`).join('')
    + `</span></div>`;
  html += sessHeadHtml('folder');
  if (sessionsSort === 'cost') {
    // Flat cost-ranked list (day grouping intentionally dropped in this mode).
    const ranked = [...shown].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
    html += `<div class="sess-group"><div class="sess-group-h"><span>Most expensive first</span><span class="sess-group-meta">${ranked.length} sessions</span></div>`;
    for (const s of ranked) html += sessRowHtml({ ...s, _ms: (s.startedAt ? Date.parse(s.startedAt) : 0) || s.mtimeMs || 0 }, activeId, isEmpty);
    html += '</div>';
    if (hiddenCount > 0 || showEmptySessions) {
      const shownEmpties = all.filter(isEmpty).length;
      html += `<button class="sess-empty-toggle" type="button" id="sess-empty-toggle" aria-pressed="${showEmptySessions}">${showEmptySessions ? `Hide the ${shownEmpties} empty session${shownEmpties === 1 ? '' : 's'}` : `Show ${hiddenCount} empty session${hiddenCount === 1 ? '' : 's'} (no turns, no cost)`}</button>`;
    }
    list.innerHTML = html;
    return;
  }
  for (const [label, g] of ordered) {
    g.items.sort((a, b) => b._ms - a._ms);
    const dayCost = g.items.reduce((a, b) => a + (b.costUsd || 0), 0);
    html += `<div class="sess-group"><div class="sess-group-h"><span>${esc(label)}</span>`
      + `<span class="sess-group-meta">${g.items.length} session${g.items.length === 1 ? '' : 's'} · ${fmtUsdShort(dayCost)}</span></div>`;
    for (const s of g.items) html += sessRowHtml(s, activeId, isEmpty);
    html += '</div>';
  }
  if (hiddenCount > 0 || showEmptySessions) {
    const shownEmpties = all.filter(isEmpty).length;
    html += `<button class="sess-empty-toggle" type="button" id="sess-empty-toggle" aria-pressed="${showEmptySessions}">`
      + (showEmptySessions ? `Hide the ${shownEmpties} empty session${shownEmpties === 1 ? '' : 's'}` : `Show ${hiddenCount} empty session${hiddenCount === 1 ? '' : 's'} (no turns, no cost)`)
      + `</button>`;
  }
  if (sessionsData.totalSessions > all.length) html += `<div class="muted" style="font-size:11px;padding:6px 4px">Showing the ${all.length} most recent of ${sessionsData.totalSessions} sessions.</div>`;
  list.innerHTML = html;
}
function resetSessionCaches() {
  lastSession = null; sessionsData = null; sessionCollapsed = new Set(); sessionKnownFoldIds = new Set(); sessionNestedIndex = null; sessionTree = null;
  mainTraceLoadedFor = null;
  const mt = document.getElementById('session-main-trace');
  if (mt) { mt.open = false; const b = document.getElementById('session-main-trace-body'); if (b) b.innerHTML = ''; }
  try { runCache.clear(); } catch { /* not defined yet */ }
  try { subCache.clear(); } catch { /* not defined yet */ }
}
async function selectSession(id) {
  try { await apiFetch('/v1/session/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
  catch (err) { alert('Could not select session: ' + err.message); return; }
  resetSessionCaches();
  currentSessionId = id; // so the pushed history entry carries the new session
  setTab('session'); // Active Session tab reloads everything from the newly-selected session
}
document.getElementById('sessions-list')?.addEventListener('click', (e) => {
  const srt = e.target.closest('[data-sessions-sort]');
  if (srt) { sessionsSort = srt.getAttribute('data-sessions-sort'); renderSessionsList(); return; }
  const tgl = e.target.closest('#sess-empty-toggle');
  if (tgl) { showEmptySessions = !showEmptySessions; renderSessionsList(); return; }
  const row = e.target.closest('[data-session-id]');
  if (row) {
    const openTab = e.target.closest('.sess-badge[data-open]')?.getAttribute('data-open') || null;
    selectSession(row.getAttribute('data-session-id')).then(() => { if (openTab) setTab(openTab); }); // wf/sub badge → jump straight there
  }
});
document.getElementById('sessions-refresh')?.addEventListener('click', async () => { projectsData = null; await loadSessionsBrowser(); });

// ── Browser-history navigation ───────────────────────────────────────────────
// Every meaningful move (tab switch, session switch, subagent drill-in) pushes a
// history entry with a shareable hash (#/tab/sessionId/agentId), so the browser
// back/forward buttons walk your trail — including "back from a subagent".
let currentTab = 'sessions';
let currentSessionId = null;
let navApplying = false; // true while restoring from popstate/deep-link (don't re-push)
function navHash(sub = null) {
  // Session id belongs only in session-scoped hashes (#/home stays clean).
  const withSession = SESSION_SCOPE_TABS.includes(currentTab) && currentSessionId;
  return '#/' + currentTab + (withSession ? '/' + currentSessionId : '') + (sub ? '/' + sub : '');
}
function pushNav(sub = null) {
  if (navApplying) return;
  const st = { tab: currentTab, sessionId: currentSessionId, sub };
  const hash = navHash(sub);
  if (location.hash === hash) return; // no-op moves don't pollute the stack
  history.pushState(st, '', hash);
}
function parseNavHash(h) {
  const m = String(h || '').match(/^#\/([a-z]+)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?(?:\/([\w-]+))?$/i);
  return m ? { tab: m[1], sessionId: m[2] || null, sub: m[3] || null } : null;
}
async function applyNavState(st) {
  if (!st) return;
  navApplying = true;
  try {
    if (st.sessionId && st.sessionId !== currentSessionId) {
      try {
        await apiFetch('/v1/session/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: st.sessionId }) });
        currentSessionId = st.sessionId;
        resetSessionCaches();
      } catch { /* session may be gone — land on the tab anyway */ }
    }
    setTab(st.tab || 'sessions');
    if (st.tab === 'subagents') {
      if (st.sub) selectSubagent(st.sub);
      else { const slot = subEls.slot(); if (slot) slot.hidden = true; }
    }
  } finally { navApplying = false; }
}
window.addEventListener('popstate', (e) => { applyNavState(e.state || parseNavHash(location.hash)); });

// ── Active-session identity strip ────────────────────────────────────────────
// Always tells you WHICH session the drill-in tabs (Active Session / Workflows /
// Subagents) are showing: its starting prompt, when it ran, what it cost — plus a
// one-click way back to the Sessions list. Fetched from the server (authoritative,
// so it stays right even if the selection changed from another window).
async function refreshSessionStrip() {
  const strip = document.getElementById('active-session-strip'); if (!strip || strip.hidden) return;
  let data = null;
  try { data = await apiFetch('/v1/session/active'); } catch { /* server unreachable — leave as-is */ }
  if (data && data.sessionId) currentSessionId = data.sessionId;
  const s = data && data.session;
  stripTitleCache = s ? (s.title || s.id) : null;
  renderNav(); // session crumb shows the title once known
  if (!s) {
    strip.innerHTML = `<span class="sess-strip-label">No session selected</span>`
      + `<span class="sess-strip-title muted">pick one from the Sessions tab</span>`
      + `<button class="sess-strip-switch" type="button" data-goto-sessions>Sessions ↗</button>`;
    return;
  }
  const startMs = s.startedAt ? Date.parse(s.startedAt) : s.mtimeMs;
  const badges = []
  if (s.workflows) badges.push(`<span class="sess-badge" data-open="observe" title="Open this session's Workflows" style="border-color:${SESSION_KIND_COLOR.workflow};color:${SESSION_KIND_COLOR.workflow}">${s.workflows} wf</span>`);
  if (s.subagents) badges.push(`<span class="sess-badge" data-open="subagents" title="Open this session's Subagents" style="border-color:${SESSION_KIND_COLOR.subagent};color:${SESSION_KIND_COLOR.subagent}">${s.subagents} sub</span>`);
  if (s.fallbacks && (s.fallbacks.switches || s.fallbacks.refusals)) badges.push(`<span class="sess-badge sess-badge-fallback" title="Fable 5 refusal fallback: ${s.fallbacks.refusals || 0} refusal(s), ${s.fallbacks.switches || 0} switch(es) to the fallback model, ${s.fallbacks.sticky || 0} turn(s) served on it via sticky routing">⇄ ${(s.fallbacks.switches || 0) + (s.fallbacks.refusals || 0)} fallback</span>`);
  const liveNow = (Date.now() - (s.mtimeMs || 0)) < 120000 ? '<span class="sess-live-pill" title="Transcript updated in the last 2 minutes — this session appears to be running right now">live</span>' : '';
  strip.innerHTML = `<span class="sess-strip-label">Viewing session</span>`
    + `<span class="sess-strip-title" title="${esc(s.title || s.id)}">“${esc(truncTxt(s.title || '(no prompt captured)', 90))}”</span>${liveNow}`
    + `<span class="sess-strip-meta mono" title="conversation cost — workflows/subagents add more (see Active Session for the full total)">${startMs ? sessDayLabel(startMs) + ' ' + sessClock(startMs) : ''} · ${fmtUsdShort(s.costUsd)}</span>`
    + badges.join('')
    + `<button class="sess-strip-switch" type="button" data-goto-sessions title="Back to the session list">switch session ↗</button>`;
}
document.getElementById('active-session-strip')?.addEventListener('click', (e) => {
  const open = e.target.closest('.sess-badge[data-open]');
  if (open) { setTab(open.getAttribute('data-open')); return; }
  if (e.target.closest('[data-goto-sessions]')) setTab('sessions');
});

const SESSION_SCOPE_TABS = ['session', 'observe', 'subagents'];
function setTab(tab) {
  const panels = { control: 'tab-control', home: 'tab-home', sessions: 'tab-sessions', session: 'tab-session', observe: 'tab-observe', subagents: 'tab-subagents' };
  if (!panels[tab]) tab = 'home';
  for (const [t, id] of Object.entries(panels)) { const el = document.getElementById(id); if (el) el.hidden = (t !== tab); }
  // The run-controls chrome belongs to the Control tab only.
  const isControl = tab === 'control';
  const hide = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = isControl ? '' : 'none'; };
  hide('.control-bar');
  hide('#workflow-picker');
  hide('.seg-control');
  currentTab = tab;
  renderNav();
  pushNav(); // history entry per tab move (no-op while restoring from popstate)
  // Identity strip: visible in session scope, hidden on Home and the folder list.
  const strip = document.getElementById('active-session-strip');
  if (strip) { strip.hidden = !SESSION_SCOPE_TABS.includes(tab); if (!strip.hidden) refreshSessionStrip(); }
  if (tab === 'home') loadHome();
  if (tab === 'sessions') loadSessionsBrowser();
  if (tab === 'session') loadSessionWaterfall();
  if (tab === 'observe') loadObservedList();
  if (tab === 'subagents') loadSubagentTree();
}

// ── Breadcrumb + session sub-tabs ─────────────────────────────────────────────
// ⌂ All folders / <folder> / “<session title>” — each level clickable; the session
// level carries sub-tabs [Overview | Workflows | Subagents].
let stripTitleCache = null; // set by refreshSessionStrip for the session crumb
function renderNav() {
  const host = document.getElementById('nav-crumbs'); if (!host) return;
  const inSession = SESSION_SCOPE_TABS.includes(currentTab);
  // On Home the breadcrumb is just the root ("⌂ All folders") — redundant with the
  // "All activity" card title, and its own band adds a dead horizontal level. Hide it.
  document.querySelector('.crumb-bar')?.classList.toggle('crumb-bar-hidden', currentTab === 'home');
  const folderLabel = (() => {
    const p = projectsData && projectsData.projects && projectsData.projects.find((x) => x.slug === projectsData.activeProjectSlug);
    return p ? homeAbbrev(p.cwd || p.slug) : null;
  })();
  let html = `<button class="crumb${currentTab === 'home' ? ' crumb-here' : ''}" type="button" data-nav-tab="home" title="All folders on this machine">⌂ All folders</button>`;
  if (currentTab !== 'home') {
    html += `<span class="crumb-sep">/</span>`
      + `<button class="crumb${currentTab === 'sessions' ? ' crumb-here' : ''}" type="button" data-nav-tab="sessions" title="This folder's sessions">${esc(folderLabel || 'Folder')}</button>`;
  }
  if (inSession) {
    const t = stripTitleCache ? truncTxt(stripTitleCache, 44) : 'Session';
    html += `<span class="crumb-sep">/</span><span class="crumb crumb-here" title="${esc(stripTitleCache || '')}">“${esc(t)}”</span>`;
  }
  host.innerHTML = html;
  const subtabs = document.getElementById('session-subtabs');
  if (subtabs) {
    subtabs.hidden = !inSession;
    subtabs.querySelectorAll('.subtab-btn').forEach((b) => {
      const sel = b.dataset.tab === currentTab;
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.classList.toggle('active', sel);
    });
  }
}
document.getElementById('nav-crumbs')?.addEventListener('click', (e) => {
  const c = e.target.closest('[data-nav-tab]'); if (c) setTab(c.getAttribute('data-nav-tab'));
});

// Shared cursor-following tooltip for chart hover (native <title> is slow + clips).
const chartTip = (() => {
  const el = document.createElement('div');
  el.className = 'chart-tip'; el.hidden = true;
  document.body.appendChild(el);
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { el.hidden = true; return; }
    el.textContent = t.getAttribute('data-tip');
    el.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - el.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, window.innerHeight - el.offsetHeight - 8);
    el.style.left = x + 'px'; el.style.top = y + 'px';
  });
  return el;
})();

// ── Home dashboard: everything Claude Code has done on this machine ───────────
function homeSessRowHtml(s) {
  const badges = [];
  if (s.workflows) badges.push(`<span class="sess-badge" data-open="observe" title="Open this session's Workflows" style="border-color:${SESSION_KIND_COLOR.workflow};color:${SESSION_KIND_COLOR.workflow}">${s.workflows} wf</span>`);
  if (s.subagents) badges.push(`<span class="sess-badge" data-open="subagents" title="Open this session's Subagents" style="border-color:${SESSION_KIND_COLOR.subagent};color:${SESSION_KIND_COLOR.subagent}">${s.subagents} sub</span>`);
  if (s.fallbacks && (s.fallbacks.switches || s.fallbacks.refusals)) badges.push(`<span class="sess-badge sess-badge-fallback" title="Fable 5 refusal fallback: ${s.fallbacks.refusals || 0} refusal(s), ${s.fallbacks.switches || 0} switch(es) to the fallback model, ${s.fallbacks.sticky || 0} turn(s) served on it via sticky routing">⇄ ${(s.fallbacks.switches || 0) + (s.fallbacks.refusals || 0)} fallback</span>`);
  const live = (Date.now() - (s.mtimeMs || 0)) < 120000 ? '<span class="sess-live-pill" title="Transcript updated in the last 2 minutes — appears to be running now">live</span>' : '';
  return `<button class="sess-row home-sess-row" type="button" data-home-session="${esc(s.id)}" data-home-project="${esc(s.projectSlug)}" title="${esc(s.projectCwd || s.projectSlug)}">`
    + `<span class="sess-time mono">${s.mtimeMs ? sessDayLabel(s.mtimeMs) + ' ' + sessClock(s.mtimeMs) : '—'}</span>`
    + `<span class="sess-title">${esc(truncTxt(s.title || '(no prompt captured)', 80))}${live}</span>`
    + `<span class="sess-badges">${badges.join('')}</span>`
    + `<span class="home-folder mono muted">${esc(truncTxt(repoLabel(s.projectCwd || s.projectSlug).text, 30))}</span>`
    + `<span class="sess-cost mono" title="${fmtUsd(s.costUsd)} — conversation cost (estimate)">${fmtUsdShort(s.costUsd)}</span>`
    + `<span class="tier-dot" title="${esc(s.model || '')}" style="background:${tierColor(s.tier)}"></span></button>`;
}
// Column headers for the session lists ("what am I looking at" — user ask).
function sessHeadHtml(kind) {
  const model = '<span class="sess-head-model" title="Model tier (dot color)">model</span>';
  if (kind === 'home') {
    return `<div class="sess-head home-sess-row"><span>when</span><span>session — first prompt</span><span>runs</span><span style="text-align:right">folder</span><span style="text-align:right">cost</span>${model}</div>`;
  }
  return `<div class="sess-head sess-row-grid"><span>when</span><span>session — first prompt</span><span>runs</span><span style="text-align:right">length</span><span style="text-align:right">turns</span><span style="text-align:right">cost</span>${model}</div>`;
}
async function loadHome() {
  const body = document.getElementById('home-body'); if (!body) return;
  let home;
  try { home = await apiFetch('/v1/home'); } catch (err) { body.innerHTML = `<p class="muted" style="padding:12px">Could not load: ${esc(err.message)}</p>`; return; }
  if (!projectsData) projectsData = { projects: home.projects, activeProjectSlug: home.activeProjectSlug };
  const row = homeSessRowHtml;
  lastHomeData = home;
  const moreFolders = home.projects.length - (home.folderTotals || []).length;
  const liveBlock = home.live && home.live.length
    ? `<div class="home-sect">Running now</div>${home.live.map(row).join('')}` : '';
  body.innerHTML = `<div id="home-agg"><p class="muted" style="padding:6px 4px;font-size:12px">Computing machine-wide totals…</p></div>`
    + liveBlock
    + `<div class="home-sect">Recent sessions — all folders</div>`
    + `<div id="home-recents">${sessHeadHtml('home')}${(home.recents || []).map(row).join('') || '<p class="muted" style="padding:8px;font-size:12px">Nothing yet.</p>'}`
    + `<button class="sess-empty-toggle" type="button" data-home-allsessions>Show ALL sessions on this machine…</button></div>`
    + `<div class="home-sect">Most active folders`
    + `<span class="home-sort seg-mini" role="group" aria-label="Sort folders">`
    + ['recent', 'spend', 'sessions'].map((k) => `<button class="seg-mini-btn${homeFolderSort === k ? ' active' : ''}" type="button" data-folder-sort="${k}">${k}</button>`).join('')
    + `</span></div><div class="home-folders" id="home-folders"></div>`
    + (moreFolders > 0 ? `<button class="sess-empty-toggle" type="button" data-home-allfolders>Browse all ${home.projects.length} folders…</button>` : '');
  renderHomeFolders();
  pollAggregate();
}
// GIT-REPO grouping: conductor worktrees of the same repo merge into ONE card
// (a card per worktree made this view useless). Click → newest worktree's folder.
let lastHomeData = null;
let homeFolderSort = 'recent';
function renderHomeFolders() {
  const host = document.getElementById('home-folders'); if (!host || !lastHomeData) return;
  const repoCards = new Map();
  for (const f of (lastHomeData.folderTotals || [])) {
    const r = repoLabel(f.cwd || f.slug);
    const key = r.wt ? `repo:${r.repo}` : `dir:${f.cwd || f.slug}`;
    if (!repoCards.has(key)) repoCards.set(key, { repo: r.repo, wts: 0, sessions: 0, costUsd: 0, coverage: 0, last: 0, slug: f.slug, cwds: [] });
    const c = repoCards.get(key);
    c.wts += r.wt ? 1 : 0; c.sessions += f.sessions; c.costUsd += f.costUsd; c.coverage += f.coverage;
    c.cwds.push(f.cwd || f.slug);
    if ((f.lastActivityMs || 0) > c.last) { c.last = f.lastActivityMs || 0; c.slug = f.slug; }
  }
  const sorters = { recent: (a, b) => b.last - a.last, spend: (a, b) => b.costUsd - a.costUsd, sessions: (a, b) => b.sessions - a.sessions };
  host.innerHTML = [...repoCards.values()].sort(sorters[homeFolderSort] || sorters.recent).map((c) => `<button class="home-folder-card" type="button" data-home-folder="${esc(c.slug)}" data-home-repo="${esc(c.repo)}" title="${esc(c.cwds.join('\n'))}">`
    + `<span class="hf-name">${esc(truncTxt(c.repo, 34))}</span>`
    + `<span class="hf-meta mono">${c.wts > 1 ? `${c.wts} worktrees · ` : ''}${c.sessions} session${c.sessions === 1 ? '' : 's'}</span>`
    + `<span class="hf-cost mono" title="Spend across the ${c.coverage} most recent session${c.coverage === 1 ? '' : 's'} of ${c.wts > 1 ? 'these worktrees' : 'this folder'} (estimate)">${fmtUsdShort(c.costUsd)}<span class="hf-cov">/${c.coverage} recent</span></span></button>`).join('');
}

// ── Machine-wide aggregate: totals + charts (incremental server scan, polled) ──
let aggPolling = false;
async function pollAggregate(restart = false) {
  if (aggPolling) return;
  aggPolling = true;
  try {
    for (let i = 0; i < 300; i++) {
      let a;
      try { a = await apiFetch(`/v1/aggregate${restart && i === 0 ? '?restart=1' : ''}`); }
      catch (err) { const el = document.getElementById('home-agg'); if (el) el.innerHTML = `<p class="muted" style="font-size:12px">Totals unavailable: ${esc(err.message)}</p>`; return; }
      renderAggregate(a);
      if (a.done) return;
      if (!document.getElementById('home-agg')) return; // navigated away
    }
  } finally { aggPolling = false; }
}
function svgDailyChart(byDay) {
  const days = byDay.slice(-30);
  if (!days.length) return '';
  const AX = 46, W = 920, H = 130, top = 8, bottom = 16;
  const plotH = H - top - bottom;
  const bw = Math.max(6, Math.floor((W - AX - 8) / days.length) - 3);
  const rawMax = Math.max(...days.map((d) => d.costUsd), 0.01);
  // Nice axis max on a 1-2-5 scale so gridline labels are round dollars.
  const pow = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= rawMax) || rawMax;
  const yOf = (v) => top + plotH - (v / max) * plotH;
  const grid = [0, max / 2, max].map((v) => `<line x1="${AX}" x2="${W - 4}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`
    + `<text x="${AX - 6}" y="${(yOf(v) + 3).toFixed(1)}" text-anchor="end" style="font-size:8.5px;fill:var(--gray-700)">${v === 0 ? '$0' : fmtUsdShort(v)}</text>`).join('');
  const bars = days.map((d, i) => {
    const x = AX + 4 + i * (bw + 3);
    const totalH = Math.max(1, Math.round((d.costUsd / max) * plotH));
    const tierTxt = MODEL_ORDER.filter((t) => d.tiers && d.tiers[t]).map((t) => `${t} ${fmtUsdShort(d.tiers[t])}`).join(' · ');
    const fbTip = d.fallbacks ? ` · ⇄ ${d.fallbacks} Fable switch${d.fallbacks === 1 ? '' : 'es'}/refusal${d.fallbacks === 1 ? '' : 's'}` : '';
    const tip = `${d.day} · ${fmtUsdShort(d.costUsd)} · ${d.sessions} session${d.sessions === 1 ? '' : 's'}${tierTxt ? ' — ' + tierTxt : ''}${fbTip}`;
    // Stacked by model tier (bottom-up in MODEL_ORDER)
    let segs = '', yCur = H - bottom;
    if (d.tiers && d.costUsd > 0) {
      for (const t of [...MODEL_ORDER].reverse()) {
        const c = d.tiers[t]; if (!c) continue;
        const h = Math.max(1, Math.round((c / d.costUsd) * totalH));
        yCur -= h;
        segs += `<rect data-tip="${esc(tip)}" aria-label="${esc(tip)}" x="${x}" y="${yCur}" width="${bw}" height="${h}" fill="${modelColor(t)}" opacity="0.85"/>`;
      }
    } else {
      segs = `<rect data-tip="${esc(tip)}" aria-label="${esc(tip)}" x="${x}" y="${H - bottom - totalH}" width="${bw}" height="${totalH}" rx="2" fill="var(--blue)" opacity="0.75"/>`;
    }
    // ⚠ flag above any day that contains a Fable switch/refusal.
    const flag = d.fallbacks ? `<text data-tip="${esc(tip)}" x="${x + bw / 2}" y="${top + 1}" text-anchor="middle" style="font-size:10px;cursor:default">⚠️</text>` : '';
    return segs + flag + (i % 5 === 0 ? `<text x="${x}" y="${H - 4}" style="font-size:8.5px;fill:var(--gray-700)">${d.day.slice(5)}</text>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto" role="img" aria-label="Daily spend by model, last ${days.length} days">${grid}${bars}</svg>`;
}
let lastAggData = null;
function renderAggregate(a) {
  lastAggData = a;
  const el = document.getElementById('home-agg'); if (!el) return;
  const t = a.totals;
  const prog = a.done ? '' : `<span class="muted" style="font-size:11px;margin-left:10px">scanning… ${fmtN(a.progress.scannedSessions)}/${fmtN(a.progress.totalSessions)} sessions</span>`;
  // Metric cards — equal-width grid, generous whitespace (StackAI/OpenAI usage style).
  const metric = (k, v, s, big, title) => `<div class="agg-metric${big ? ' agg-metric-hero' : ''}"${title ? ` title="${esc(title)}"` : ''}><div class="agg-metric-k">${k}</div><div class="agg-metric-v">${v}</div><div class="agg-metric-s">${s}</div></div>`;
  // Honest coverage window: "all-time" is really "as far back as your on-disk
  // transcripts go" — Claude Code prunes old ones. Show the real earliest date.
  const spanDays = (a.byDay || []).map((b) => b.day).filter(Boolean).sort();
  const fmtDayShort = (iso) => { const p = String(iso).split('-'); const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(+p[1] || 1) - 1]; return p.length === 3 ? `${M} ${+p[2]}, ${p[0]}` : iso; };
  const sinceLabel = spanDays.length ? `since ${fmtDayShort(spanDays[0])} · est.` : 'cache-aware estimate';
  const chips = `<div class="agg-metrics">`
    + metric(`Total spend${a.done ? '' : ' (so far)'}`, fmtUsdShort(t.costUsd), sinceLabel, true, `Cache-aware estimate across every Claude Code transcript still on disk (${spanDays.length ? fmtDayShort(spanDays[0]) + ' – ' + fmtDayShort(spanDays[spanDays.length - 1]) : 'all dates'}, ${spanDays.length} active days). Claude Code prunes older transcripts, so this is bounded by what's retained locally, not literally all-time.`)
    + metric('Sessions', fmtN(t.sessions), `${fmtN(t.folders)} folders`)
    + metric('Output tokens', fmtNshort(t.tokens.out), `${fmtNshort(t.tokens.in)} fresh in`)
    + metric('Cache reads', fmtNshort(t.tokens.cacheRd), `${fmtNshort(t.tokens.cacheWr)} written`)
    + `</div>`;

  // ── Headline banner: getting switched off Fable ────────────────────────────
  // The bulk of switching happens INSIDE subagents (measured 71 subagent transcripts
  // vs 3 main), so this counts both layers. Front-and-center because it's the story.
  const fbAgg = t.fallbacks || {};
  // One "switched off Fable" event = a fallback re-serve (fallback block) OR a bare
  // refusal (stop_reason:refusal). They're distinct events (never the same request),
  // so the total is their sum. Split by WHERE (main-vs-subagent totals INCLUDE refusals),
  // so the two location pills always add up to the headline.
  const subTotal = fbAgg.subTotal != null ? fbAgg.subTotal : (fbAgg.subSwitches || 0);
  const mainTotal = fbAgg.mainTotal != null ? fbAgg.mainTotal : (fbAgg.mainSwitches || 0);
  const totalSwitches = subTotal + mainTotal;
  const subShare = totalSwitches ? Math.round((subTotal / totalSwitches) * 100) : 0;
  const catList = Object.entries(fbAgg.categories || {}).filter(([k]) => k && k !== 'unspecified')
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ×${v}`).join(' · ');
  const fbBanner = totalSwitches
    ? `<div class="fb-banner${a.done ? '' : ' fb-banner-scanning'}">`
      + `<div class="fb-banner-lead">⇄ You got <strong>nerfed by Fable ${fmtN(totalSwitches)} time${totalSwitches === 1 ? '' : 's'}</strong>${a.done ? '' : ' <span class="fb-banner-sofar">(scanning…)</span>'}</div>`
      + `<div class="fb-banner-sub">`
      + `<span class="fb-banner-pill" title="Fable's classifier declined a request inside a subagent (a Task/Agent, or a Workflow agent() call), then Claude Code re-served it on the fallback model. Includes refusals + re-served switches.">`
      + `<strong>${fmtN(subTotal)}</strong> in subagents</span>`
      + `<span class="fb-banner-pill" title="Declined in your main conversation (refusals + switches).">`
      + `<strong>${fmtN(mainTotal)}</strong> in main chat</span>`
      + `<span class="fb-banner-pill fb-banner-pill-quiet" title="Distinct sessions where at least one switch or refusal happened.">`
      + `across <strong>${fmtN(fbAgg.sessionsAffected || 0)}</strong> sessions</span>`
      + (catList ? `<span class="fb-banner-cat" title="Refusal category from stop_details — why the classifier declined.">why: ${catList}</span>` : '')
      + `</div>`
      + `<div class="fb-banner-note"><strong>${fmtN(subTotal)} + ${fmtN(mainTotal)} = ${fmtN(totalSwitches)}</strong> — ${subShare}% inside subagents (mostly parallel Workflow agents)${fbAgg.refusals ? `, ${fmtN(fbAgg.refusals)} were outright refusals` : ''}. Open any ⇄ session to see the exact step and the prompt that triggered it.</div>`
      + `</div>`
    : '';
  const repoMax = a.byRepo.length ? a.byRepo[0].costUsd || 1 : 1;
  const repoBars = a.byRepo.slice(0, 8).map((r) => {
    const tierTxt = MODEL_ORDER.filter((t) => r.tiers && r.tiers[t]).map((t) => `${t} ${fmtUsdShort(r.tiers[t])}`).join(' · ');
    const segs = (r.tiers && r.costUsd > 0)
      ? MODEL_ORDER.filter((t) => r.tiers[t]).map((t) => `<span class="si-seg" style="flex:${r.tiers[t].toFixed(4)};background:${modelColor(t)}" title="${t} · ${fmtUsdShort(r.tiers[t])}"></span>`).join('')
      : `<span class="si-seg" style="flex:1;background:${SESSION_KIND_COLOR.workflow}"></span>`;
    const fbFlag = r.fallbacks ? `<span class="agg-repo-flag" title="⇄ ${r.fallbacks} Fable switch${r.fallbacks === 1 ? '' : 'es'}/refusal${r.fallbacks === 1 ? '' : 's'} in this folder">⚠️</span>` : '';
    return `<div class="agg-repo-row" data-tip="${esc(r.repo)} · ${fmtUsd(r.costUsd)} · ${r.sessions} sessions${tierTxt ? ' — ' + tierTxt : ''}${r.fallbacks ? ' · ⇄ ' + r.fallbacks + ' Fable switches/refusals' : ''}">`
      + `<span class="agg-repo-name mono">${fbFlag}${esc(truncTxt(r.repo, 26))}</span>`
      + `<span class="si-bar"><span class="si-bar-stack" style="width:${Math.max(2, Math.round((r.costUsd / repoMax) * 100))}%">${segs}</span></span>`
      + `<span class="si-cost mono">${fmtUsdShort(r.costUsd)}</span><span class="agg-repo-sess mono">${fmtN(r.sessions)} sess</span></div>`;
  }).join('');
  // Model-tier breakdown as labeled bar rows (WRITER "token usage by model" style):
  // dot + name + proportional bar + $ + %. More scannable than one thin stacked bar.
  const tierTotal = a.byTier.reduce((x, y) => x + y.costUsd, 0) || 1;
  const tierRows = a.byTier.filter((x) => x.costUsd > 0).sort((x, y) => y.costUsd - x.costUsd).map((x) => {
    const pctv = Math.round((x.costUsd / tierTotal) * 100);
    return `<div class="agg-mrow" title="${x.tier} · ${fmtUsd(x.costUsd)} (${pctv}%)">`
      + `<span class="agg-mrow-name"><span class="si-lg-dot" style="background:${modelColor(x.tier)}"></span>${esc(x.tier)}</span>`
      + `<span class="si-bar"><span class="si-bar-stack" style="width:${Math.max(2, Math.round((x.costUsd / (a.byTier[0].costUsd || 1)) * 100))}%;background:${modelColor(x.tier)}"></span></span>`
      + `<span class="agg-mrow-val mono">${fmtUsdShort(x.costUsd)}</span><span class="agg-mrow-pct mono">${pctv}%</span></div>`;
  }).join('');
  el.innerHTML = (prog ? `<div class="home-scanline">${prog}</div>` : '')
    + fbBanner
    + chips
    + `<div class="agg-chart agg-chart-wide"><div class="agg-chart-title">Daily spend — last 30 active days</div>${svgDailyChart(a.byDay)}</div>`
    + `<div class="agg-charts agg-charts-2col">`
    + `<div class="agg-chart"><div class="agg-chart-title">Spend by repo (top 8)</div>${repoBars || '<p class="muted" style="font-size:11px">—</p>'}</div>`
    + `<div class="agg-chart"><div class="agg-chart-title">Spend by model</div>${tierRows || '<p class="muted" style="font-size:11px">—</p>'}</div>`
    + `</div>`;
}
document.getElementById('home-body')?.addEventListener('click', async (e) => {
  if (e.target.closest('[data-home-allsessions]')) {
    const host = document.getElementById('home-recents'); if (!host) return;
    host.innerHTML = '<p class="muted" style="padding:8px;font-size:12px">Loading every session…</p>';
    let all;
    try { all = await apiFetch('/v1/sessions/all'); }
    catch (err) { host.innerHTML = `<p class="muted" style="padding:8px">Could not load: ${esc(err.message)}</p>`; return; }
    host.innerHTML = `<div class="muted" style="font-size:11px;padding:4px 4px 6px">All ${fmtN(all.total)} sessions on this machine, newest first (conversation cost, est.)</div>`
      + sessHeadHtml('home') + all.sessions.map(homeSessRowHtml).join('');
    return;
  }
  const sess = e.target.closest('[data-home-session]');
  if (sess) {
    const slug = sess.getAttribute('data-home-project');
    if (projectsData && projectsData.activeProjectSlug !== slug) {
      try { await apiFetch('/v1/project/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }); } catch (err) { alert('Could not switch folder: ' + err.message); return; }
      if (projectsData) projectsData.activeProjectSlug = slug;
      resetSessionCaches();
    }
    const openTab = e.target.closest('.sess-badge[data-open]')?.getAttribute('data-open') || null;
    await selectSession(sess.getAttribute('data-home-session'));
    if (openTab) setTab(openTab); // wf/sub badge → jump straight to that view
    return;
  }
  const folder = e.target.closest('[data-home-folder]');
  if (folder) {
    const slug = folder.getAttribute('data-home-folder');
    const repo = folder.getAttribute('data-home-repo');
    try { await apiFetch('/v1/project/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }); } catch (err) { alert('Could not switch folder: ' + err.message); return; }
    resetSessionCaches();
    if (projectsData) projectsData.activeProjectSlug = slug;
    setTab('sessions');
    // Pre-filter the folder picker to this repo so its worktrees are one scan away.
    if (repo) setTimeout(() => { const f = document.getElementById('project-filter'); if (f) { f.value = repo; f.dispatchEvent(new Event('input', { bubbles: true })); } }, 700);
    return;
  }
  const sort = e.target.closest('[data-folder-sort]');
  if (sort) {
    homeFolderSort = sort.getAttribute('data-folder-sort');
    document.querySelectorAll('[data-folder-sort]').forEach((b) => b.classList.toggle('active', b === sort));
    renderHomeFolders();
    return;
  }
  if (e.target.closest('[data-home-allfolders]')) setTab('sessions');
});
document.getElementById('home-refresh')?.addEventListener('click', () => loadHome());
document.querySelectorAll('.tabbar-btn, .subtab-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ── "Copy optimization prompt" — the feedback loop back into Claude Code ──────
// Packages evidence + file/API pointers + a task, so the Claude that receives it
// can analyze real spend and (with consent) write a personalized cost skill.
let lastInsightSummary = null;
function showToast(msg) {
  let t = document.getElementById('ct-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ct-toast'; t.className = 'ct-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t); showToast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function optimizePromptFooter() {
  return `\n## How to work\n`
    + `1. Ground every conclusion in the numbers above (or fetch more via the live API below).\n`
    + `2. Identify the 3-5 biggest cost levers you can actually change (model tier per task type, delegation to cheaper subagents, workflow model mix, prompt/cache stability, avoiding re-reading the same files).\n`
    + `3. Propose concrete changes with expected impact, clearly labeled as estimates.\n`
    + `4. Then OFFER (ask first) to write a personalized cost-discipline skill to ~/.claude/skills/cost-discipline/SKILL.md capturing the durable rules you found — rules grounded in MY observed usage, not generic advice.\n`
    + `\n## Live data API (while the Caliper dashboard is running)\n`
    + `- ${location.origin}/v1/aggregate — machine-wide totals, by-day/by-repo/by-tier\n`
    + `- ${location.origin}/v1/sessions/all — every session with costs\n`
    + `- ${location.origin}/v1/observed and /v1/observed/:id — workflow runs with per-call telemetry\n`
    + `If the API is unreachable, use the snapshot above — it is sufficient.\n`
    + `\n## Honesty requirements\n`
    + `- All dollar figures are cache-aware ESTIMATES reconstructed from transcripts (input×in + cache_write_5m×in×1.25 + cache_write_1h×in×2.0 + cache_read×in×0.10 + output×out at per-model rates), not billed amounts. Say so when you cite them.\n`
    + `- Note sample sizes; do not overfit rules to a single session.\n`
    + `- Cheaper models may need more attempts — present savings as token-economics ceilings, not promises.\n`;
}
function buildOptimizePrompt(scope, runId) {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (scope === 'machine') {
    const a = lastAggData;
    if (!a) return null;
    const t = a.totals;
    const tiers = a.byTier.map((x) => `- ${x.tier}: ${fmtUsdShort(x.costUsd)}`).join('\n');
    const repos = a.byRepo.slice(0, 8).map((r) => `- ${r.repo}: ${fmtUsdShort(r.costUsd)} across ${r.sessions} sessions`).join('\n');
    const cacheRatio = t.tokens.in > 0 ? Math.round(t.tokens.cacheRd / (t.tokens.cacheRd + t.tokens.in) * 100) : 0;
    return `# Optimize my Claude Code spend (machine-wide)\n\nYou are Claude Code running on my machine. Below is my real usage, reconstructed from ~/.claude/projects transcripts by the Caliper dashboard (caliper.run) (snapshot ${ts}).\n\n## Snapshot — all folders, all time\n- Total estimated spend: ${fmtUsdShort(t.costUsd)} across ${fmtN(t.sessions)} sessions in ${fmtN(t.folders)} folders (${a.done ? 'complete scan' : 'partial scan: ' + a.progress.scannedSessions + '/' + a.progress.totalSessions}).\n- Tokens: ${fmtNshort(t.tokens.out)} output · ${fmtNshort(t.tokens.in)} fresh input · ${fmtNshort(t.tokens.cacheRd)} cache reads (${cacheRatio}% of input context came from cache) · ${fmtNshort(t.tokens.cacheWr)} cache writes.\n\n### Spend by model tier\n${tiers}\n\n### Top repos by spend\n${repos}\n` + optimizePromptFooter();
  }
  if (scope === 'session') {
    const i = lastInsightSummary;
    if (!i) return null;
    const models = MODEL_ORDER.filter((m) => i.modelTotals[m]).map((m) => `- ${m}: ${fmtUsdShort(i.modelTotals[m])}`).join('\n');
    const sav = i.savings ? i.savings.lines.map((l) => `- ${l.tier} → ${l.sub.name}: ${fmtUsdShort(l.cur)} → ${fmtUsdShort(l.subCost)}`).join('\n') : '(not computed)';
    return `# Make sessions like this one cheaper and more effective\n\nYou are Claude Code. Analyze this real session of mine (Caliper snapshot ${ts}) and tell me how to run sessions like it better.\n\n## Session\n- Title (first prompt): ${i.title || '(unknown)'}\n- Session id: ${i.sessionId || '?'}\n- Total estimated cost: ${fmtUsdShort(i.total)}${i.spanTxt ? ' · spanned ' + i.spanTxt : ''}\n- Main conversation: ${fmtUsdShort(i.mainCost)} · Workflows: ${fmtUsdShort(i.wfCost)} (${i.wfCount}) · Subagents: ${fmtUsdShort(i.subCost)} (${i.subCount})\n\n### Spend by model\n${models}\n\n### Open-model re-pricing (same tokens, OpenRouter list prices — quality not accounted for)\n${sav}\n` + optimizePromptFooter();
  }
  if (scope === 'workflow') {
    const run = runCache.get(runId);
    if (!run) return null;
    const tel = run.telemetry || {}; const r = tel.run || {}; const calls = tel.calls || [];
    const scriptPath = run.meta?.scriptPath || run.scriptPath || '(unknown — fetch ' + location.origin + '/v1/observed/' + runId + '/script)';
    const phases = (tel.perPhase || []).map((ph) => `- ${ph.phase}: ${ph.calls} calls · ${fmtUsdShort(ph.costUsd)} · wall ${fmtMs(ph.wallMs)}`).join('\n') || '(no phases)';
    const topCalls = [...calls].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10)
      .map((c) => `- ${c.label || c.id}: ${c.tier || c.model} · ${fmtMs(c.ms)} · ${fmtUsdShort(c.costUsd)} (cache-read ${fmtNshort(c.cacheReadTok || 0)})`).join('\n');
    return `# Optimize this Claude Code workflow\n\nYou are Claude Code with file access. This workflow run cost ${fmtUsdShort(r.costUsd)} — analyze it and optimize the WORKFLOW SCRIPT itself (Caliper snapshot ${ts}).\n\n## Run\n- Workflow: ${run.meta?.name || runId} (runId ${runId})\n- Script file (you can read AND edit this): ${scriptPath}\n- ${r.calls || calls.length} agent calls · total ${fmtUsdShort(r.costUsd)} · wall ${fmtMs(r.wallMs)} · naive sum ${fmtMs(r.sumMs)} · speedup ${r.speedup ? r.speedup.toFixed(2) + '×' : '?'}\n\n### Per phase\n${phases}\n\n### Top 10 calls by cost\n${topCalls}\n\n## Specific asks\n- Check each agent() call's model/effort against what its task actually needed (planning/review can justify opus; mechanical work should be sonnet/haiku).\n- Look for calls that could run cheaper, be merged, or be skipped; check whether phases could overlap more (pipeline vs barrier).\n- Show me a diff of the script changes BEFORE applying them.\n` + optimizePromptFooter();
  }
  return null;
}
function showPromptModal(text) {
  let m = document.getElementById('opt-modal');
  if (!m) {
    m = document.createElement('div'); m.id = 'opt-modal'; m.className = 'opt-modal'; m.hidden = true;
    m.innerHTML = '<div class="opt-modal-box"><div class="opt-modal-head"><span>Optimization prompt — paste into Claude Code</span><span style="margin-left:auto;display:flex;gap:8px"><button class="btn btn-secondary btn-sm" type="button" id="opt-modal-copy">Copy</button><button class="btn btn-tertiary btn-sm" type="button" id="opt-modal-close">Close</button></span></div><pre class="opt-modal-pre" id="opt-modal-pre"></pre></div>';
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.id === 'opt-modal-close') m.hidden = true; });
    m.querySelector('#opt-modal-copy').addEventListener('click', () => { navigator.clipboard.writeText(document.getElementById('opt-modal-pre').textContent).then(() => showToast('Copied — paste into Claude Code')); });
  }
  document.getElementById('opt-modal-pre').textContent = text;
  m.hidden = false;
}
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy-optimize]');
  const viewBtn = e.target.closest('[data-view-optimize]');
  if (!copyBtn && !viewBtn) return;
  const el = copyBtn || viewBtn;
  const scope = el.getAttribute(copyBtn ? 'data-copy-optimize' : 'data-view-optimize');
  const text = buildOptimizePrompt(scope, el.getAttribute('data-optimize-run'));
  if (!text) { showToast('Data still loading — try again in a moment'); return; }
  if (copyBtn) navigator.clipboard.writeText(text).then(() => showToast('Copied — paste into Claude Code'), () => showPromptModal(text));
  else showPromptModal(text);
});

// ── Update check: compare local plugin version to GitHub main ─────────────────
async function checkForUpdate() {
  let v = null;
  try { v = await apiFetch('/v1/version'); } catch { return; }
  const bar = document.querySelector('.crumb-bar'); if (!bar || !v) return;
  let pill = document.getElementById('update-pill');
  if (!v.updateAvailable) { if (pill) pill.hidden = true; return; }
  if (!pill) {
    pill = document.createElement('span'); pill.id = 'update-pill'; pill.className = 'update-pill';
    bar.appendChild(pill);
    pill.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-do-update]')) return;
      showToast('Updating…');
      try {
        const r = await apiFetch('/v1/self-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        showToast(r.upToDate ? `Updated to v${r.version} — relaunch /control-tower to apply` : 'Pulled — relaunch to apply');
        pill.hidden = true;
      } catch (err) { showToast('Update failed: ' + err.message + ' — run `claude plugin update caliper`'); }
    });
  }
  pill.innerHTML = `v${esc(v.latest)} available <button class="seg-mini-btn" type="button" data-do-update title="git pull the plugin checkout; then relaunch /control-tower (or run: claude plugin update caliper)">update</button>`;
  pill.hidden = false;
}
checkForUpdate();

init();
// Deep-link support: #/tab/sessionId/agentId restores the exact spot; else land on Sessions.
{
  const st = parseNavHash(location.hash);
  if (st) { applyNavState(st).then(() => history.replaceState(st, '', location.hash)); }
  else { navApplying = true; setTab('home'); navApplying = false; history.replaceState({ tab: 'home', sessionId: null, sub: null }, '', '#/home'); }
}

// Debug/QA handle (module scope hides everything otherwise). Read-only-ish: used by
// browser-based smoke tests to exercise edge cases (zero-cost, partial details) against
// the real render path. Not a public API.
window.__wflens = { renderSessionInsight, loadWfDetails, getSession: () => lastSession, selectSession, getSessions: () => sessionsData };
