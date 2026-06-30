// src/optimize.mjs — derive grounded optimization suggestions from a finished run's ledger.
//
// Every suggestion cites real requestIds / numbers from this run's ledger snapshot.
// n=1 labelled — we never assert a trend from one run.
//
// Suggestion kinds:
//   cost-router   — cost-hotspot agents could be routed cheap (router.classify marks them easy)
//   gate-cache    — duplicate (prompt+opts) hashes that the gate cache would eliminate
//   cap-budget    — set a capUsd at 1.5× the observed cost so future over-runs are caught early

import * as lens from '../../workflow-lens/src/index.mjs'

export function deriveOptimizations(runSnapshot) {
  const { calls, run } = runSnapshot
  const suggestions = []

  if (!calls || calls.length === 0) {
    return { suggestions: [] }
  }

  // ── 1. Cost-router suggestion ─────────────────────────────────────────────────
  // Find calls that router.classify considers 'easy' and that used a strong model.
  // These could be routed to a cheaper tier with no quality loss (per the heuristic).
  const rerouteCandidates = calls.filter((c) => {
    // Only flag non-haiku calls with an available prompt substitute
    if (c.tier === 'haiku') return false
    // We don't store the prompt in the ledger; classify on the label as proxy
    // (the real classify would need the prompt — here we use a label heuristic)
    return false  // conservative: don't fabricate candidates without the real prompt
  })
  // Instead, look at haiku calls that dominate cost — suggest gate cache
  const haikuCost = calls.filter((c) => c.tier === 'haiku').reduce((s, c) => s + c.costUsd, 0)
  const topCostCall = [...calls].sort((a, b) => b.costUsd - a.costUsd)[0]

  if (topCostCall && topCostCall.costUsd > 0) {
    // Suggest routing if there are multiple same-tier calls (implies a map pattern)
    const sameTierCount = calls.filter((c) => c.tier === topCostCall.tier).length
    if (sameTierCount >= 2 && topCostCall.tier !== 'haiku') {
      suggestions.push({
        kind: 'cost-router',
        rationale: `${sameTierCount} calls use tier "${topCostCall.tier}" (top cost: $${topCostCall.costUsd.toFixed(6)} at call "${topCostCall.label}"). Enable the Cost Router to reclassify short/simple prompts to haiku automatically.`,
        cites: [topCostCall.requestId, String(topCostCall.costUsd), String(sameTierCount)].filter(Boolean),
        proposedRunBody: { useRouter: true },
      })
    }
  }

  // ── 2. Gate cache suggestion ──────────────────────────────────────────────────
  // If this was a live (uncached) run with >1 call, cache could eliminate duplicates.
  // We identify duplicate label strings (labels ARE stored in the ledger per call).
  const byLabel = new Map()
  for (const c of calls) {
    // Key on label only (label is stored in the ledger; tier:label composite is NOT)
    const key = c.label || `call-${c.id}`
    byLabel.set(key, (byLabel.get(key) || 0) + 1)
  }
  const duplicates = [...byLabel.entries()].filter(([, n]) => n > 1)
  if (duplicates.length > 0) {
    const [topLabel, topCount] = duplicates.sort((a, b) => b[1] - a[1])[0]
    // Cites: the label string (exists in ledger.calls[].label) and count (exists in run.calls)
    suggestions.push({
      kind: 'gate-cache',
      rationale: `Label "${topLabel}" appears ${topCount} times in this run. Enabling Cache + HITL Gate would serve repeated (prompt+opts) pairs from cache with 0 API calls, eliminating at most ${topCount - 1} duplicate calls.`,
      cites: [topLabel, String(run.calls)].filter(Boolean),
      proposedRunBody: { useGate: true },
    })
  }

  // ── 3. Budget cap suggestion ──────────────────────────────────────────────────
  // Suggest a capUsd at 2× the observed cost so future over-runs are caught early.
  // We cite run.costUsd and run.calls — both are real ledger numbers.
  // We do NOT cite the computed 2× cap (it isn't in the ledger corpus).
  if (run && run.costUsd > 0) {
    const suggestedCap = +(run.costUsd * 2).toFixed(6)
    suggestions.push({
      kind: 'cap-budget',
      rationale: `This run cost $${run.costUsd.toFixed(6)} across ${run.calls} call(s). A budget cap of $${suggestedCap} (2× observed) would catch future regressions early via the governor, with a concrete governor-trip event (n=1; not a trend).`,
      // Cites only real ledger values: costUsd and calls count (both in run snapshot)
      cites: [String(run.costUsd), String(run.calls)].filter(Boolean),
      proposedRunBody: { capUsd: suggestedCap },
    })
  }

  // ── 4. Concurrency suggestion (if wall << sum) ────────────────────────────────
  if (run && run.concurrencySavingMs > 0 && run.speedup < 1.5 && calls.length >= 3) {
    // Speedup is low despite parallel agents — investigate sequential bottleneck
    suggestions.push({
      kind: 'parallelism',
      rationale: `Concurrency speedup is ${run.speedup}× (wall ${run.wallMs}ms vs sum ${run.sumMs}ms; saved ${run.concurrencySavingMs}ms). Adding more parallel() groups could improve throughput if any sequential phases have independent agents.`,
      cites: [String(run.speedup), String(run.wallMs), String(run.sumMs)],
      proposedRunBody: {},  // informational only, no direct run change
    })
  }

  return { suggestions }
}
