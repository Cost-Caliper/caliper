// src/runner.mjs — composes ledger + backend + router + gate + governor + runWorkflow.
// Emits SSE events via a sink function for each phase/agent-start/agent-end/log/done.
//
// Run lifecycle:
//   createLedger()
//   -> pick backend (live | cassette | recorder)
//   -> ledger.instrument(backend)
//   -> optional createRouter / createGate
//   -> createGovernor
//   -> runWorkflow(path, {agent, parallel, pipeline, log})
//   -> emit done with full telemetry

import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as lens from '../../workflow-lens/src/index.mjs'
import { requireKey } from './credentials.mjs'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dir, '..')

// ── executeRun ─────────────────────────────────────────────────────────────────
//
// opts:
//   workflowId      string
//   workflowPath    string (absolute)
//   workflowSrc     string (for graph/estimate)
//   graph           buildGraph result
//   mode            'live' | 'replay'
//   cassettePath    string? (for replay)
//   capUsd          number? (createGovernor cap)
//   provider        'anthropic' | 'openrouter'
//   useRouter       bool
//   useGate         bool
//   record          bool (record this live run as cassette)
//   emit            function(type, data) — SSE emitter
//   env             process.env (for requireKey)
//
// Returns the final run snapshot once the workflow completes.

export async function executeRun(opts) {
  const {
    workflowId,
    workflowPath,
    workflowSrc,
    graph,
    mode,
    cassettePath,
    capUsd = null,
    provider = 'anthropic',
    useRouter = false,
    useGate = false,
    record = false,
    emit,
    env = process.env,
  } = opts

  // 1. Build the estimate before we start
  let estimate = null
  try { estimate = lens.estimate(workflowSrc) } catch { /* non-fatal */ }

  // 2. Emit run-start
  const graphSvg = lens.graphSvg(graph)
  emit('run-start', {
    workflowId,
    name: graph.metaName,
    mode,
    provider,
    capUsd,
    useRouter,
    useGate,
    record,
    graph,
    graphSvg,
    estimate,
  })

  // 3. Create the ledger
  const ledger = lens.createLedger()

  // 4. Choose the raw backend
  let rawBackend
  let cassette = null

  if (mode === 'replay') {
    if (!cassettePath) {
      const e = new Error('CACHE_MISS: no cassette path provided for replay mode')
      e.code = 'CACHE_MISS'
      throw e
    }
    cassette = lens.loadCassette(cassettePath)
    rawBackend = cassette
  } else {
    // Live mode
    let apiKey
    try {
      apiKey = requireKey(provider, env)
    } catch (credErr) {
      // re-throw with code so caller can emit 'error' event
      throw credErr
    }

    if (provider === 'openrouter') {
      rawBackend = lens.openrouterBackend(apiKey, { maxTokens: 24 })
    } else {
      rawBackend = lens.anthropicBackend(apiKey, { maxTokens: 24 })
    }

    if (record) {
      // Wrap with recorder so we capture the cassette
      const recorder = lens.createRecorder(rawBackend, { metaName: graph.metaName || workflowId })
      rawBackend = recorder
      // We'll save after the run completes
    }
  }

  // 5. Instrument the backend with the ledger; wrap to emit SSE events per call
  let seq = 0
  const instrumentedBase = ledger.instrument(rawBackend)

  // Wrapping again to emit agent-start / agent-end SSE events
  const instrumentedBackend = async (prompt, callOpts = {}) => {
    const callSeq = ++seq
    const label = callOpts.label || `call-${callSeq}`
    const tier = callOpts.model || 'sonnet'

    emit('agent-start', {
      seq: callSeq,
      label,
      tier,
      phase: callOpts.phase || null,
      prompt: String(prompt).slice(0, 80),
    })

    let result, threw = null
    const t0 = process.hrtime.bigint()
    try {
      result = await instrumentedBase(prompt, callOpts)
    } catch (e) {
      threw = e
    }

    // Find the ledger call record for this (it's the last one added)
    const calls = ledger.calls()
    const callRecord = calls[calls.length - 1] || {}

    emit('agent-end', {
      id: callRecord.id,
      label: callRecord.label || label,
      tier: callRecord.tier || tier,
      model: callRecord.model || tier,
      phase: callRecord.phase || callOpts.phase || null,
      ms: callRecord.ms || 0,
      inTok: callRecord.inTok || 0,
      outTok: callRecord.outTok || 0,
      costUsd: callRecord.costUsd || 0,
      requestId: callRecord.requestId || null,
      cached: result && result.cached ? true : false,
      replayed: result && result.replayed ? true : false,
      error: threw ? String(threw.message || threw) : null,
    })

    if (threw) throw threw
    return result
  }

  // 6. Optional router
  let agentBackend = instrumentedBackend
  if (useRouter && mode === 'live') {
    // createRouter needs a strong backend and cheap backend
    // For the Control Tower, we use the instrumentedBackend as strong,
    // and a haiku-downgraded version as cheap (no separate cheap key required)
    agentBackend = lens.createRouter(instrumentedBackend, null)
  }

  // 7. Optional gate (cache + model-swap layer)
  let gateStats = null
  if (useGate && mode === 'live') {
    const gate = lens.createGate(agentBackend)
    gateStats = gate.stats  // the stats function
    agentBackend = gate
  }

  // 8. Governor
  const { agent: governedAgent, parallel: governedParallel, pipeline: governedPipeline } =
    lens.createGovernor(agentBackend, ledger, { capUsd })

  // 9. Phase sink — emits phase events
  const phaseSink = (title) => {
    emit('phase', { phase: title, at: Date.now() })
  }

  // 10. Log sink — emits log events
  const logSink = (message) => {
    emit('log', { message: String(message) })
  }

  // 11. Run the workflow
  let runError = null
  try {
    await lens.runWorkflow(workflowPath, {
      agent: governedAgent,
      parallel: governedParallel,
      pipeline: governedPipeline,
      phase: phaseSink,
      log: logSink,
    })
  } catch (e) {
    runError = e
    if (e && e.code === 'BUDGET_EXCEEDED') {
      const snap = ledger.snapshot()
      emit('governor-trip', {
        spent: snap.run.costUsd,
        cap: capUsd,
        tripCall: seq,
      })
    }
  }

  // 12. Snapshot and emit rollup
  const snap = ledger.snapshot()
  emit('rollup', { run: snap.run, perPhase: snap.perPhase })

  // 13. Save cassette if recording
  if (record && mode === 'live' && typeof rawBackend.save === 'function') {
    const cassettesDir = join(ROOT, 'cassettes')
    mkdirSync(cassettesDir, { recursive: true })
    const cassetteName = `${workflowId}-recorded.cassette.json`
    const cassetteSavePath = join(cassettesDir, cassetteName)
    try {
      rawBackend.save(cassetteSavePath)
      console.log(`[runner] cassette saved: ${cassetteSavePath}`)
    } catch (e) {
      console.warn(`[runner] cassette save failed: ${e.message}`)
    }
  }

  // 14. Build governor + gate stats
  const governorStats = governedAgent.stats ? governedAgent.stats() : { cap: capUsd, tripped: runError?.code === 'BUDGET_EXCEEDED' }
  const gateStatsVal = gateStats ? gateStats() : { realCalls: 0, cacheHits: 0, hitlDenied: 0 }
  const cassetteStats = cassette && cassette.stats ? cassette.stats() : null

  // 15. Emit done or error
  if (runError && runError.code !== 'BUDGET_EXCEEDED') {
    emit('error', {
      code: runError.code || 'INTERNAL',
      message: runError.message,
      envVar: runError.envVar,
      provider: runError.provider,
    })
    return { status: 'error', error: { code: runError.code, message: runError.message }, telemetry: snap, governor: governorStats, gate: gateStatsVal }
  }

  const status = runError?.code === 'BUDGET_EXCEEDED' ? 'over-budget' : 'ok'
  emit('done', {
    status,
    meta: { name: graph.metaName, workflowId },
    graph,
    telemetry: snap,
    governor: governorStats,
    gate: gateStatsVal,
    cassette: cassetteStats,
    optimizeAvailable: true,
  })

  return { status, meta: { name: graph.metaName, workflowId }, graph, telemetry: snap, governor: governorStats, gate: gateStatsVal, estimate }
}
