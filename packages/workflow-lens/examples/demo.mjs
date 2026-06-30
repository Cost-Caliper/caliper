// examples/demo.mjs — library-API demonstration of the workflow-lens toolkit.
//
// Drives examples/fanout.workflow.js entirely through the PUBLIC library API
// (imports from '../src/index.mjs', NOT the CLI). Shows the toolkit as a library:
//
//   1. lint(src)       -> bail if not clean (prints findings)
//   2. buildGraph(src) -> print agents/phases/edges
//   3. estimate(src)   -> print the keyless pre-flight cost/wall band
//   4. If ANTHROPIC_API_KEY present:
//        createLedger() + anthropicBackend(key,{maxTokens:32})
//        wrapped in createGate() + ledger.instrument()
//        runWorkflow() -> renderRun() -> write out/demo-report.html
//        print rollup (calls, costUsd, wallMs, sumMs, speedup, concurrencySavingMs)
//        + the first real request id
//   5. If NO key:
//        print the estimate + graph, state plainly that the live run is skipped
//        (fail-closed, not faked), exit 0 — still a useful keyless demo.
//
// TIMING CAVEAT (also in the README and the report header):
//   The HTML report timing comes from the SHIM-runtime wall clock (the external
//   runner, ledger.mjs), NOT from the in-harness __trace prelude. The in-harness
//   tracer can only capture call structure (order/counts) via log() — the ms
//   clock is banned under the real harness for resume-safety.

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW = join(__dirname, 'fanout.workflow.js')
const OUT_DIR = join(__dirname, 'out')

// Import from the library barrel
import {
  lint,
  buildGraph,
  estimate,
  readMetaName,
  createLedger,
  anthropicBackend,
  createGate,
  runWorkflow,
  renderRun,
} from '../src/index.mjs'

import { readFileSync } from 'node:fs'

const src = readFileSync(WORKFLOW, 'utf8')

// ── 1. Lint ───────────────────────────────────────────────────────────────────
console.log('=== workflow-lens demo ===\n')
const lintResult = lint(src)
if (!lintResult.ok) {
  console.error('lint FAILED — findings:')
  for (const f of lintResult.findings) console.error(`  [${f.severity}] ${f.rule}: ${f.message}`)
  process.exit(1)
}
console.log('lint: OK (no findings)')

// ── 2. Graph ──────────────────────────────────────────────────────────────────
const graph = buildGraph(src)
console.log(`\ngraph: ${graph.metaName}`)
console.log(`  phases: ${graph.phaseNodes.map(p => p.title).join(', ')}`)
console.log(`  agents: ${graph.agentNodes.length}`)
for (const a of graph.agentNodes) {
  const e = graph.edges.find(e => e.to === a.id)
  const cont = e && e.from !== 'root' ? ` [${e.from} · ${e.kind}]` : ''
  console.log(`    ${a.id}: ${a.label || '(unlabeled)'} · ${a.model || 'sonnet'}${cont}`)
}

// ── 3. Estimate ───────────────────────────────────────────────────────────────
const est = estimate(src)
console.log(`\npre-flight estimate (keyless, ±${est.tolerancePct}% band):`)
console.log(`  cost: $${est.costUsd.toFixed(8)}  [$${est.costLow.toFixed(8)} – $${est.costHigh.toFixed(8)}]`)
console.log(`  wall: ${est.wallMs.toFixed(0)}ms  [${est.wallMsLow.toFixed(0)}ms – ${est.wallMsHigh.toFixed(0)}ms]`)
if (est.breakdown.notes.length) {
  console.log('  notes:')
  for (const n of est.breakdown.notes) console.log(`    ⚠ ${n}`)
}

// ── 4. Live run (if key present) ──────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.log('\n[KEYLESS MODE] ANTHROPIC_API_KEY not set — skipping live run.')
  console.log('Set ANTHROPIC_API_KEY to run the full demo (12 haiku calls; ~$0.0001).')
  console.log('\nDemo complete (keyless path).')
  process.exit(0)
}

console.log('\nrunning live (12 haiku calls via fanout.workflow.js)…')

const ledger = createLedger()
const backend = anthropicBackend(apiKey, { maxTokens: 32 })
const gate = createGate(ledger.instrument(backend))

let runResult
try {
  runResult = await runWorkflow(WORKFLOW, { agent: gate })
} catch (e) {
  console.error(`run failed: ${e.message}`)
  process.exit(1)
}

const snap = ledger.snapshot()
const run = snap.run

console.log('\nresults:')
console.log(`  calls:              ${run.calls}`)
console.log(`  costUsd:            $${run.costUsd}`)
console.log(`  wallMs:             ${run.wallMs}ms`)
console.log(`  sumMs (naive):      ${run.sumMs}ms`)
console.log(`  speedup:            ${run.speedup}x`)
console.log(`  concurrencySaving:  ${run.concurrencySavingMs}ms`)

const firstRequestId = snap.calls.find(c => c.requestId)?.requestId
if (firstRequestId) console.log(`  firstRequestId:     ${firstRequestId}`)

// ── 5. Write report ───────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true })
const meta = { name: readMetaName(src) || graph.metaName }
const html = renderRun({ meta, graph, telemetry: snap })
const reportPath = join(OUT_DIR, 'demo-report.html')
writeFileSync(reportPath, html, 'utf8')
console.log(`\nreport: ${reportPath}`)
console.log('\nNOTE: timing in the report comes from the SHIM-runtime wall clock')
console.log('(ledger.mjs, external runner) — NOT from the in-harness __trace prelude.')
console.log('The in-harness tracer captures call structure only; the ms clock is banned')
console.log('under the real harness for resume-safety.')
console.log('\nDemo complete (live path).')
