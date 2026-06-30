// src/index.mjs — barrel: re-exports every public symbol from the workflow-lens toolkit.
//
// Claude Code workflow = ONE plain-JS file: `export const meta = {...}` (a PURE literal)
// plus a body that uses 8 injected globals: agent, parallel, pipeline, phase, log, args,
// budget, workflow. This toolkit runs/instruments/visualizes/transforms that file UNMODIFIED.

// ── shim.mjs (workflow runtime) ────────────────────────────────────────────────
export { MODELS, PRICE } from './shim.mjs'
export { loadWorkflow } from './shim.mjs'
export { compileWorkflow } from './shim.mjs'
export { readMetaName } from './shim.mjs'
export { makeParallel } from './shim.mjs'
export { makePipeline } from './shim.mjs'
export { makeBudget } from './shim.mjs'
export { runWorkflow } from './shim.mjs'
export { anthropicBackend } from './shim.mjs'

// ── ast.mjs (static analysis) ─────────────────────────────────────────────────
export { buildGraph } from './ast.mjs'
export { lint } from './ast.mjs'
export { parseWorkflow } from './ast.mjs'
export { parseSource } from './ast.mjs'
export { stripExportMeta } from './ast.mjs'
// ast.readMetaName conflicts with shim.readMetaName by name; exported here under a
// distinct name so both are available from the barrel without collision.
export { readMetaName as readMetaNameFromAst } from './ast.mjs'

// ── ledger.mjs (telemetry) ────────────────────────────────────────────────────
export { createLedger } from './ledger.mjs'
export { costOf } from './ledger.mjs'

// ── gate.mjs (cache + HITL + model-swap) ─────────────────────────────────────
export { createGate } from './gate.mjs'
export { hashCall } from './gate.mjs'
export { openrouterBackend } from './gate.mjs'
export { PROVIDERS, OPENROUTER_MODELS } from './gate.mjs'

// ── render.mjs (report; inline SVG, NO CDN) ──────────────────────────────────
export { renderRun } from './render.mjs'
export { graphSvg } from './render.mjs'
export { mermaidFrom } from './render.mjs'

// ── inject.mjs (AST self-instrumentation) ────────────────────────────────────
export { transform } from './inject.mjs'

// ── instrument.mjs (configurable rewriter) ───────────────────────────────────
export { instrument } from './instrument.mjs'
export { apply as applyInstrument } from './instrument.mjs'

// ── watch.mjs (fs.watch auto-instrument) ─────────────────────────────────────
export { startWatcher } from './watch.mjs'

// ── codegen.mjs (graph -> workflow JS) ───────────────────────────────────────
export { emit } from './codegen.mjs'

// ── governor.mjs (hard budget cap through barriers) ──────────────────────────
export { createGovernor } from './governor.mjs'
export { BudgetExceededError } from './governor.mjs'

// ── router.mjs (cost-aware model router) ─────────────────────────────────────
export { createRouter } from './router.mjs'
export { classify } from './router.mjs'
export { routeTier } from './router.mjs'

// ── cassette.mjs (record/replay) ─────────────────────────────────────────────
// Note: cassette.hashCall is identical to gate.hashCall; the barrel exports gate's
// as the canonical hashCall (above). cassette.hashCall stays file-local.
export { createRecorder } from './cassette.mjs'
export { loadCassette } from './cassette.mjs'

// ── estimate.mjs (pre-flight estimator) ──────────────────────────────────────
export { estimate } from './estimate.mjs'
export { analyzeGraph } from './estimate.mjs'
export { buildCalibratedTable } from './estimate.mjs'
export { compare } from './estimate.mjs'
export { runLive } from './estimate.mjs'

// ── learnings.mjs (trace -> durable learnings; was distill.mjs) ──────────────
export { distillLearnings } from './learnings.mjs'
export { runAndDistill } from './learnings.mjs'
export { groundingCheck } from './learnings.mjs'
