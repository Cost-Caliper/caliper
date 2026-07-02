#!/usr/bin/env node
// server.mjs — Control Tower: a Geist-styled observability dashboard over workflow-lens.
//
// Pure node:http — zero extra deps beyond workflow-lens (which pulls only acorn).
// Serves the frontend from public/ (self-contained, no CDN), provides a JSON API
// for workflows/cassettes/runs, and streams SSE telemetry for live runs.
//
// Bridge extensions (new in this version):
//   POST /v1/observe         — beacon ingest from instrumented subagents
//   GET  /v1/observed        — list native harness runs from the session dir
//   GET  /v1/observed/:id    — full reconstructed run (telemetry + traces + beacons)
//   GET  /v1/observed/scripts — list workflow scripts found in session scripts dir
//
// Start: node server.mjs
// PORT env var (default 8787)
// WFLENS_SESSION_DIR env var — override the harness session dir to observe

import http from 'node:http'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'

import * as lens from '../workflow-lens/src/index.mjs'
import { probeCredentials } from './src/credentials.mjs'
import { serveStatic } from './src/static.mjs'
import { createChannel } from './src/sse.mjs'
import { loadWorkflows, loadCassettes, listWorkflows, getWorkflow, listCassettes, getCassettePath } from './src/registry.mjs'
import { executeRun } from './src/runner.mjs'
import { extractEditableAgents, applyEdits } from './src/editor.mjs'
import { deriveOptimizations } from './src/optimize.mjs'
import { distillLearnings, groundingCheck } from '../workflow-lens/src/learnings.mjs'
import { resolveSessionDir, reconstructRun, summaryFromRun, scanCompletedRuns, watchRuns, readRunScript } from './src/observer.mjs'
import { scanSubagentTree, reconstructSubagent } from './src/subagents.mjs'
import { scanProjectSessions, summarizeSessionFile, listProjects, buildHomeData, aggregateMachine, resetAggregateScan, listAllSessions } from './src/sessions.mjs'
import { homedir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '8787', 10)
const LENSVERSION = '0.1.0'  // workflow-lens version (from its package.json)

// ── Bridge: session dir + beacon store ───────────────────────────────────────
// SESS and PROJECT_DIR are MUTABLE: the Sessions browser can switch the active
// project (folder) and session at runtime (POST /v1/project/select, /v1/session/select).
// All observed/subagents routes read SESS at call time. PROJECTS_ROOT is fixed:
// the ~/.claude/projects dir that holds one subdir per project the user ran Claude in.
let SESS = resolveSessionDir()
let PROJECT_DIR = SESS ? dirname(String(SESS).replace(/[/\\]+$/, '')) : null
const PROJECTS_ROOT = process.env.WFLENS_PROJECTS_ROOT
  || (PROJECT_DIR ? dirname(PROJECT_DIR) : join(homedir(), '.claude', 'projects'))
if (SESS) {
  console.log(`[bridge] observing session dir: ${SESS}`)
  console.log(`[bridge] project dir: ${PROJECT_DIR}`)
} else {
  console.log('[bridge] WFLENS_SESSION_DIR not set — observed-runs features disabled. Set WFLENS_SESSION_DIR to enable.')
}
console.log(`[bridge] projects root (folder browser): ${PROJECTS_ROOT}`)

// ── Version / update check ────────────────────────────────────────────────────
const REPO_ROOT = join(__dir, '..', '..')
function localVersion() {
  try { return JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null } catch { return null }
}
let versionCache = null // { at, payload }
async function checkVersion() {
  if (versionCache && Date.now() - versionCache.at < 3600_000) return versionCache.payload
  const current = localVersion()
  let latest = null
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500)
    const r = await fetch('https://raw.githubusercontent.com/dennisonbertram/workflow-lens/main/.claude-plugin/plugin.json', { signal: ctl.signal })
    clearTimeout(t)
    if (r.ok) latest = (await r.json()).version || null
  } catch { /* offline — fail soft */ }
  const cmp = (a, b) => { // semver-ish compare: 1 if a > b
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1 }
    return 0
  }
  const payload = { current, latest, updateAvailable: !!(current && latest && cmp(latest, current) > 0), checkedAt: Date.now() }
  versionCache = { at: Date.now(), payload }
  return payload
}

// In-memory beacon store: stores beacons by both runId and instrumentationId
// so the observer can correlate without knowing the runId.
//   beaconByRunId: runId -> [{ev, ...}]
//   beaconByInstrumentationId: instrumentationId -> [{ev, ...}]
const beaconByRunId = new Map()
const beaconByInstrumentationId = new Map()
// Legacy alias kept for backward compat in GET /v1/health
const beaconStore = beaconByRunId

function addBeacon(payload) {
  const record = { ...payload, _arrivedAt: Date.now() }
  // Index by runId (optional — may not be present in beacon payloads)
  if (payload.runId) {
    if (!beaconByRunId.has(payload.runId)) beaconByRunId.set(payload.runId, [])
    beaconByRunId.get(payload.runId).push(record)
  }
  // Index by instrumentationId (the stable key baked into the instrumented source)
  if (payload.instrumentationId) {
    if (!beaconByInstrumentationId.has(payload.instrumentationId)) beaconByInstrumentationId.set(payload.instrumentationId, [])
    beaconByInstrumentationId.get(payload.instrumentationId).push(record)
  }
}

function beaconsFor(runId) {
  return beaconByRunId.get(runId) || []
}

function beaconsForInstrumentationId(instrumentationId) {
  return beaconByInstrumentationId.get(instrumentationId) || []
}

// SSE channel for the "Observed Runs" stream — broadcasts updates to all listeners
const observedChannel = createChannel()

// ── Run state ─────────────────────────────────────────────────────────────────
// In-memory map of runId -> run record (capped at 20 runs)
const runs = new Map()
let runCounter = 0
const RUN_LIMIT = 20

function nextRunId() {
  runCounter++
  return String(runCounter)
}

function storeRun(id, rec) {
  runs.set(id, rec)
  // Evict oldest if over limit
  if (runs.size > RUN_LIMIT) {
    const oldest = runs.keys().next().value
    const oldRec = runs.get(oldest)
    if (oldRec && oldRec.channel) oldRec.channel.closeAll()
    runs.delete(oldest)
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
function jsonOk(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function jsonErr(res, code, message, status = 400) {
  jsonOk(res, { error: { code, message } }, status)
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) }
      catch (e) { reject(new Error('Invalid JSON: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

// ── Route matching ────────────────────────────────────────────────────────────
function matchRoute(method, url, pattern) {
  const [patMethod, patPath] = pattern.split(' ')
  if (method !== patMethod) return null
  const urlClean = url.split('?')[0]
  const patParts = patPath.split('/')
  const urlParts = urlClean.split('/')
  if (patParts.length !== urlParts.length) return null
  const params = {}
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i])
    } else if (patParts[i] !== urlParts[i]) {
      return null
    }
  }
  return params
}

// ── Request handler ───────────────────────────────────────────────────────────
async function handle(req, res) {
  const method = req.method || 'GET'
  const url = req.url || '/'
  const urlPath = url.split('?')[0]

  // CORS for dev
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // ── GET /v1/health ───────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/v1/health') {
    const creds = probeCredentials(process.env)
    jsonOk(res, {
      ok: true,
      lensVersion: LENSVERSION,
      node: process.version,
      providers: { anthropic: creds.anthropic, openrouter: creds.openrouter },
      workflowCount: listWorkflows().length,
      cassetteCount: listCassettes().length,
      bridge: {
        sessionDir: SESS || null,
        sessionId: SESS ? basename(String(SESS).replace(/[/\\]+$/, '')) : null,
        projectDir: PROJECT_DIR,
        observeEnabled: Boolean(SESS),
        beaconRunIds: [...beaconByRunId.keys()],
        beaconInstrumentationIds: [...beaconByInstrumentationId.keys()],
      },
    })
    return
  }

  // ── GET /v1/home — cross-folder dashboard (recents, live, bounded spend rollups) ──
  if (method === 'GET' && urlPath === '/v1/home') {
    const home = buildHomeData(PROJECTS_ROOT)
    home.activeProjectSlug = PROJECT_DIR ? basename(PROJECT_DIR) : null
    home.activeSessionId = SESS ? basename(String(SESS).replace(/[/\\]+$/, '')) : null
    jsonOk(res, home)
    return
  }

  // ── GET /v1/aggregate — MACHINE-WIDE totals/charts (incremental; poll until done) ──
  if (method === 'GET' && urlPath === '/v1/aggregate') {
    const u = new URL(url, 'http://x')
    if (u.searchParams.get('restart') === '1') resetAggregateScan()
    jsonOk(res, aggregateMachine(PROJECTS_ROOT, { budgetMs: Math.min(4000, parseInt(u.searchParams.get('budgetMs') || '1500', 10) || 1500) }))
    return
  }

  // ── GET /v1/version — local plugin version + GitHub update check (cached 1h) ──
  if (method === 'GET' && urlPath === '/v1/version') {
    jsonOk(res, await checkVersion())
    return
  }

  // ── POST /v1/self-update — git pull the plugin checkout (local, single-user) ──
  if (method === 'POST' && urlPath === '/v1/self-update') {
    try {
      const { execFileSync } = await import('node:child_process')
      const out = execFileSync('git', ['-C', REPO_ROOT, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 30000 })
      versionCache = null // re-check after pulling
      const v = await checkVersion()
      jsonOk(res, { ok: true, output: out.trim().slice(0, 500), version: v.current, upToDate: !v.updateAvailable, note: 'Restart the Control Tower server (relaunch /control-tower) to run the new version.' })
    } catch (e) {
      jsonErr(res, 'UPDATE_FAILED', String(e.message || e).slice(0, 300), 500)
    }
    return
  }

  // ── GET /v1/sessions/all — every session on the machine (folder attached) ─────
  if (method === 'GET' && urlPath === '/v1/sessions/all') {
    const lim = Math.min(5000, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('limit') || '2000', 10) || 2000))
    jsonOk(res, listAllSessions(PROJECTS_ROOT, { limit: lim }))
    return
  }

  // ── GET /v1/projects — every project (folder) Claude has run in ───────────────
  if (method === 'GET' && urlPath === '/v1/projects') {
    const projects = listProjects(PROJECTS_ROOT)
    jsonOk(res, {
      projectsRoot: PROJECTS_ROOT,
      activeProjectSlug: PROJECT_DIR ? basename(PROJECT_DIR) : null,
      projects,
    })
    return
  }

  // ── POST /v1/project/select — switch the active project folder ────────────────
  if (method === 'POST' && urlPath === '/v1/project/select') {
    let body
    try { body = await parseBody(req) } catch (e) { jsonErr(res, 'BAD_REQUEST', 'Invalid JSON: ' + e.message); return }
    const proj = listProjects(PROJECTS_ROOT).find((p) => p.slug === String(body.slug || ''))
    if (!proj) { jsonErr(res, 'NOT_FOUND', 'No such project under the projects root', 404); return }
    PROJECT_DIR = proj.dir
    // Point the active session at the newest session in the new project (if any).
    const newest = scanProjectSessions(PROJECT_DIR, { limit: 1 }).sessions[0] || null
    SESS = newest ? join(PROJECT_DIR, newest.id) : null
    console.log(`[bridge] switched active project → ${PROJECT_DIR} (session: ${newest ? newest.id : 'none'})`)
    jsonOk(res, { ok: true, projectDir: PROJECT_DIR, cwd: proj.cwd, activeSessionId: newest ? newest.id : null })
    return
  }

  // ── GET /v1/sessions — every session in the project dir (Sessions browser) ────
  if (method === 'GET' && urlPath === '/v1/sessions') {
    if (!PROJECT_DIR) { jsonErr(res, 'NOT_CONFIGURED', 'WFLENS_SESSION_DIR is not set — no project dir to browse', 503); return }
    const limit = Math.min(200, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('limit') || '40', 10) || 40))
    const out = scanProjectSessions(PROJECT_DIR, { limit })
    out.activeSessionId = SESS ? basename(String(SESS).replace(/[/\\]+$/, '')) : null
    jsonOk(res, out)
    return
  }

  // ── GET /v1/session/active — identity of the currently-viewed session (for the strip) ──
  if (method === 'GET' && urlPath === '/v1/session/active') {
    const id = SESS ? basename(String(SESS).replace(/[/\\]+$/, '')) : null
    const session = id && PROJECT_DIR ? summarizeSessionFile(PROJECT_DIR, id) : null
    jsonOk(res, { sessionId: id, projectDir: PROJECT_DIR, session })
    return
  }

  // ── POST /v1/session/select — switch the active session (localhost, single user) ──
  if (method === 'POST' && urlPath === '/v1/session/select') {
    if (!PROJECT_DIR) { jsonErr(res, 'NOT_CONFIGURED', 'WFLENS_SESSION_DIR is not set — no project dir to browse', 503); return }
    let body
    try { body = await parseBody(req) } catch (e) { jsonErr(res, 'BAD_REQUEST', 'Invalid JSON: ' + e.message); return }
    const summary = summarizeSessionFile(PROJECT_DIR, body.id) // validates the uuid + existence
    if (!summary) { jsonErr(res, 'NOT_FOUND', 'No such session in this project', 404); return }
    SESS = join(PROJECT_DIR, summary.id)
    console.log(`[bridge] switched active session → ${SESS}`)
    jsonOk(res, { ok: true, sessionId: summary.id, sessionDir: SESS, session: summary })
    return
  }

  // ── GET /v1/about ────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/v1/about') {
    jsonOk(res, {
      timingCaveat: 'Every ms / speedup is measured by the external shim ledger (a real monotonic clock outside the workflow), not the in-harness tracer. The harness bans Date.now() / Math.random() / argless new Date() for resume-safety. Timing from the in-harness tracer is not available.',
      costCaveat: 'Cost is derived from the Anthropic/OpenRouter price table, not a live billing API. Actual invoiced cost may differ.',
      liveCaveat: 'Live runs cost real cents and need ANTHROPIC_API_KEY or OPENROUTER_API_KEY. The server fails closed if the key is absent.',
      replayCaveat: 'Replay (cassette) runs are free and deterministic. Timing shown for replay is not meaningful — the cassette returns immediately.',
      groundingCaveat: 'Learnings produced by Write Learnings are grounded: every cite must literally appear in the run input. Non-grounded learnings are dropped.',
      observedCostCaveat: 'Observed-run cost is reconstructed from harness transcripts (agent-*.jsonl) using the Anthropic ephemeral-cache pricing convention: cache_creation tokens × 1.25, cache_read tokens × 0.10. These multipliers are conventional estimates; actual billed cost may differ.',
      observedTimingCaveat: 'Observed-run per-agent timing is derived from transcript timestamps (firstTimestamp to lastTimestamp in the assistant turns). This reflects real wall-clock latency but may be slightly wider than the true model-only latency.',
      beaconCaveat: 'Beacons (from injected subagents curling POST /v1/observe) are a real separate subagent call and cost a small amount. The injected agent keeps its judgment — benign curl instructions comply; injection attempts are refused (proven: wf_f206a8ce-85b).',
    })
    return
  }

  // ── GET /v1/workflows ────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/v1/workflows') {
    jsonOk(res, listWorkflows())
    return
  }

  // ── GET /v1/workflows/:id ────────────────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/workflows/:id')
    if (params) {
      const w = getWorkflow(params.id)
      if (!w) { jsonErr(res, 'NOT_FOUND', `Workflow "${params.id}" not found`, 404); return }
      let est = null
      try { est = lens.estimate(w.src) } catch { /* non-fatal */ }
      let graphSvgStr = ''
      try { graphSvgStr = lens.graphSvg(w.graph) } catch { /* non-fatal */ }
      jsonOk(res, {
        id: w.id,
        name: w.name,
        description: w.description,
        src: w.src,
        lint: { ok: w.lintResult?.ok === true, findings: Array.isArray(w.lintResult?.findings) ? w.lintResult.findings : [] },
        graph: w.graph,
        graphSvg: graphSvgStr,
        estimate: est,
      })
      return
    }
  }

  // ── GET /v1/workflows/:id/editable ───────────────────────────────────────────
  {
    const parts = urlPath.split('/')
    if (method === 'GET' && parts.length === 5 && parts[2] === 'workflows' && parts[4] === 'editable') {
      const id = decodeURIComponent(parts[3])
      const w = getWorkflow(id)
      if (!w) { jsonErr(res, 'NOT_FOUND', `Workflow "${id}" not found`, 404); return }
      const ext = extractEditableAgents(w.src)
      jsonOk(res, {
        id,
        name: w.name,
        agents: ext.agents,
        modelOptions: ext.modelOptions,
        note: 'Edits splice the original source in place, so loops/.map() are preserved. Agents built dynamically (e.g. inside .map()) are not individually listed — only statically-declared agent() calls appear.',
      })
      return
    }
  }

  // ── POST /v1/workflows/:id/edit-run ──────────────────────────────────────────
  {
    const parts = urlPath.split('/')
    if (method === 'POST' && parts.length === 5 && parts[2] === 'workflows' && parts[4] === 'edit-run') {
      const id = decodeURIComponent(parts[3])
      const w = getWorkflow(id)
      if (!w) { jsonErr(res, 'NOT_FOUND', `Workflow "${id}" not found`, 404); return }

      let body
      try { body = await parseBody(req) } catch (e) { jsonErr(res, 'BAD_REQUEST', e.message); return }
      const {
        edits = [],
        mode = 'live',
        cassette: cassetteId,
        capUsd = null,
        provider = 'anthropic',
        useRouter = false,
        useGate = false,
        record = false,
      } = body

      // 1. Apply edits to the source (parse-safe)
      let editedSrc
      try { editedSrc = applyEdits(w.src, edits) }
      catch (e) { jsonErr(res, 'EDIT_INVALID', e.message, 400); return }

      // 2. Lint the edited source — reject resume-unsafe results
      const lintRes = lens.lint(editedSrc)
      if (!lintRes.ok) {
        jsonErr(res, 'EDIT_INVALID', 'Edited workflow failed lint: ' + lintRes.findings.map((f) => f.message).join('; '), 400)
        return
      }

      // 3. Fail-closed cred check for live mode (copied from POST /v1/runs)
      if (mode === 'live') {
        const creds = probeCredentials(process.env)
        const needsKey = provider === 'openrouter' ? 'openrouter' : 'anthropic'
        if (!creds[needsKey]) {
          jsonErr(res, 'MISSING_CREDENTIAL', `${provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY'} is not set. Set it before running live.`, 412)
          return
        }
      }

      // 4. Resolve cassette for replay mode (same logic as POST /v1/runs)
      let cassettePath = null
      if (mode === 'replay') {
        cassettePath = getCassettePath(cassetteId || id) || getCassettePath(id)
        if (!cassettePath) {
          jsonErr(res, 'CACHE_MISS', `No cassette found for "${cassetteId || id}". Run live with record:true first.`, 412)
          return
        }
      }

      // 5. Build the edited graph + write the edited source to a temp file (runWorkflow reads a PATH)
      let editedGraph
      try { editedGraph = lens.buildGraph(editedSrc) } catch (e) { jsonErr(res, 'EDIT_INVALID', 'Edited workflow graph build failed: ' + e.message, 400); return }

      const runId = nextRunId()
      const channel = createChannel()
      const editedDir = join(__dir, '.edited')
      mkdirSync(editedDir, { recursive: true })
      const editedPath = join(editedDir, `${id}-r${runId}.workflow.js`)
      writeFileSync(editedPath, editedSrc, 'utf8')

      const runRecord = {
        runId,
        workflowId: id,
        mode,
        status: 'running',
        channel,
        snapshot: null,
        error: null,
        startedAt: new Date().toISOString(),
        editedSrc,
        editedPath,
        edits,
      }
      storeRun(runId, runRecord)

      executeRun({
        workflowId: id,
        workflowPath: editedPath,
        workflowSrc: editedSrc,
        graph: editedGraph,
        mode,
        cassettePath,
        capUsd: capUsd != null ? Number(capUsd) : null,
        provider,
        useRouter: Boolean(useRouter),
        useGate: Boolean(useGate),
        record: Boolean(record),
        emit: (type, data) => channel.emit(type, data),
        env: process.env,
      }).then((snap) => {
        runRecord.snapshot = snap
        runRecord.status = snap.status
        channel.stopKeepAlive()
      }).catch((e) => {
        runRecord.status = 'error'
        runRecord.error = { code: e.code || 'INTERNAL', message: e.message }
        channel.emit('error', { code: e.code || 'INTERNAL', message: e.message, envVar: e.envVar, provider: e.provider })
        channel.stopKeepAlive()
      })

      jsonOk(res, { runId, streamUrl: `/v1/runs/${runId}/stream`, edited: true }, 201)
      return
    }
  }

  // ── GET /v1/cassettes ────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/v1/cassettes') {
    jsonOk(res, listCassettes())
    return
  }

  // ── POST /v1/runs ────────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/v1/runs') {
    let body
    try { body = await parseBody(req) } catch (e) { jsonErr(res, 'BAD_REQUEST', e.message); return }

    const {
      workflowId,
      mode = 'live',
      cassette: cassetteId,
      capUsd = null,
      provider = 'anthropic',
      useRouter = false,
      useGate = false,
      record = false,
    } = body

    if (!workflowId) { jsonErr(res, 'BAD_REQUEST', 'workflowId is required'); return }
    const w = getWorkflow(workflowId)
    if (!w) { jsonErr(res, 'NOT_FOUND', `Workflow "${workflowId}" not found`, 404); return }

    // Fail-closed: check credentials for live mode before starting
    if (mode === 'live') {
      const creds = probeCredentials(process.env)
      const needsKey = provider === 'openrouter' ? 'openrouter' : 'anthropic'
      if (!creds[needsKey]) {
        jsonErr(res, 'MISSING_CREDENTIAL', `${provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY'} is not set. Set it before running live.`, 412)
        return
      }
    }

    // Resolve cassette for replay mode
    let cassettePath = null
    if (mode === 'replay') {
      const resolvedId = cassetteId || workflowId
      cassettePath = getCassettePath(resolvedId)
      if (!cassettePath) {
        // Try workflowId directly
        const altPath = getCassettePath(workflowId)
        cassettePath = altPath
      }
      if (!cassettePath) {
        jsonErr(res, 'CACHE_MISS', `No cassette found for "${resolvedId}". Run in live mode with record:true first.`, 412)
        return
      }
    }

    const runId = nextRunId()
    const channel = createChannel()

    // Start run async — don't await here, let SSE stream drive it
    const runRecord = {
      runId,
      workflowId,
      mode,
      status: 'running',
      channel,
      snapshot: null,
      error: null,
      startedAt: new Date().toISOString(),
    }
    storeRun(runId, runRecord)

    // Fire async
    executeRun({
      workflowId,
      workflowPath: w.path,
      workflowSrc: w.src,
      graph: w.graph,
      mode,
      cassettePath,
      capUsd: capUsd != null ? Number(capUsd) : null,
      provider,
      useRouter: Boolean(useRouter),
      useGate: Boolean(useGate),
      record: Boolean(record),
      emit: (type, data) => channel.emit(type, data),
      env: process.env,
    }).then((snap) => {
      runRecord.snapshot = snap
      runRecord.status = snap.status
      channel.stopKeepAlive()
    }).catch((e) => {
      runRecord.status = 'error'
      runRecord.error = { code: e.code || 'INTERNAL', message: e.message }
      channel.emit('error', { code: e.code || 'INTERNAL', message: e.message, envVar: e.envVar, provider: e.provider })
      channel.stopKeepAlive()
    })

    jsonOk(res, { runId, streamUrl: `/v1/runs/${runId}/stream` }, 201)
    return
  }

  // ── GET /v1/runs/:runId/stream ────────────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/runs/:runId/stream')
    if (params) {
      const run = runs.get(params.runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${params.runId}" not found`, 404); return }
      run.channel.attach(res)
      return  // don't end — SSE stream stays open
    }
  }

  // ── GET /v1/runs/:runId ───────────────────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/runs/:runId')
    if (params && !urlPath.endsWith('/stream') && !urlPath.endsWith('/report.html') && !urlPath.endsWith('/optimize') && !urlPath.endsWith('/learn')) {
      const run = runs.get(params.runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${params.runId}" not found`, 404); return }
      if (run.status === 'running') {
        jsonOk(res, { runId: params.runId, status: 'running', snapshot: null })
      } else if (run.error) {
        jsonOk(res, { runId: params.runId, status: 'error', error: run.error })
      } else {
        jsonOk(res, { runId: params.runId, status: run.status, ...run.snapshot })
      }
      return
    }
  }

  // ── GET /v1/runs/:runId/report.html ──────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/runs/:runId/report.html')
    if (params) {
      const run = runs.get(params.runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${params.runId}" not found`, 404); return }
      if (!run.snapshot || !run.snapshot.telemetry) {
        jsonErr(res, 'NOT_READY', 'Run is still in progress or failed', 409); return
      }
      const html = lens.renderRun({
        meta: run.snapshot.meta || {},
        graph: run.snapshot.graph || {},
        telemetry: run.snapshot.telemetry || {},
      })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
  }

  // ── GET /v1/runs/:runId/optimize ──────────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/runs/:runId/optimize')
    if (params) {
      const run = runs.get(params.runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${params.runId}" not found`, 404); return }
      if (!run.snapshot || !run.snapshot.telemetry) {
        jsonErr(res, 'NOT_READY', 'Run is still in progress or failed', 409); return
      }
      const opts = deriveOptimizations(run.snapshot.telemetry)
      jsonOk(res, opts)
      return
    }
  }

  // ── POST /v1/runs/:runId/apply-optimization ──────────────────────────────────
  {
    const parts = urlPath.split('/')
    if (method === 'POST' && parts.length === 5 && parts[4] === 'apply-optimization') {
      const runId = parts[3]
      const run = runs.get(runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${runId}" not found`, 404); return }
      if (!run.snapshot) { jsonErr(res, 'NOT_READY', 'Original run not finished', 409); return }

      let body
      try { body = await parseBody(req) } catch (e) { jsonErr(res, 'BAD_REQUEST', e.message); return }

      // Build a new run body from the suggestion's proposedRunBody merged with the original run
      const proposed = body.proposedRunBody || {}
      const newRunBody = {
        workflowId: run.workflowId,
        mode: run.mode,
        ...proposed,
      }

      // We reuse the same POST /v1/runs logic by internally calling it
      const w = getWorkflow(run.workflowId)
      if (!w) { jsonErr(res, 'NOT_FOUND', `Workflow "${run.workflowId}" not found`, 404); return }

      if (newRunBody.mode === 'live') {
        const creds = probeCredentials(process.env)
        const prov = newRunBody.provider || 'anthropic'
        const needsKey = prov === 'openrouter' ? 'openrouter' : 'anthropic'
        if (!creds[needsKey]) {
          jsonErr(res, 'MISSING_CREDENTIAL', `${needsKey.toUpperCase()}_API_KEY is not set`, 412)
          return
        }
      }

      const newRunId = nextRunId()
      const newChannel = createChannel()
      const newRunRecord = {
        runId: newRunId,
        workflowId: run.workflowId,
        mode: newRunBody.mode || 'live',
        status: 'running',
        channel: newChannel,
        snapshot: null,
        error: null,
        startedAt: new Date().toISOString(),
        previousRunId: runId,
      }
      storeRun(newRunId, newRunRecord)

      executeRun({
        workflowId: run.workflowId,
        workflowPath: w.path,
        workflowSrc: w.src,
        graph: w.graph,
        mode: newRunBody.mode || 'live',
        cassettePath: getCassettePath(newRunBody.cassette || run.workflowId),
        capUsd: newRunBody.capUsd != null ? Number(newRunBody.capUsd) : null,
        provider: newRunBody.provider || 'anthropic',
        useRouter: Boolean(newRunBody.useRouter),
        useGate: Boolean(newRunBody.useGate),
        record: Boolean(newRunBody.record),
        emit: (type, data) => newChannel.emit(type, data),
        env: process.env,
      }).then((snap) => {
        newRunRecord.snapshot = snap
        newRunRecord.status = snap.status
        newChannel.stopKeepAlive()
      }).catch((e) => {
        newRunRecord.status = 'error'
        newRunRecord.error = { code: e.code || 'INTERNAL', message: e.message }
        newChannel.emit('error', { code: e.code || 'INTERNAL', message: e.message })
        newChannel.stopKeepAlive()
      })

      jsonOk(res, { runId: newRunId, streamUrl: `/v1/runs/${newRunId}/stream`, previousRunId: runId }, 201)
      return
    }
  }

  // ── POST /v1/runs/:runId/learn ─────────────────────────────────────────────
  {
    const parts = urlPath.split('/')
    if (method === 'POST' && parts.length === 5 && parts[4] === 'learn') {
      const runId = parts[3]
      const run = runs.get(runId)
      if (!run) { jsonErr(res, 'NOT_FOUND', `Run "${runId}" not found`, 404); return }
      if (!run.snapshot || !run.snapshot.telemetry) {
        jsonErr(res, 'NOT_READY', 'Run is still in progress or failed', 409); return
      }

      const creds = probeCredentials(process.env)
      if (!creds.anthropic) {
        jsonErr(res, 'MISSING_CREDENTIAL', 'ANTHROPIC_API_KEY is required for Write Learnings (used for haiku distillation)', 412)
        return
      }

      // Start SSE for the learn endpoint — use the existing channel
      // We emit distill-start, distill-done (or error) into the run's channel
      run.channel.emit('distill-start', { runId })

      const outDir = join(__dir, 'learnings', runId)
      mkdirSync(outDir, { recursive: true })

      const snap = run.snapshot.telemetry
      const meta = { metaName: run.snapshot.meta?.name || run.workflowId }

      distillLearnings({
        traceLines: [],  // we don't have in-harness trace lines (no inject.mjs in this path)
        ledger: snap,
        meta,
        outDir,
        writeDisk: true,
        apiKey: process.env.ANTHROPIC_API_KEY,
      }).then((learnings) => {
        const gc = groundingCheck(learnings, { traceLines: [], ledger: snap })
        run.channel.emit('distill-done', {
          learnings,
          groundingPassed: gc.passed.length,
          groundingFailed: gc.failed.length,
          mdUrl: `/learnings/${runId}/learnings.md`,
        })
        run.learnings = learnings
        run.learningsDir = outDir
      }).catch((e) => {
        run.channel.emit('error', { code: 'INTERNAL', message: `Learn failed: ${e.message}` })
      })

      // Return immediately — the result will be streamed via the SSE channel
      jsonOk(res, { ok: true, message: 'Distilling… check the SSE stream for distill-done event', runId })
      return
    }
  }

  // ── POST /v1/observe ─────────────────────────────────────────────────────────
  // Beacon ingest from injected subagents (the proven outbound path from wf_f206a8ce-85b).
  // Expects: {runId, ev:'run-start'|'phase'|'run-end', phase?, name?, ...}
  // Fail-soft: malformed body -> 400 but never throws.
  if (method === 'POST' && urlPath === '/v1/observe') {
    let body
    try { body = await parseBody(req) } catch (e) {
      jsonErr(res, 'BAD_REQUEST', 'Invalid JSON: ' + e.message)
      return
    }
    if (!body.ev) {
      jsonErr(res, 'BAD_REQUEST', 'ev is required')
      return
    }
    // Require at least one correlation key: runId or instrumentationId
    if (!body.runId && !body.instrumentationId) {
      jsonErr(res, 'BAD_REQUEST', 'runId or instrumentationId is required')
      return
    }
    // Accepted ev values
    const validEvs = ['run-start', 'phase', 'run-end']
    if (!validEvs.includes(body.ev)) {
      jsonErr(res, 'BAD_REQUEST', `ev must be one of: ${validEvs.join(', ')}`)
      return
    }
    addBeacon(body)
    // Emit to the observed SSE channel so live listeners update immediately
    observedChannel.emit('beacon', body)
    const corrKey = body.runId ? `runId=${body.runId}` : `instrumentationId=${body.instrumentationId}`
    console.log(`[bridge] beacon: ${corrKey} ev=${body.ev}`)
    jsonOk(res, { ok: true, runId: body.runId || null, instrumentationId: body.instrumentationId || null, ev: body.ev })
    return
  }

  // ── GET /v1/observed/scripts ──────────────────────────────────────────────
  // Returns workflow .js sources found in SESS/workflows/scripts/
  if (method === 'GET' && urlPath === '/v1/observed/scripts') {
    if (!SESS) { jsonOk(res, []); return }
    const scriptsDir = join(SESS, 'workflows', 'scripts')
    if (!existsSync(scriptsDir)) { jsonOk(res, []); return }
    try {
      const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.js')).sort()
      const scripts = files.map((f) => {
        const nameMatch = f.match(/^(.+?)-wf_([0-9a-f-]+)\.js$/)
        return {
          file: f,
          name: nameMatch ? nameMatch[1] : basename(f, '.js'),
          runId: nameMatch ? nameMatch[2] : null,
          path: join(scriptsDir, f),
        }
      })
      jsonOk(res, scripts)
    } catch (e) {
      jsonErr(res, 'INTERNAL', e.message, 500)
    }
    return
  }

  // ── GET /v1/observed/stream ───────────────────────────────────────────────
  // SSE stream: broadcasts beacon arrivals + run updates to all listeners.
  if (method === 'GET' && urlPath === '/v1/observed/stream') {
    observedChannel.attach(res)
    return
  }

  // ── GET /v1/observed/:runId/script — the workflow source + its on-disk path ───
  {
    const params = matchRoute(method, urlPath, 'GET /v1/observed/:runId/script')
    if (params) {
      if (!SESS) { jsonErr(res, 'NOT_CONFIGURED', 'WFLENS_SESSION_DIR is not set', 503); return }
      const script = readRunScript(params.runId, SESS)
      if (!script) { jsonErr(res, 'NOT_FOUND', `No script for run "${params.runId}"`, 404); return }
      jsonOk(res, script)
      return
    }
  }

  // ── GET /v1/observed/:runId ───────────────────────────────────────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/observed/:runId')
    if (params && !urlPath.endsWith('/stream')) {
      if (!SESS) {
        jsonErr(res, 'NOT_CONFIGURED', 'WFLENS_SESSION_DIR is not set — cannot observe native runs', 503)
        return
      }
      const run = reconstructRun(params.runId, SESS, beaconsFor(params.runId), beaconByInstrumentationId)
      if (!run) {
        jsonErr(res, 'NOT_FOUND', `Observed run "${params.runId}" not found`, 404)
        return
      }
      jsonOk(res, run)
      return
    }
  }

  // ── GET /v1/observed ─────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/v1/observed') {
    if (!SESS) {
      jsonOk(res, [])
      return
    }
    const list = scanCompletedRuns(SESS)
    // Merge in any beacons-only runs (runs that posted beacons but wf_*.json hasn't landed yet)
    for (const [runId, beacons] of beaconStore.entries()) {
      if (!list.find((r) => r.runId === runId)) {
        list.unshift({
          runId,
          name: beacons[0]?.name || runId,
          status: 'running',
          source: 'observed-native',
          agentCount: 0,
          totalTokens: 0,
          costUsd: 0,
          durationMs: 0,
          startedAt: beacons[0]?._arrivedAt ? new Date(beacons[0]._arrivedAt).toISOString() : null,
          timestamp: null,
        })
      }
    }
    jsonOk(res, list)
    return
  }

  // ── GET /v1/subagents/:id — full detail for one subagent (lazy) ───────────────
  {
    const params = matchRoute(method, urlPath, 'GET /v1/subagents/:id')
    if (params) {
      if (!SESS) { jsonErr(res, 'NOT_CONFIGURED', 'WFLENS_SESSION_DIR is not set — cannot observe subagents', 503); return }
      const detail = reconstructSubagent(SESS, params.id)
      if (!detail) { jsonErr(res, 'NOT_FOUND', `Subagent "${params.id}" not found`, 404); return }
      jsonOk(res, detail)
      return
    }
  }

  // ── GET /v1/subagents — direct-subagent forest (parent→child tree) for the session ──
  if (method === 'GET' && urlPath === '/v1/subagents') {
    if (!SESS) { jsonOk(res, { sessionId: null, root: null, rollup: null }); return }
    jsonOk(res, scanSubagentTree(SESS))
    return
  }

  // ── Static files (frontend) ────────────────────────────────────────────────
  if (method === 'GET' && serveStatic(req, res)) return

  // ── 404 ───────────────────────────────────────────────────────────────────
  jsonErr(res, 'NOT_FOUND', `${method} ${urlPath} not found`, 404)
}

// ── Server bootstrap ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (e) {
    console.error('[server] unhandled error:', e)
    if (!res.headersSent) {
      try { jsonErr(res, 'INTERNAL', e.message, 500) } catch { /* ignore write errors */ }
    }
  }
})

// Ensure learnings dir exists
mkdirSync(join(__dir, 'learnings'), { recursive: true })

server.listen(PORT, () => {
  const creds = probeCredentials(process.env)
  console.log(`[control-tower] listening on http://localhost:${PORT}`)
  console.log(`[control-tower] anthropic key: ${creds.anthropic ? 'SET' : 'UNSET (live runs disabled)'}`)
  console.log(`[control-tower] openrouter key: ${creds.openrouter ? 'SET' : 'UNSET'}`)
  console.log(`[control-tower] workflows: ${listWorkflows().length}, cassettes: ${listCassettes().length}`)
})

server.on('error', (e) => {
  console.error('[control-tower] server error:', e)
  process.exit(1)
})
