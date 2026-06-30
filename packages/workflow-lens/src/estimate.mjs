// estimate.mjs — A6 pre-flight cost/time estimator for Claude Code workflows.
//
// WHAT IT DOES
//   Given a workflow source string, statically analyses the AST (agent nodes,
//   concurrency structure, models) and returns a cost+wall-clock estimate
//   BEFORE any real API calls happen.
//
// HONEST SCOPE + CAVEATS
//   The AST sees each agent() CALL SITE as one node; dynamic multipliers like
//   `topics.map(t => () => agent(...))` produce 1 AST agent (the template) per
//   parallel container — the actual runtime count depends on the data. Where
//   a parallel has exactly 1 AST agent (indicating a map/dynamic pattern) the
//   estimator notes the ambiguity in breakdown.parallelFanout.
//
//   The calibrated table is seeded from REAL haiku calls (the only model used
//   in the fixture suite). sonnet/opus rows are anchored to the PRICE table
//   ratios (no live data for them in this run). Where live data is absent,
//   the table entries are derived and marked as such.
//
//   Tolerance band: 200% (3×) — deliberately wide for a first-run estimator
//   that has only per-call-site counts, not runtime multipliers.
//
// EXPORTS
//   analyzeGraph(src) → analysis object (structure, byModel, etc.)
//   buildCalibratedTable(calibData) → per-model avg cost/latency table
//   estimate(src, table?) → estimate object with costUsd/wallMs/bounds
//   compare(est, actualLedger) → delta + inBand verdict
//   runLive(workflowPath, apiKey) → runs workflow and returns ledger snapshot
import { buildGraph } from './ast.mjs'
import { PRICE, anthropicBackend, runWorkflow } from './shim.mjs'
import { createLedger } from './ledger.mjs'

// ── default calibration table (seeded; updated from live calibration run) ─────
// Entries: { avgInTok, avgOutTok, avgMs } — haiku entries come from live calibration.
// sonnet/opus: derived from haiku actuals × price ratio (marked derived:true).
const SEED_TABLE = {
  haiku:  { avgInTok: 20, avgOutTok: 8,  avgMs: 800,  source: 'seed' },
  sonnet: { avgInTok: 20, avgOutTok: 8,  avgMs: 1200, source: 'seed-ratio' },
  opus:   { avgInTok: 20, avgOutTok: 8,  avgMs: 2000, source: 'seed-ratio' },
  fable:  { avgInTok: 20, avgOutTok: 8,  avgMs: 2000, source: 'seed-ratio' },
}

// Concurrency model:
//   sequential agents: wall-clock = sum of all agent ms
//   parallel group:    wall-clock = max(agent ms in group) [all fire at once]
//   pipeline stages:   wall-clock per item = sum of stage ms; items run in parallel,
//                      so wall-clock = max over items (sum of stage ms for that item)
//                      — which equals sum of stage ms if stages are uniform.
// For a static estimator we use: parallel group wall-clock = max avgMs of agents in group.
// Pipeline wall-clock = sum of stage avgMs (conservative — items run in parallel,
// but we don't know item count statically).

// ── analyzeGraph ─────────────────────────────────────────────────────────────
// Returns a richer view of the AST graph for estimation:
//   {
//     metaName, phases, agentCount,
//     byModel: { haiku: N, sonnet: N, ... },
//     structure: { sequential: N, parallelGroups: N, pipelineGroups: N, parallelAgents: N, pipelineAgents: N },
//     groups: [ { kind, agents: [{id,label,model,phase}] } ],
//   }
export function analyzeGraph(src) {
  const g = buildGraph(src)
  // Group agents by container
  const containerMap = new Map() // containerId|'root' -> {kind, agents:[]}
  for (const e of g.edges) {
    if (!containerMap.has(e.from)) containerMap.set(e.from, { kind: e.kind, agents: [] })
    const agent = g.agentNodes.find(a => a.id === e.to)
    if (agent) containerMap.get(e.from).agents.push(agent)
  }

  const groups = []
  let sequential = 0, parallelGroups = 0, pipelineGroups = 0
  let parallelAgents = 0, pipelineAgents = 0
  for (const [containerId, grp] of containerMap) {
    groups.push({ containerId, kind: grp.kind, agents: grp.agents })
    if (grp.kind === 'sequential' || containerId === 'root') {
      sequential += grp.agents.length
    } else if (grp.kind === 'parallel') {
      parallelGroups++
      parallelAgents += grp.agents.length
    } else if (grp.kind === 'pipeline') {
      pipelineGroups++
      pipelineAgents += grp.agents.length
    }
  }

  const byModel = {}
  for (const a of g.agentNodes) {
    const m = a.model || 'sonnet'
    byModel[m] = (byModel[m] || 0) + 1
  }

  return {
    metaName: g.metaName,
    phases: g.phaseNodes.length,
    agentCount: g.agentNodes.length,
    agentNodes: g.agentNodes,   // exposed directly for test/consumer convenience
    byModel,
    structure: { sequential, parallelGroups, pipelineGroups, parallelAgents, pipelineAgents },
    groups,
    rawGraph: g,
  }
}

// ── buildCalibratedTable ─────────────────────────────────────────────────────
// Takes an array of ledger call records from a calibration run and computes
// per-model averages. Falls back to SEED_TABLE for models not present.
// calibData = { calls: [{tier,model,inTok,outTok,ms}] }
export function buildCalibratedTable(calibData) {
  const table = JSON.parse(JSON.stringify(SEED_TABLE))
  if (!calibData || !Array.isArray(calibData.calls) || calibData.calls.length === 0) {
    return table
  }
  const byModel = {}
  for (const c of calibData.calls) {
    const tier = c.tier || 'sonnet'
    if (!byModel[tier]) byModel[tier] = { sumIn: 0, sumOut: 0, sumMs: 0, n: 0 }
    byModel[tier].sumIn += c.inTok; byModel[tier].sumOut += c.outTok
    byModel[tier].sumMs += c.ms; byModel[tier].n++
  }
  for (const [tier, agg] of Object.entries(byModel)) {
    if (agg.n > 0) {
      table[tier] = {
        avgInTok: Math.round(agg.sumIn / agg.n),
        avgOutTok: Math.round(agg.sumOut / agg.n),
        avgMs: Math.round(agg.sumMs / agg.n),
        source: `live-n${agg.n}`,
      }
    }
  }
  // Derive sonnet/opus from haiku if haiku was calibrated but they weren't
  const haiku = table.haiku
  if (haiku && haiku.source.startsWith('live')) {
    if (table.sonnet.source !== haiku.source) {
      // price ratio: sonnet in=3.0/haiku in=1.0 = 3x. latency: estimate 1.5x
      table.sonnet = { avgInTok: haiku.avgInTok, avgOutTok: haiku.avgOutTok, avgMs: Math.round(haiku.avgMs * 1.5), source: 'ratio-from-haiku' }
    }
    if (table.opus.source !== haiku.source) {
      // price ratio: opus in=5.0/haiku=1.0 = 5x; latency: ~2.5x
      table.opus = { avgInTok: haiku.avgInTok, avgOutTok: haiku.avgOutTok, avgMs: Math.round(haiku.avgMs * 2.5), source: 'ratio-from-haiku' }
      table.fable = { ...table.opus }
    }
  }
  return table
}

// ── costOfAgent ──────────────────────────────────────────────────────────────
function costOfAgent(model, table) {
  const t = table[model] || table.sonnet
  const p = PRICE[model] || PRICE.sonnet
  return +((t.avgInTok / 1e6) * p.in + (t.avgOutTok / 1e6) * p.out).toFixed(8)
}

// ── estimate ─────────────────────────────────────────────────────────────────
// Returns:
//   { workflowName, agentCount, byModel, method, tolerancePct,
//     costUsd, costLow, costHigh,
//     wallMs, wallMsLow, wallMsHigh,
//     breakdown: { sequential:[], parallelGroups:[], pipelineGroups:[], notes:[] },
//     table }
//
// TOLERANCE NOTE: we use 200% (3×) wide band by default.
//   This is deliberately honest: the AST can't know dynamic multipliers (e.g.
//   `topics.map(...)` fires 4 agents at runtime from 1 AST node). A parallel
//   group with 1 AST agent is flagged in notes as "dynamic-multiplier-unknown".
export function estimate(src, table = null) {
  const analysis = analyzeGraph(src)
  const usedTable = table || SEED_TABLE
  const TOLERANCE_PCT = 200  // ±200% (i.e. [est/3, est×3])

  // Per-group cost + wall-clock estimation
  let totalCostUsd = 0
  // Wall-clock: sequential groups add up; parallel groups contribute max(agent ms)
  // in the concurrent window; pipelines are serial stages × item (1 item assumed).
  let sequentialWallMs = 0
  let parallelWallMs = 0  // max wall among all parallel groups (they could overlap if multi-phase)
  let pipelineWallMs = 0

  const breakdown = { sequential: [], parallelGroups: [], pipelineGroups: [], notes: [] }

  for (const grp of analysis.groups) {
    const agentCosts = grp.agents.map(a => costOfAgent(a.model || 'sonnet', usedTable))
    const agentMs    = grp.agents.map(a => (usedTable[a.model || 'sonnet'] || usedTable.sonnet).avgMs)
    const groupCost  = agentCosts.reduce((s, c) => s + c, 0)

    if (grp.kind === 'sequential' || grp.containerId === 'root') {
      const groupMs = agentMs.reduce((s, m) => s + m, 0)
      sequentialWallMs += groupMs
      totalCostUsd += groupCost
      breakdown.sequential.push({
        agents: grp.agents.map((a, i) => ({ label: a.label, model: a.model, costUsd: agentCosts[i], ms: agentMs[i] })),
        costUsd: +groupCost.toFixed(8), wallMs: groupMs,
      })
    } else if (grp.kind === 'parallel') {
      const groupMs = Math.max(...agentMs)  // all fire concurrently -> wall = max
      parallelWallMs += groupMs  // phases serialize parallel groups, so sum across phases
      totalCostUsd += groupCost
      const note = grp.agents.length === 1
        ? 'AST sees 1 agent template (dynamic map/forEach pattern — actual runtime count unknown; cost is per-invocation × 1)'
        : null
      breakdown.parallelGroups.push({
        agents: grp.agents.map((a, i) => ({ label: a.label, model: a.model, costUsd: agentCosts[i], ms: agentMs[i] })),
        costUsd: +groupCost.toFixed(8), wallMs: groupMs,
        parallelFanout: grp.agents.length,
        note,
      })
      if (note) breakdown.notes.push(note)
    } else if (grp.kind === 'pipeline') {
      // Each item flows through all stages. Wall-clock = sum of stage avgMs
      // (items run in parallel so in practice wall < sumMs, but item count unknown).
      const stageMs = agentMs.reduce((s, m) => s + m, 0)
      pipelineWallMs += stageMs
      totalCostUsd += groupCost
      breakdown.pipelineGroups.push({
        stages: grp.agents.map((a, i) => ({ label: a.label, model: a.model, costUsd: agentCosts[i], ms: agentMs[i] })),
        costUsd: +groupCost.toFixed(8), wallMs: stageMs,
        note: 'item count unknown statically; cost is per-item × agent count shown',
      })
    }
  }

  const totalWallMs = sequentialWallMs + parallelWallMs + pipelineWallMs

  return {
    workflowName: analysis.metaName,
    agentCount: analysis.agentCount,
    byModel: analysis.byModel,
    method: 'static-ast-calibrated',
    tolerancePct: TOLERANCE_PCT,
    // Mid-point estimates
    costUsd: +totalCostUsd.toFixed(8),
    costLow: +(totalCostUsd / 3).toFixed(8),
    costHigh: +(totalCostUsd * 3).toFixed(8),
    // Wall-clock
    wallMs: +totalWallMs.toFixed(1),
    wallMsLow: +(totalWallMs / 3).toFixed(1),
    wallMsHigh: +(totalWallMs * 3).toFixed(1),
    breakdown,
    table: usedTable,
    structureNotes: [
      `${analysis.structure.parallelGroups} parallel group(s), ${analysis.structure.pipelineGroups} pipeline group(s)`,
      `Sequential agents: ${analysis.structure.sequential}, Parallel slots: ${analysis.structure.parallelAgents}, Pipeline stages: ${analysis.structure.pipelineAgents}`,
      'CAVEATS: dynamic multipliers (map/forEach) not resolved statically; cost is per-call-site.',
    ],
  }
}

// ── compare ──────────────────────────────────────────────────────────────────
// compare(est, actualLedger) where actualLedger is ledger.snapshot():
//   { calls, perPhase, run: {calls, inTok, outTok, costUsd, sumMs, wallMs, ...} }
// Returns:
//   { costDeltaPct, wallDeltaPct, inBand, details }
export function compare(est, actualLedger) {
  const run = actualLedger.run || actualLedger
  const actualCost  = run.costUsd
  const actualWall  = run.wallMs
  const tolerance   = est.tolerancePct / 100  // 2.0 = 200%

  const costDeltaPct = actualCost > 0
    ? +((est.costUsd - actualCost) / actualCost * 100).toFixed(1)
    : null
  const wallDeltaPct = actualWall > 0
    ? +((est.wallMs - actualWall) / actualWall * 100).toFixed(1)
    : null

  // In-band: est is within [actual/3, actual*3] when tolerance=200%
  const costInBand = actualCost > 0
    ? (est.costUsd >= actualCost / (1 + tolerance) && est.costUsd <= actualCost * (1 + tolerance))
    : true
  const wallInBand = actualWall > 0
    ? (est.wallMs >= actualWall / (1 + tolerance) && est.wallMs <= actualWall * (1 + tolerance))
    : true

  return {
    estCostUsd: est.costUsd,
    actualCostUsd: actualCost,
    costDeltaPct,
    costInBand,
    estWallMs: est.wallMs,
    actualWallMs: actualWall,
    wallDeltaPct,
    wallInBand,
    inBand: costInBand && wallInBand,
    tolerancePct: est.tolerancePct,
    verdict: costInBand && wallInBand ? 'PASS' : 'OUTSIDE_TOLERANCE',
  }
}

// ── runLive ──────────────────────────────────────────────────────────────────
// Runs the workflow at workflowPath with real Anthropic calls (cost-disciplined:
// uses haiku, max_tokens=64), wraps in a ledger, and returns ledger.snapshot().
export async function runLive(workflowPath, apiKey) {
  const ledger = createLedger()
  const backend = anthropicBackend(apiKey, { maxTokens: 64 })
  const recordedBackend = ledger.instrument(backend)
  await runWorkflow(workflowPath, { agent: recordedBackend })
  return ledger.snapshot()
}
