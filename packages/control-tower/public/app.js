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
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// Respect OS preference on first load
if (window.matchMedia('(prefers-color-scheme: light)').matches) {
  applyTheme('light');
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
    try { const j = await res.json(); detail = j.message || j.error || detail; } catch {}
    throw new Error(detail);
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

const TIER_COLOR = {
  haiku:  '#3b8e6e',
  sonnet: '#9c6b2e',
  opus:   '#a33',
  fable:  '#6a4ca3',
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
  const callEl = e.target.closest('[data-call-idx]');
  if (callEl) {
    const item = callEl.closest('.obs-run-item'); if (!item) return;
    const run = runCache.get(item.dataset.runId);
    const c = run?.telemetry?.calls?.[Number(callEl.dataset.callIdx)];
    if (!c) return;
    // Agent name (data-drill="inline") → full trace inline; bars/segments/rows → drawer.
    if (callEl.getAttribute('data-drill') === 'inline') {
      const slot = item.querySelector('.obs-call-detail');
      if (slot) renderCallDetailInto(slot, c);
    } else {
      openCallDrawer(c);
    }
    return;
  }
  const row = e.target.closest('.obs-run-row');
  if (row) toggleItem(row.closest('.obs-run-item'));
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
    + `<div class="tl-tip-hint">click to open details →</div>`;
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
function openCallDrawer(c) {
  const dr = document.getElementById('cd-drawer'); const scrim = document.getElementById('cd-scrim');
  if (!dr || !c) return;
  const body = dr.querySelector('.cd-body'); if (body) body.innerHTML = callDetailHtml(c);
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
  // Only show the bar when there's something worth filtering by.
  if (obsFilterEls.bar) obsFilterEls.bar.hidden = !(branches.length > 1 || dirs.length > 1);
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
    obsFilterEls.count.textContent = (b === 'all' && d === 'all')
      ? `${observedRuns.length} run${observedRuns.length === 1 ? '' : 's'}`
      : `${filtered.length} of ${observedRuns.length} runs`;
  }
}

obsFilterEls.branch?.addEventListener('change', applyObservedFilters);
obsFilterEls.dir?.addEventListener('change', applyObservedFilters);

const TIER_COLORS = { haiku: '#3b8e6e', sonnet: '#9c6b2e', opus: '#a33' };
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
    return;
  }
  observedEls.empty.style.display = 'none';
  observedEls.list.innerHTML = runs.map((r) => {
    const sub = [
      esc(fmtWhen(r)),
      r.gitBranch ? esc(r.gitBranch) : '',
      r.cwd ? `<span title="${esc(r.cwd)}">${esc(abbrevDir(r.cwd))}</span>` : '',
    ].filter(Boolean).join('<span class="obs-sub-sep"> · </span>');
    return `
    <div class="obs-run-item" data-run-id="${esc(r.runId)}">
      <button class="obs-run-row" type="button" aria-expanded="false" aria-label="Toggle detail for ${esc(r.name || r.runId)}">
        <span class="obs-run-chevron" aria-hidden="true">▶</span>
        <span class="obs-run-main">
          <span class="obs-run-name">${esc(r.name || r.runId)}</span>
          ${sub ? `<span class="obs-run-sub">${sub}</span>` : ''}
        </span>
        <span class="obs-run-status ${esc(statusClass(r.status))}">${esc(r.status || 'unknown')}</span>
        <span class="obs-run-meta">${r.agentCount || 0} agents &middot; $${Number(r.costUsd || 0).toFixed(5)} &middot; ${fmtMs(r.durationMs || 0)}</span>
      </button>
      <div class="obs-run-detail" hidden></div>
    </div>`;
  }).join('');
}

async function loadObservedList() {
  try {
    const runs = await apiFetch('/v1/observed');
    observedRuns = runs;
    populateObservedFilters(runs);
    applyObservedFilters();
  } catch (err) {
    observedEls.list.innerHTML = `<p class="muted" style="padding:12px">Could not load observed runs: ${esc(err.message)}</p>`;
  }
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

  const when = fmtWhen({ timestamp: run.timestamp, startedAt: run.startTime ? new Date(run.startTime).toISOString() : null });
  const ctx = [
    esc(when),
    run.gitBranch ? esc(run.gitBranch) : '',
    run.cwd ? `<span title="${esc(run.cwd)}">${esc(homeAbbrev(run.cwd))}</span>` : '',
  ].filter(Boolean).join('<span class="obs-sub-sep"> · </span>');

  const stat = (n, label) => `<div class="stat-card"><div class="stat-n">${n}</div><div class="stat-label">${label}</div></div>`;
  const cards = '<div class="stat-cards stat-cards-sm">'
    + stat(String(r.calls ?? calls.length ?? 0), 'Agent Calls')
    + stat('$' + Number(r.costUsd || 0).toFixed(6), 'Cost (cache-aware)')
    + stat(fmtN(r.inTok || 0) + ' / ' + fmtN(r.outTok || 0), 'Tok In / Out')
    + stat(fmtMs(r.wallMs || run.durationMs || 0), 'Wall-Clock')
    + stat((r.speedup || 1) + '×', 'Speedup')
    + '</div>';

  return ''
    + (ctx ? `<div class="obs-detail-context">${ctx}</div>` : '')
    + cards
    + '<section style="margin:14px 0">'
    +   '<div style="font-size:13px;color:var(--gray-1000);margin-bottom:6px">Timeline <span style="color:var(--gray-900);font-size:11px">— each agent split into inference vs tool time, from real transcript timestamps</span></div>'
    +   `<div style="background:var(--bg-100);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto">${buildTimelineSvg(calls)}</div>`
    +   timelineLegend()
    +   '<div class="muted" style="font-size:11px;margin-top:4px">Hover a segment to see what it is. Click an <strong>agent name</strong> for its full trace (below); click a <strong>bar</strong> or table row for quick details (right).</div>'
    + '</section>'
    + '<div class="obs-call-detail" hidden style="margin:14px 0;background:var(--gray-100);border:1px solid var(--border);border-radius:8px;padding:12px"></div>'
    + buildCallsTable(calls)
    + buildTracesStrip(run.traceRecords || [])
    + buildBeaconsStrip(run.beacons || [])
    + '<p class="observed-caveat label-13 muted" style="margin-top:12px">Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10); timing is derived from transcript timestamps. Neither is a live billing API value.</p>';
}

// Per-call table (cache columns); rows carry data-call-idx for the inline drill-in.
function buildCallsTable(calls) {
  const head = '<thead><tr><th>#</th><th>Label</th><th>Tier / Model</th><th>Phase</th><th class="num">ms</th><th class="num">In</th><th class="num">Out</th><th class="num cache-col">Cache Wr</th><th class="num cache-col">Cache Rd</th><th class="num">Cost (cache)</th></tr></thead>';
  const body = !calls.length
    ? '<tr><td colspan="10" class="muted" style="text-align:center;padding:16px">No call data available.</td></tr>'
    : calls.map((c, i) => `
      <tr data-call-idx="${i}" style="cursor:pointer">
        <td class="mono">${esc(String(c.id || ''))}</td>
        <td class="mono" title="${esc(c.agentId || '')}">${esc(c.label || '')}</td>
        <td><span class="tier-dot" style="background:${esc(tierColor(c.tier))}"></span> <span class="mono">${esc(c.tier || '')}</span><br><span class="label-11 muted">${esc((c.model || '').replace('claude-', ''))}</span></td>
        <td class="mono">${esc(c.phase || '—')}</td>
        <td class="num mono">${fmtMs(c.ms)}</td>
        <td class="num mono">${fmtN(c.inTok)}</td>
        <td class="num mono">${fmtN(c.outTok)}</td>
        <td class="num mono cache-col" title="cache_creation tokens">${fmtN(c.cacheCreationTok || 0)}</td>
        <td class="num mono cache-col" title="cache_read tokens">${fmtN(c.cacheReadTok || 0)}</td>
        <td class="num mono">${fmtUsd(c.costUsd)}</td>
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
      bar = segs.map((s) => {
        const f0 = (s.startMs - segs[0].startMs) / segTotal;
        const f1 = (s.endMs - segs[0].startMs) / segTotal;
        const sx = bx + f0 * bw;
        const sw = Math.max(1, (f1 - f0) * bw);
        const segTools = esc((s.tools || []).join(', '));
        // data-seg-* feed the custom hover tooltip; data-call-idx opens the detail drawer.
        return `<rect data-call-idx="${i}" data-seg-kind="${s.kind}" data-seg-dur="${(s.endMs - s.startMs).toFixed(0)}" data-seg-tools="${segTools}" data-seg-label="${esc(c.label || '')}" x="${sx.toFixed(1)}" y="${y + 4}" width="${sw.toFixed(1)}" height="${barH}" fill="${SEG_COLOR[s.kind] || SEG_COLOR.inference}" style="cursor:pointer"></rect>`;
      }).join('');
      // hairline frame so adjacent same-color runs still read as one bar
      bar += `<rect data-call-idx="${i}" x="${bx}" y="${y + 4}" width="${bw}" height="${barH}" rx="2" fill="none" stroke="var(--border)" stroke-width="0.5" style="cursor:pointer"></rect>`;
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

// Legend for the segmented timeline (inference vs tool).
function timelineLegend() {
  const sw = (color, text) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px">`
    + `<span style="width:11px;height:11px;border-radius:2px;background:${color};display:inline-block"></span>`
    + `<span style="font-size:11px;color:var(--gray-900)">${text}</span></span>`;
  return `<div style="margin-top:6px">${sw(SEG_COLOR.inference, 'Inference (model)')}${sw(SEG_COLOR.tool, 'Tool execution')}</div>`;
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
    const name = isTool
      ? (s.tools && s.tools.length ? 'Tool · ' + esc(s.tools.join(', ')) : 'Tool execution')
      : 'Inference';
    return `<div style="display:flex;align-items:center;gap:8px;padding:3px 6px;font-size:12px;border-top:1px solid var(--border)">`
      + `<span class="mono" style="color:var(--gray-500);min-width:22px;text-align:right">${n + 1}</span>`
      + `<span class="tl-tip-dot" style="background:${dot}"></span>`
      + `<span style="color:var(--gray-1000);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>`
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
    + `<div style="font-size:12px;color:var(--gray-900);margin-bottom:4px">Output — its last assistant text</div>`
    + `<pre style="background:var(--bg-200);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;max-height:200px;overflow:auto;color:var(--gray-1000);margin:0">${esc(c.output || '(no text output — tool-only turn)')}</pre>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Expand/collapse one accordion item; lazy-fetch + cache the run on first open.
async function toggleItem(item) {
  if (!item) return;
  const row = item.querySelector('.obs-run-row');
  const detail = item.querySelector('.obs-run-detail');
  const chev = item.querySelector('.obs-run-chevron');
  if (!row || !detail) return;

  const setOpen = (rw, dt, cv, open) => {
    dt.hidden = !open;
    rw.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (cv) cv.textContent = open ? '▼' : '▶';
  };

  if (row.getAttribute('aria-expanded') === 'true') { setOpen(row, detail, chev, false); return; }

  // accordion: collapse any other open item so the page stays tidy
  observedEls.list.querySelectorAll('.obs-run-item').forEach((other) => {
    if (other === item) return;
    const orow = other.querySelector('.obs-run-row');
    if (orow && orow.getAttribute('aria-expanded') === 'true') {
      setOpen(orow, other.querySelector('.obs-run-detail'), other.querySelector('.obs-run-chevron'), false);
    }
  });

  let run = runCache.get(item.dataset.runId);
  if (!run) {
    detail.innerHTML = '<div class="muted" style="padding:12px;font-size:12px">Loading…</div>';
    setOpen(row, detail, chev, true);
    try {
      run = await apiFetch(`/v1/observed/${encodeURIComponent(item.dataset.runId)}`);
      runCache.set(item.dataset.runId, run);
    } catch (err) {
      detail.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">Could not load run: ${esc(err.message)}</div>`;
      return;
    }
  }
  detail.innerHTML = buildDetailHtml(run);
  setOpen(row, detail, chev, true);
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
function setTab(tab) {
  const isObserve = tab === 'observe';
  const tc = document.getElementById('tab-control');
  const to = document.getElementById('tab-observe');
  if (tc) tc.hidden = isObserve;
  if (to) to.hidden = !isObserve;
  // The run-controls chrome belongs to the Control tab only.
  const hide = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = isObserve ? 'none' : ''; };
  hide('.control-bar');
  hide('#workflow-picker');
  hide('.seg-control');
  document.querySelectorAll('.tabbar-btn').forEach((b) => {
    const sel = b.dataset.tab === tab;
    b.setAttribute('aria-selected', sel ? 'true' : 'false');
    b.classList.toggle('active', sel);
  });
  if (isObserve) loadObservedList();
}
document.querySelectorAll('.tabbar-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

init();
setTab('observe');
