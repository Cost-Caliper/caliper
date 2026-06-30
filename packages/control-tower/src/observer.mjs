// src/observer.mjs — run-observer that tails the real Claude Code harness artifacts.
//
// Points at a session dir (SESS) and watches:
//   SESS/workflows/wf_<runid>.json       — top-level run record
//   SESS/subagents/workflows/wf_<runid>/ — per-agent transcripts
//   SESS/workflows/scripts/<name>-wf_<runid>.js — links name to runid
//
// Reconstructs a run object shaped to match the Control Tower's existing run
// snapshot format so the existing render/table code reuses with zero changes.
//
// Cache-aware cost: cache_creation tokens × 1.25, cache_read tokens × 0.10.
// Caveat: derived from pricing convention, not a live billing API.

import { readFileSync, existsSync, readdirSync, watch } from 'node:fs'
import { join, basename } from 'node:path'
import { costOfUsage, tierFromModel } from './observe-cost.mjs'

// ── Session dir resolution ────────────────────────────────────────────────────
//
// The Claude Code session dir is:
//   ~/.claude/projects/<dash-encoded-cwd>/<sessionId>/
//
// WFLENS_SESSION_DIR overrides; otherwise we resolve from this file's cwd.
// The dash-encoding rule: each / in the absolute cwd path becomes -.
// Example: /Users/foo/bar → -Users-foo-bar
//
// We don't try to auto-derive (too fragile across OS/shell configs).
// The skill start-bridge.mjs resolves it and passes it as an env var.

export function resolveSessionDir() {
  if (process.env.WFLENS_SESSION_DIR) return process.env.WFLENS_SESSION_DIR
  // Fallback: try to find the most-recently-modified session dir for this project
  // by looking for the known project slug from the current process cwd.
  return null
}

// ── trace parser ──────────────────────────────────────────────────────────────
// Parses our instrumentation trace lines. Two markers are emitted by the rewriter:
//   "WFLENS_TRACE {...}"  — the instrument.mjs meta line (kind:'meta', instrumentationId)
//   "TRACE {...}"         — the inject.mjs per-call-site wrappers (kind:agent/parallel/...)
// Accept BOTH; JSON.parse fails closed so a workflow's own "TRACE …" prose is ignored.
function parseTraceLine(line) {
  for (const prefix of ['WFLENS_TRACE ', 'TRACE ']) {
    if (line.startsWith(prefix)) {
      try { return JSON.parse(line.slice(prefix.length)) } catch { return null }
    }
  }
  return null
}

// ── Parse a single wf_*.json run file ────────────────────────────────────────
export function parseRunJson(runId, sessDir) {
  const wfPath = join(sessDir, 'workflows', `wf_${runId}.json`)
  if (!existsSync(wfPath)) return null

  let raw
  try { raw = JSON.parse(readFileSync(wfPath, 'utf8')) } catch { return null }

  // Resolve workflow name from scripts dir
  const scriptsDir = join(sessDir, 'workflows', 'scripts')
  let workflowName = raw.workflowName || raw.summary || null
  if (!workflowName && existsSync(scriptsDir)) {
    try {
      const scripts = readdirSync(scriptsDir)
      const match = scripts.find((f) => f.endsWith(`-wf_${runId}.js`) || f.endsWith(`wf_${runId}.js`))
      if (match) {
        // extract name: everything before -wf_<runid>.js
        const nameMatch = match.match(/^(.+?)-wf_[0-9a-f-]+\.js$/)
        workflowName = nameMatch ? nameMatch[1] : basename(match, '.js')
      }
    } catch { /* non-fatal */ }
  }

  // Parse WFLENS_TRACE lines from logs[]
  const logs = Array.isArray(raw.logs) ? raw.logs : []
  const traceRecords = []
  for (const line of logs) {
    const t = parseTraceLine(String(line))
    if (t) traceRecords.push(t)
  }

  return {
    runId,
    workflowName,
    status: raw.status || 'unknown',
    defaultModel: raw.defaultModel || null,
    agentCount: raw.agentCount || 0,
    totalTokens: raw.totalTokens || 0,
    totalToolCalls: raw.totalToolCalls || 0,
    durationMs: raw.durationMs || 0,
    startTime: raw.startTime || null,
    timestamp: raw.timestamp || null,
    phases: Array.isArray(raw.phases) ? raw.phases : [],
    workflowProgress: Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [],
    result: raw.result || null,
    logs,
    traceRecords,
  }
}

// ── Parse journal.jsonl ───────────────────────────────────────────────────────
// Returns a map: agentId -> {result, startKey, resultKey}
function parseJournal(journalPath) {
  const agentMap = {}
  if (!existsSync(journalPath)) return agentMap
  let lines
  try { lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean) } catch { return agentMap }
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const aid = entry.agentId
      if (!aid) continue
      if (!agentMap[aid]) agentMap[aid] = { agentId: aid, started: null, result: null }
      if (entry.type === 'started') agentMap[aid].started = entry
      if (entry.type === 'result') agentMap[aid].result = entry.result
    } catch { /* skip malformed */ }
  }
  return agentMap
}

// ── Parse agent-<id>.jsonl ────────────────────────────────────────────────────
// Sums usage across all assistant turns in the transcript.
// Returns {model, totalUsage, firstTimestamp, lastTimestamp}
function parseAgentTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return null
  let lines
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean) } catch { return null }

  let model = null
  let firstTimestamp = null
  let lastTimestamp = null
  let cwd = null        // working directory the agent ran in (carried on every entry)
  let gitBranch = null  // git branch at run time (carried on every entry)
  let task = null       // first user message = the prompt/task this agent received
  let output = null     // latest assistant text = its answer
  let assistantTurns = 0
  let toolCalls = 0
  const tools = new Set()
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const textOf = (content) =>
    typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
      : ''

  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!cwd && entry.cwd) cwd = entry.cwd
    if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch
    const msg = entry.message || {}
    if (entry.type === 'user') {
      if (task === null) { const t = textOf(msg.content).trim(); if (t) task = t }
      continue
    }
    if (entry.type !== 'assistant') continue
    assistantTurns++
    if (!model && msg.model) model = msg.model
    const usage = msg.usage || {}
    totalUsage.input_tokens += usage.input_tokens || 0
    totalUsage.output_tokens += usage.output_tokens || 0
    totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0
    totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) if (b && b.type === 'tool_use') { toolCalls++; if (b.name) tools.add(b.name) }
    }
    const txt = textOf(msg.content).trim()
    if (txt) output = txt
    const ts = entry.timestamp || null
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts
      lastTimestamp = ts
    }
  }

  const trunc = (s, n) => (s == null ? null : s.length > n ? s.slice(0, n) + '…' : s)
  return {
    model, totalUsage, firstTimestamp, lastTimestamp, cwd, gitBranch,
    task: trunc(task, 1400), output: trunc(output, 900),
    assistantTurns, toolCalls, tools: [...tools],
  }
}

// ── Reconstruct run object ────────────────────────────────────────────────────
// Produces a shape compatible with the Control Tower's existing run snapshot:
//   {meta, telemetry:{calls,perPhase,run}, status, source:'observed-native'}
//
// Per-agent data comes from workflowProgress agent entries + transcript files.
// ms per call = lastTimestamp - startedAt (real wall-clock).
// Cost is cache-aware (create=1.25×, read=0.10×).

/**
 * reconstructRun(runId, sessDir, extraBeacons?, beaconsByInstrumentationId?)
 *
 * extraBeacons — array of beacon objects (legacy: keyed by runId match).
 * beaconsByInstrumentationId — Map<instrumentationId, beacon[]> from the server
 *   beacon store; used to correlate beacons that carried an instrumentationId
 *   instead of (or in addition to) a runId.  Pass null/undefined to skip.
 */
export function reconstructRun(runId, sessDir, extraBeacons = [], beaconsByInstrumentationId = null) {
  const runJson = parseRunJson(runId, sessDir)
  if (!runJson) return null

  const agentDir = join(sessDir, 'subagents', 'workflows', `wf_${runId}`)
  const journalPath = join(agentDir, 'journal.jsonl')
  const journalMap = parseJournal(journalPath)

  // Per-agent entries from workflowProgress
  const agentEntries = (runJson.workflowProgress || []).filter((e) => e.type === 'workflow_agent')
  const phaseEntries = (runJson.workflowProgress || []).filter((e) => e.type === 'workflow_phase')

  // Build per-call records
  const calls = []
  let callSeq = 0
  let runCwd = null       // working dir + git branch this run executed in (from transcripts)
  let runGitBranch = null

  for (const agEnt of agentEntries) {
    const agentId = agEnt.agentId
    const transcriptPath = join(agentDir, `agent-${agentId}.jsonl`)
    const transcript = parseAgentTranscript(transcriptPath)
    if (!runCwd && transcript?.cwd) runCwd = transcript.cwd
    if (!runGitBranch && transcript?.gitBranch) runGitBranch = transcript.gitBranch

    const model = transcript?.model || agEnt.model || null
    const tier = tierFromModel(model)

    // Wall-clock ms: from startedAt to lastTimestamp in transcript
    let ms = agEnt.durationMs || 0
    if (transcript?.firstTimestamp && transcript?.lastTimestamp) {
      const start = new Date(transcript.firstTimestamp).getTime()
      const end = new Date(transcript.lastTimestamp).getTime()
      if (!isNaN(start) && !isNaN(end) && end >= start) ms = end - start
    }

    const usage = transcript?.totalUsage || {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    }

    // Cache-aware cost
    const costUsd = costOfUsage(usage, model)

    const phase = agEnt.phaseTitle || agEnt.phase || null
    const label = agEnt.label || `agent-${agEnt.index || ++callSeq}`

    // startMs / endMs relative to run start
    const runStart = runJson.startTime ? Number(runJson.startTime) : 0
    const agentStartMs = agEnt.startedAt ? agEnt.startedAt - runStart : 0
    const agentEndMs = agentStartMs + ms

    calls.push({
      id: agEnt.index || ++callSeq,
      label,
      tier,
      model,
      phase,
      agentId,
      startMs: +agentStartMs.toFixed(1),
      endMs: +agentEndMs.toFixed(1),
      ms: +ms.toFixed(1),
      inTok: usage.input_tokens,
      outTok: usage.output_tokens,
      cacheCreationTok: usage.cache_creation_input_tokens,
      cacheReadTok: usage.cache_read_input_tokens,
      costUsd,
      task: transcript?.task || null,
      output: transcript?.output || null,
      toolCalls: transcript?.toolCalls || 0,
      tools: transcript?.tools || [],
      turns: transcript?.assistantTurns || 0,
      requestId: null,
      error: null,
    })
  }

  // Per-phase aggregation
  const phaseMap = new Map()
  for (const c of calls) {
    const k = c.phase || '(none)'
    const agg = phaseMap.get(k) || { phase: k, calls: 0, inTok: 0, outTok: 0, costUsd: 0, sumMs: 0, minStart: Infinity, maxEnd: -Infinity }
    agg.calls++
    agg.inTok += c.inTok
    agg.outTok += c.outTok
    agg.costUsd += c.costUsd
    agg.sumMs += c.ms
    agg.minStart = Math.min(agg.minStart, c.startMs)
    agg.maxEnd = Math.max(agg.maxEnd, c.endMs)
    phaseMap.set(k, agg)
  }
  const perPhase = [...phaseMap.values()].map((a) => ({
    ...a,
    costUsd: +a.costUsd.toFixed(6),
    sumMs: +a.sumMs.toFixed(1),
    wallMs: a.calls ? +(a.maxEnd - a.minStart).toFixed(1) : 0,
  }))

  // Run rollup
  const inTok = calls.reduce((s, c) => s + c.inTok, 0)
  const outTok = calls.reduce((s, c) => s + c.outTok, 0)
  const costUsd = +calls.reduce((s, c) => s + c.costUsd, 0).toFixed(6)
  const sumMs = +calls.reduce((s, c) => s + c.ms, 0).toFixed(1)
  const minStart = calls.length ? Math.min(...calls.map((c) => c.startMs)) : 0
  const maxEnd = calls.length ? Math.max(...calls.map((c) => c.endMs)) : 0
  const wallMs = +(maxEnd - minStart).toFixed(1)
  const concurrencySavingMs = +(sumMs - wallMs).toFixed(1)
  const speedup = wallMs > 0 ? +(sumMs / wallMs).toFixed(2) : 1

  const run = {
    calls: calls.length,
    inTok,
    outTok,
    costUsd,
    sumMs,
    wallMs,
    concurrencySavingMs,
    speedup,
  }

  // Read the instrumentationId from the meta trace line (if present).
  // instrument.mjs emits: WFLENS_TRACE {"kind":"meta","ev":"instrumented","instrumentationId":"...","name":"..."}
  const metaTrace = (runJson.traceRecords || []).find(
    (r) => r && r.kind === 'meta' && r.ev === 'instrumented' && r.instrumentationId,
  )
  const instrumentationId = metaTrace ? metaTrace.instrumentationId : null

  // Merge beacon events: by runId (legacy) + by instrumentationId (new correlation key)
  const beacons = extraBeacons.filter((b) => b.runId === runId)
  if (instrumentationId && beaconsByInstrumentationId) {
    const idBeacons = beaconsByInstrumentationId.get
      ? (beaconsByInstrumentationId.get(instrumentationId) || [])
      : (beaconsByInstrumentationId[instrumentationId] || [])
    // Merge without duplicates (a beacon may have both runId and instrumentationId)
    for (const b of idBeacons) {
      if (!beacons.includes(b)) beacons.push(b)
    }
  }

  return {
    runId,
    source: 'observed-native',
    status: runJson.status,
    meta: {
      name: runJson.workflowName || runId,
      workflowName: runJson.workflowName,
      defaultModel: runJson.defaultModel,
      instrumentationId,
    },
    telemetry: {
      calls,
      perPhase,
      run,
    },
    traceRecords: runJson.traceRecords,
    beacons,
    phases: runJson.phases,
    agentCount: runJson.agentCount || agentEntries.length,
    totalTokens: runJson.totalTokens,
    durationMs: runJson.durationMs,
    startTime: runJson.startTime,
    timestamp: runJson.timestamp,
    cwd: runCwd,
    gitBranch: runGitBranch,
  }
}

// ── List summary (for GET /v1/observed) ──────────────────────────────────────
export function summaryFromRun(run) {
  if (!run) return null
  return {
    runId: run.runId,
    name: run.meta?.name || run.runId,
    status: run.status,
    source: 'observed-native',
    agentCount: run.agentCount || 0,
    totalTokens: run.totalTokens || 0,
    costUsd: run.telemetry?.run?.costUsd || 0,
    durationMs: run.durationMs || 0,
    startedAt: run.startTime ? new Date(run.startTime).toISOString() : null,
    timestamp: run.timestamp || null,
    cwd: run.cwd || null,
    gitBranch: run.gitBranch || null,
  }
}

// ── Scan completed runs ────────────────────────────────────────────────────────
export function scanCompletedRuns(sessDir) {
  if (!sessDir || !existsSync(sessDir)) return []
  const wfDir = join(sessDir, 'workflows')
  if (!existsSync(wfDir)) return []

  let files
  try { files = readdirSync(wfDir).filter((f) => /^wf_[0-9a-f-]+\.json$/.test(f)) } catch { return [] }

  const results = []
  for (const file of files) {
    const runId = file.replace(/^wf_/, '').replace(/\.json$/, '')
    const run = reconstructRun(runId, sessDir)
    if (run) results.push(summaryFromRun(run))
  }
  // Sort newest first (by timestamp)
  results.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return tb - ta
  })
  return results
}

// ── Watch for new/changed runs ─────────────────────────────────────────────────
// Calls onRun(summary, reconstructedRun) when a wf_*.json appears or changes.
// Debounced 50ms per file to avoid partial-write races.
export function watchRuns(sessDir, onRun) {
  if (!sessDir || !existsSync(sessDir)) return () => {}
  const wfDir = join(sessDir, 'workflows')
  if (!existsSync(wfDir)) return () => {}

  const debounceMap = new Map()

  function handleFile(filename) {
    if (!filename || !/^wf_[0-9a-f-]+\.json$/.test(filename)) return
    const runId = filename.replace(/^wf_/, '').replace(/\.json$/, '')
    if (debounceMap.has(runId)) clearTimeout(debounceMap.get(runId))
    debounceMap.set(runId, setTimeout(() => {
      debounceMap.delete(runId)
      const run = reconstructRun(runId, sessDir)
      if (run) onRun(summaryFromRun(run), run)
    }, 50))
  }

  let watcher
  try {
    watcher = watch(wfDir, { persistent: false }, (eventType, filename) => {
      handleFile(filename)
    })
  } catch {
    return () => {}
  }

  return () => { try { watcher.close() } catch {} }
}
