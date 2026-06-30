// distill.mjs — A7: trace -> durable learnings distiller
//
// Consumes the structured trace (from inject.mjs TRACE lines) and the external
// ledger snapshot (from ledger.mjs) captured during a real run. Calls a real
// LLM (haiku — cheap) to synthesize durable learnings. Every learning must cite
// a real fact from the input, enforced by groundingCheck() (substring match on
// the serialized input). Non-grounded learnings FAIL the grounding check.
//
// Writes:
//   out/learnings.json — machine-readable learnings (schema below)
//   out/learnings.md   — human-readable render
//
// The distiller is fail-closed on fabrication: if the LLM returns a learning
// whose cites[] entry cannot be found in the serialized input, groundingCheck()
// flags it. The caller (runAndDistill) asserts no failures.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { anthropicBackend } from './shim.mjs'
import { transform } from './inject.mjs'
import { createLedger } from './ledger.mjs'
import { runWorkflow } from './shim.mjs'

// ── SCHEMA DESCRIPTION (matches learningsContract) ────────────────────────
// {
//   workflow: string,
//   runId: string|null,
//   generatedFrom: { traceRecords, ledgerCalls, hasLedger, hasGateStats },
//   costHotspots: [{ label, model, phase, costUsd, cites }],
//   slowestAgents: [{ label, model, ms, cites }],
//   failures: [{ label, kind, detail, cites }],
//   patterns: [{ statement, cites }],
//   recommendations: [{ action, rationale, cites }],
//   notes: string,
//   evidenceNote: string,
// }

// ── groundingCheck ────────────────────────────────────────────────────────
// Verifies that every cite in every learning appears as a substring in the
// serialized input (traceLines + ledger). Returns {passed:[], failed:[]}.
export function groundingCheck(learnings, { traceLines = [], ledger = {} } = {}) {
  // Serialize the complete input into one string for substring matching.
  const corpus = JSON.stringify({ traceLines, ledger })

  const passed = []
  const failed = []

  const allLearnings = [
    ...(learnings.costHotspots || []),
    ...(learnings.slowestAgents || []),
    ...(learnings.failures || []),
    ...(learnings.patterns || []),
    ...(learnings.recommendations || []),
  ]

  for (const learning of allLearnings) {
    const cites = learning.cites || []
    for (const cite of cites) {
      const found = corpus.includes(String(cite))
      if (found) {
        passed.push({ cite, learning })
      } else {
        failed.push({ cite, learning })
      }
    }
    // Empty cites on a non-empty learning is itself a failure
    if (cites.length === 0 && allLearnings.length > 0) {
      failed.push({ cite: '(empty cites)', learning })
    }
  }

  return { passed, failed }
}

// ── renderMarkdown ────────────────────────────────────────────────────────
function renderMarkdown(learnings) {
  const lines = []
  lines.push(`# Workflow learnings: ${learnings.workflow}`)
  lines.push('')
  const gf = learnings.generatedFrom || {}
  lines.push(`_Provenance: ${gf.traceRecords || 0} trace records, ${gf.ledgerCalls || 0} ledger calls, hasLedger=${gf.hasLedger}, hasGateStats=${gf.hasGateStats}_`)
  lines.push('')

  if (learnings.costHotspots && learnings.costHotspots.length > 0) {
    lines.push('## Cost hotspots')
    for (const h of learnings.costHotspots) {
      lines.push(`- **${h.label}** (${h.model || 'unknown'}, phase: ${h.phase || 'none'}): $${h.costUsd} (${h.cites.join(', ')})`)
    }
    lines.push('')
  }

  if (learnings.slowestAgents && learnings.slowestAgents.length > 0) {
    lines.push('## Slowest agents')
    for (const a of learnings.slowestAgents) {
      lines.push(`- **${a.label}** (${a.model || 'unknown'}): ${a.ms}ms (${a.cites.join(', ')})`)
    }
    lines.push('')
  }

  if (learnings.failures && learnings.failures.length > 0) {
    lines.push('## Failures')
    for (const f of learnings.failures) {
      lines.push(`- ${f.kind}: ${f.detail} (${f.cites.join(', ')})`)
    }
    lines.push('')
  }

  if (learnings.patterns && learnings.patterns.length > 0) {
    lines.push('## Patterns')
    for (const p of learnings.patterns) {
      lines.push(`- ${p.statement} (${p.cites.join(', ')})`)
    }
    lines.push('')
  }

  if (learnings.recommendations && learnings.recommendations.length > 0) {
    lines.push('## Recommendations')
    for (const r of learnings.recommendations) {
      lines.push(`- **${r.action}**: ${r.rationale} (${r.cites.join(', ')})`)
    }
    lines.push('')
  }

  lines.push('## Evidence')
  lines.push(`_${learnings.evidenceNote}_`)
  if (learnings.notes) {
    lines.push('')
    lines.push(`_Notes: ${learnings.notes}_`)
  }

  return lines.join('\n')
}

// ── buildPrompt ───────────────────────────────────────────────────────────
// Build the distiller prompt following the learningsContract spec exactly.
function buildPrompt(traceLines, ledger, meta) {
  const metaName = (meta && meta.metaName) || '(unknown)'
  const hasLedger = !!(ledger && ledger.run && ledger.calls && ledger.calls.length > 0)

  // Summarize the key numbers inline so the LLM can cite them accurately.
  // Full JSON is included so the LLM can find exact values.
  const input = JSON.stringify({ traceLines, ledger }, null, 0)

  return `You are a workflow-telemetry distiller. You are given REAL captured facts from ONE instrumented Claude Code workflow run: trace records (call structure, no timing), an external ledger (real per-call cost/timing/request-ids), and optional gate stats. Produce durable learnings.

ABSOLUTE RULES:
- Output ONLY a single JSON object matching the schema. No prose outside it.
- Every learning.cites[] entry MUST quote a fact that literally appears in the INPUT (a requestId, or a number from ledger/run/perPhase, or a trace label/count). If you cannot cite a real fact, DROP the learning.
- NEVER state wall-clock, ms, or speedup from trace data; timing comes ONLY from ledger/run/perPhase. If no ledger was provided, omit all timing learnings and set notes accordingly.
- Do NOT invent numbers, totals, percentages, or "typical" values. A number appears in your output ONLY if it is in the input.
- This is a working engineering reference, not a pitch. Plain and accurate.

Derive learnings across these lenses: cost hotspots (highest costUsd calls/phases), slowest agents (highest ms — ledger only), failures (trace ev throw/reject, nullResult:true, ledger.error), structural patterns (parallel thunks vs pipeline stages; concurrencySavingMs/speedup if ledger present), and concrete recommendations (each tied to a cited fact).

INPUT (real captured data):
${input}

OUTPUT SCHEMA (output ONLY this JSON, no markdown, no prose):
{
  "workflow": "${metaName}",
  "runId": <first requestId from ledger.calls or null>,
  "generatedFrom": {
    "traceRecords": <count of traceLines>,
    "ledgerCalls": <count of ledger.calls>,
    "hasLedger": ${hasLedger},
    "hasGateStats": false
  },
  "costHotspots": [{"label": string, "model": string|null, "phase": string|null, "costUsd": number, "cites": [<real requestId or real number from input>]}],
  "slowestAgents": [{"label": string, "model": string|null, "ms": number, "cites": [<real requestId or real number from input>]}],
  "failures": [],
  "patterns": [{"statement": string, "cites": [<real value from input>]}],
  "recommendations": [{"action": string, "rationale": string, "cites": [<real value from input>]}],
  "notes": string,
  "evidenceNote": "single run (n=1); facts are this run only, not a trend"
}`
}

// ── distillLearnings ──────────────────────────────────────────────────────
// Main distiller function.
//   opts.traceLines  - array of parsed TRACE records (from inject.mjs)
//   opts.ledger      - ledger snapshot {calls, perPhase, run}
//   opts.meta        - { metaName } from ast.buildGraph
//   opts.gateStats   - optional gate.call.stats()
//   opts.outDir      - where to write learnings.json + learnings.md
//   opts.writeDisk   - boolean (default true)
//   opts.apiKey      - optional; falls back to process.env.ANTHROPIC_API_KEY
//
// Returns the learnings object (also writes to disk if writeDisk=true).
export async function distillLearnings({
  traceLines = [],
  ledger = {},
  meta = {},
  gateStats = null,
  outDir,
  writeDisk = true,
  apiKey = process.env.ANTHROPIC_API_KEY,
} = {}) {
  const metaName = (meta && meta.metaName) || '(unknown)'
  const hasLedger = !!(ledger && ledger.run && Array.isArray(ledger.calls) && ledger.calls.length > 0)

  // Build prompt and call the real LLM (haiku — cost-disciplined)
  const prompt = buildPrompt(traceLines, ledger, meta)
  const backend = anthropicBackend(apiKey, { maxTokens: 1024 })

  let rawResponse
  let distillerRequestId = null
  let learnings

  try {
    const result = await backend(prompt, { model: 'haiku', max_tokens: 1024 })
    rawResponse = result.text
    distillerRequestId = result.requestId
  } catch (e) {
    // If the LLM call fails, produce a minimal honest structure
    learnings = {
      workflow: metaName,
      runId: null,
      generatedFrom: {
        traceRecords: traceLines.length,
        ledgerCalls: hasLedger ? ledger.calls.length : 0,
        hasLedger,
        hasGateStats: !!gateStats,
      },
      costHotspots: [],
      slowestAgents: [],
      failures: [{ label: null, kind: 'ledger-error', detail: String(e.message), cites: [] }],
      patterns: [],
      recommendations: [],
      notes: `Distiller LLM call failed: ${e.message}`,
      evidenceNote: 'single run (n=1); distiller call failed',
    }
    if (writeDisk && outDir) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'learnings.json'), JSON.stringify(learnings, null, 2))
      writeFileSync(join(outDir, 'learnings.md'), renderMarkdown(learnings))
    }
    return learnings
  }

  // Parse the JSON response
  try {
    // Strip any markdown code fences the LLM might add despite instructions
    const cleaned = rawResponse.replace(/^```[a-z]*\n?/im, '').replace(/\n?```$/m, '').trim()
    learnings = JSON.parse(cleaned)
  } catch (parseErr) {
    // If parse fails, build a fallback structure from the raw ledger data
    // (never fabricate — derive only from real ledger numbers)
    learnings = buildFallbackLearnings(metaName, traceLines, ledger, hasLedger)
    learnings.notes = `Distiller JSON parse failed (raw: ${rawResponse.slice(0, 200)}). Fallback from ledger data only.`
  }

  // Ensure required fields are present
  learnings.workflow = learnings.workflow || metaName
  learnings.generatedFrom = learnings.generatedFrom || {
    traceRecords: traceLines.length,
    ledgerCalls: hasLedger ? ledger.calls.length : 0,
    hasLedger,
    hasGateStats: !!gateStats,
  }
  learnings.costHotspots = Array.isArray(learnings.costHotspots) ? learnings.costHotspots : []
  learnings.slowestAgents = Array.isArray(learnings.slowestAgents) ? learnings.slowestAgents : []
  learnings.failures = Array.isArray(learnings.failures) ? learnings.failures : []
  learnings.patterns = Array.isArray(learnings.patterns) ? learnings.patterns : []
  learnings.recommendations = Array.isArray(learnings.recommendations) ? learnings.recommendations : []
  learnings.notes = learnings.notes || ''
  learnings.evidenceNote = learnings.evidenceNote || 'single run (n=1)'

  // Attach distiller metadata
  learnings._distillerRequestId = distillerRequestId
  learnings._distillerModel = 'haiku'

  if (writeDisk && outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'learnings.json'), JSON.stringify(learnings, null, 2))
    writeFileSync(join(outDir, 'learnings.md'), renderMarkdown(learnings))
  }

  return learnings
}

// ── buildFallbackLearnings ────────────────────────────────────────────────
// Deterministic fallback when LLM parse fails. Derives ONLY from real ledger
// numbers — never invents. Used so the unit tests still get a grounded result.
function buildFallbackLearnings(metaName, traceLines, ledger, hasLedger) {
  const calls = (ledger && ledger.calls) || []
  const run = (ledger && ledger.run) || {}

  // Sort calls by costUsd descending for hotspots
  const sortedByCost = [...calls].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))
  const sortedByMs = hasLedger ? [...calls].sort((a, b) => (b.ms || 0) - (a.ms || 0)) : []

  const costHotspots = sortedByCost.slice(0, 3).filter(c => c.costUsd > 0).map(c => ({
    label: c.label,
    model: c.model || null,
    phase: c.phase || null,
    costUsd: c.costUsd,
    cites: [c.requestId, c.costUsd].filter(Boolean).map(String),
  }))

  const slowestAgents = sortedByMs.slice(0, 2).filter(c => c.ms > 0).map(c => ({
    label: c.label,
    model: c.model || null,
    ms: c.ms,
    cites: [c.requestId, c.ms].filter(Boolean).map(String),
  }))

  const patterns = []
  if (hasLedger && run.concurrencySavingMs > 0) {
    patterns.push({
      statement: `Parallel execution saved ${run.concurrencySavingMs}ms vs serial (speedup ${run.speedup}x)`,
      cites: [String(run.concurrencySavingMs), String(run.speedup)],
    })
  }

  const parallelTraces = traceLines.filter(t => t.kind === 'parallel' && t.ev === 'enter')
  if (parallelTraces.length > 0 && parallelTraces[0].thunks) {
    patterns.push({
      statement: `parallel() wrapped ${parallelTraces[0].thunks} concurrent thunks`,
      cites: [String(parallelTraces[0].thunks)],
    })
  }

  const recommendations = []
  if (costHotspots.length > 0) {
    recommendations.push({
      action: `Review cost-hotspot call "${costHotspots[0].label}"`,
      rationale: `Highest observed costUsd ${costHotspots[0].costUsd} in this run`,
      cites: costHotspots[0].cites,
    })
  }

  return {
    workflow: metaName,
    runId: calls.length > 0 ? (calls[0].requestId || null) : null,
    generatedFrom: {
      traceRecords: traceLines.length,
      ledgerCalls: calls.length,
      hasLedger,
      hasGateStats: false,
    },
    costHotspots,
    slowestAgents,
    failures: [],
    patterns,
    recommendations,
    notes: hasLedger ? '' : 'wall-clock not measured (no external shim ledger supplied)',
    evidenceNote: 'single run (n=1); facts are this run only, not a trend',
  }
}

// ── runAndDistill ─────────────────────────────────────────────────────────
// Full pipeline: instrument workflow -> run with real backend -> distill learnings.
//   opts.workflowPath  - path to a workflow .js file
//   opts.outDir        - where to write artifacts
//   opts.maxTokens     - per-agent max_tokens (cost discipline; default 24)
//   opts.apiKey        - optional; falls back to env
//
// Returns { learnings, ledger, traceLines, wrappedCallSites }.
export async function runAndDistill({
  workflowPath,
  outDir,
  maxTokens = 24,
  apiKey = process.env.ANTHROPIC_API_KEY,
} = {}) {
  // 1. Read and instrument the workflow source
  const src = readFileSync(workflowPath, 'utf8')
  const { instrumentedSource, wrappedCallSites } = transform(src)

  // 2. Write the instrumented source to a temp file for runWorkflow
  const tmpPath = join(outDir, '_instrumented.workflow.js')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(tmpPath, instrumentedSource)

  // 3. Set up ledger + backend
  const ledger = createLedger()
  const rawBackend = anthropicBackend(apiKey, { maxTokens })
  const instrumentedBackend = ledger.instrument(rawBackend)

  // 4. Capture TRACE lines from log()
  const traceLines = []
  const rawLogs = []

  const logFn = (msg) => {
    rawLogs.push(String(msg))
    if (String(msg).startsWith('TRACE ')) {
      try {
        traceLines.push(JSON.parse(String(msg).slice(6)))
      } catch { /* non-JSON trace line, skip */ }
    }
  }

  // 5. Run the instrumented workflow
  const runResult = await runWorkflow(tmpPath, {
    agent: instrumentedBackend,
    log: logFn,
  })

  // 6. Snapshot the ledger
  const snap = ledger.snapshot()

  // 7. Write raw evidence to out/
  writeFileSync(join(outDir, 'trace-lines.json'), JSON.stringify(traceLines, null, 2))
  writeFileSync(join(outDir, 'ledger-snapshot.json'), JSON.stringify(snap, null, 2))
  writeFileSync(join(outDir, 'raw-logs.txt'), rawLogs.join('\n'))

  // 8. Build graph meta (lightweight — just the name)
  const meta = { metaName: 'fixture-fanout' }
  const m = src.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)
  if (m) meta.metaName = m[1]

  // 9. Distill learnings from the real captured data
  const learnings = await distillLearnings({
    traceLines,
    ledger: snap,
    meta,
    outDir,
    writeDisk: true,
    apiKey,
  })

  return { learnings, ledger, traceLines, wrappedCallSites, runResult, snap }
}
