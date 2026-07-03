// test/editor-optimize-gaps.test.mjs — uncovered branches of src/editor.mjs + src/optimize.mjs.
//
// editor.mjs gaps: out-of-range edit index, model insertion when the agent has NO
//   opts object (argsInsertPos path), dynamic (non-literal) model expression no-op,
//   hostile-prompt round-trip (why the EDIT_INVALID re-parse guard is unreachable
//   via prompt strings — JSON.stringify always emits a valid JS string literal
//   spliced over a complete Literal/TemplateLiteral node).
// optimize.mjs gaps: cost-router suggestion (>=2 same-tier non-haiku calls),
//   parallelism suggestion (concurrencySavingMs > 0 && speedup < 1.5 && >=3 calls),
//   label-less ledger entries, and the run-undefined gate-cache edge (real bug —
//   see BUG comment at bottom).
//
// Complements editor.test.mjs / optimize.test.mjs — no overlap with their cases.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as lens from '../../workflow-lens/src/index.mjs'
import { extractEditableAgents, applyEdits } from '../src/editor.mjs'
import { deriveOptimizations } from '../src/optimize.mjs'

// ── editor fixture ────────────────────────────────────────────────────────────
// Agent 0: literal prompt, NO opts object at all (argsInsertPos path).
// Agent 1: opts present, but model is a variable (dynamic — not a string literal).
const FIX = `export const meta = { name: 'gap-fixture', description: 'editor gap fixture' }
phase('Work')
const pick = 'haiku'
const a = await agent('No opts at all')
const b = await agent('Dynamic model', { label: 'dyn-model', model: pick })
return { a, b }
`

// (a) out-of-range index — pinned actual: applyEdits skips the edit entirely
// (agents[99] is undefined → continue), so the result is byte-identical. Note the
// skip happens BEFORE model validation, so even an invalid model at a bad index
// does not throw — pinned deliberately.
test('applyEdits — out-of-range agent index is skipped, byte-identical', () => {
  const r = applyEdits(FIX, [{ index: 99, prompt: 'ignored', model: 'opus' }])
  assert.strictEqual(r, FIX, 'edit at unknown index must leave source byte-identical')
  // invalid model at unknown index: skipped before validation, no EDIT_INVALID
  const r2 = applyEdits(FIX, [{ index: 99, model: 'gpt-4' }])
  assert.strictEqual(r2, FIX, 'invalid model at unknown index is skipped, not thrown')
})

// (b) no-opts agent: model edit inserts a fresh opts arg after arg0.
// MUTATION-PROVED: src/editor.mjs:191 insertion text changed to drop the closing
// " }" → re-parse fails → EDIT_INVALID thrown → this test RED
// ("edited fixture must still parse"); restored via git checkout → GREEN.
test('applyEdits — model edit on no-opts agent inserts opts arg (argsInsertPos)', () => {
  const edited = applyEdits(FIX, [{ index: 0, model: 'opus' }])
  assert.doesNotThrow(() => lens.parseSource(edited), 'edited fixture must still parse')
  const lintRes = lens.lint(edited)
  assert.equal(lintRes.ok, true, 'lint failed: ' + JSON.stringify(lintRes.findings))
  assert.equal(lens.buildGraph(edited).agentNodes[0].model, 'opus',
    'buildGraph must see the inserted model')
  assert.ok(edited.includes(`agent('No opts at all', { model: "opus" })`),
    'inserted opts arg must follow arg0: got ' + edited.split('\n')[3])
})

// (c) dynamic model expression: extract pins modelExplicit=true / modelEditable=false
// and defaults the reported model to 'sonnet'; a model edit is a byte-identical no-op.
test('dynamic model expression — reported non-editable, model edit is a no-op', () => {
  const { agents } = extractEditableAgents(FIX)
  assert.equal(agents[1].modelExplicit, true, 'model prop exists → modelExplicit')
  assert.equal(agents[1].modelEditable, false, 'variable value → not editable')
  assert.equal(agents[1].model, 'sonnet', 'non-literal model reported as default sonnet')
  const r = applyEdits(FIX, [{ index: 1, model: 'opus' }])
  assert.strictEqual(r, FIX, 'model edit on dynamic-model agent must be byte-identical')
})

// (d) hostile prompt round-trip. The EDIT_INVALID re-parse guard is unreachable via
// prompt strings: JSON.stringify always yields a valid double-quoted JS string
// literal, and the splice replaces a complete Literal/TemplateLiteral node whose
// offsets came from a successful parse — so the result always re-parses. This test
// pins the strongest reachable claim: a maximally hostile prompt (quotes, backtick,
// ${}, backslash, newline) still parses and round-trips exactly.
test('applyEdits — hostile prompt string round-trips safely', () => {
  const hostile = '"; process.exit(1); //\' ` ${boom} \\ \nnewline'
  const edited = applyEdits(FIX, [{ index: 0, prompt: hostile }])
  assert.doesNotThrow(() => lens.parseSource(edited), 'hostile prompt must not break parse')
  assert.equal(extractEditableAgents(edited).agents[0].prompt, hostile,
    'hostile prompt must round-trip byte-exact through splice + re-extract')
})

// ── optimize fixtures (mirror optimize.test.mjs shape) ────────────────────────
function makeLedgerSnapshot({ calls = [], run = {} } = {}) {
  const defaultRun = {
    calls: calls.length,
    inTok: calls.reduce((s, c) => s + (c.inTok || 0), 0),
    outTok: calls.reduce((s, c) => s + (c.outTok || 0), 0),
    costUsd: calls.reduce((s, c) => s + (c.costUsd || 0), 0),
    sumMs: calls.reduce((s, c) => s + (c.ms || 0), 0),
    wallMs: calls.length ? Math.max(...calls.map(c => c.endMs || 0)) - Math.min(...calls.map(c => c.startMs || 0)) : 0,
    speedup: 1,
    concurrencySavingMs: 0,
  }
  return { calls, perPhase: [], run: { ...defaultRun, ...run } }
}

// (e) cost-router: >=2 same-tier non-haiku calls → router suggestion, cites grounded.
// MUTATION-PROVED: src/optimize.mjs:38 `sameTierCount >= 2` → `>= 3` → this test RED
// ("cost-router suggestion present for 2 sonnet calls"); restored → GREEN.
test('deriveOptimizations — 2 same-tier sonnet calls emit cost-router with grounded cites', () => {
  const calls = [
    { id: 1, label: 'draft', tier: 'sonnet', model: 'sonnet', costUsd: 0.0009, ms: 1500,
      inTok: 200, outTok: 80, requestId: 'req-router-01', startMs: 0, endMs: 1500 },
    { id: 2, label: 'polish', tier: 'sonnet', model: 'sonnet', costUsd: 0.0004, ms: 900,
      inTok: 120, outTok: 40, requestId: 'req-router-02', startMs: 1500, endMs: 2400 },
  ]
  const snap = makeLedgerSnapshot({ calls })
  const { suggestions } = deriveOptimizations(snap)

  const routerSug = suggestions.find(s => s.kind === 'cost-router')
  assert.ok(routerSug, 'cost-router suggestion present for 2 sonnet calls')
  assert.deepEqual(routerSug.proposedRunBody, { useRouter: true }, 'proposes useRouter:true')
  // cites are [topCostCall.requestId, String(costUsd), String(sameTierCount)]
  assert.ok(routerSug.cites.includes('req-router-01'), 'cites the top-cost requestId')
  assert.ok(routerSug.cites.includes('0.0009'), 'cites the top cost value')
  assert.ok(routerSug.cites.includes('2'), 'cites the same-tier count')
  const corpus = JSON.stringify(snap)
  for (const cite of routerSug.cites) {
    assert.ok(corpus.includes(String(cite)), `router cite "${cite}" grounded in ledger`)
  }
})

// (f) parallelism: actual trigger pinned from src/optimize.mjs:85 —
// run.concurrencySavingMs > 0 && run.speedup < 1.5 && calls.length >= 3
// (i.e. SOME overlap existed but the speedup was still low).
test('deriveOptimizations — low speedup with >=3 calls emits parallelism suggestion', () => {
  const calls = [
    { id: 1, label: 'p1', tier: 'haiku', model: 'haiku', costUsd: 0.00001, ms: 1000,
      inTok: 10, outTok: 3, requestId: 'req-p1', startMs: 0, endMs: 1000 },
    { id: 2, label: 'p2', tier: 'haiku', model: 'haiku', costUsd: 0.00001, ms: 1000,
      inTok: 10, outTok: 3, requestId: 'req-p2', startMs: 1000, endMs: 2000 },
    { id: 3, label: 'p3', tier: 'haiku', model: 'haiku', costUsd: 0.00001, ms: 1000,
      inTok: 10, outTok: 3, requestId: 'req-p3', startMs: 1900, endMs: 2900 },
  ]
  const snap = makeLedgerSnapshot({
    calls,
    run: { wallMs: 2900, sumMs: 3000, speedup: 1.03, concurrencySavingMs: 100 },
  })
  const { suggestions } = deriveOptimizations(snap)

  const parSug = suggestions.find(s => s.kind === 'parallelism')
  assert.ok(parSug, 'parallelism suggestion present when speedup < 1.5 with saving > 0')
  // cites pinned from code: [String(speedup), String(wallMs), String(sumMs)]
  assert.deepEqual(parSug.cites, ['1.03', '2900', '3000'], 'cites speedup/wall/sum verbatim')
  assert.deepEqual(parSug.proposedRunBody, {}, 'informational only — empty proposedRunBody')
  // boundary: speedup exactly 1.5 must NOT trigger
  const snapAt = makeLedgerSnapshot({
    calls, run: { wallMs: 2000, sumMs: 3000, speedup: 1.5, concurrencySavingMs: 1000 },
  })
  assert.equal(deriveOptimizations(snapAt).suggestions.find(s => s.kind === 'parallelism'),
    undefined, 'speedup === 1.5 is below the strict < 1.5 trigger')
})

// (g-1) ledger entries with NO label field: keys fall back to `call-${id}` — unique
// ids mean no duplicates, so no gate-cache and no crash.
test('deriveOptimizations — label-less entries with unique ids do not crash', () => {
  const calls = [
    { id: 1, tier: 'haiku', costUsd: 0.00001, ms: 100, requestId: 'r1', startMs: 0, endMs: 100 },
    { id: 2, tier: 'haiku', costUsd: 0.00001, ms: 100, requestId: 'r2', startMs: 100, endMs: 200 },
  ]
  const { suggestions } = deriveOptimizations(makeLedgerSnapshot({ calls }))
  assert.equal(suggestions.find(s => s.kind === 'gate-cache'), undefined,
    'call-${id} fallback keys are unique → no gate-cache')
})

// (g-2) BUG: snapshot with duplicate labels but run === undefined crashes.
// src/optimize.mjs:64 `String(run.calls)` in the gate-cache cites dereferences `run`
// unguarded (cap-budget and parallelism both check `run &&`; gate-cache does not).
// Reproduced: deriveOptimizations({ calls: [{label:'dup',...},{label:'dup',...}],
// run: undefined }) → TypeError: Cannot read properties of undefined (reading 'calls').
// Per ground rules: NOT fixed, test commented out, recorded in bugsFound.
// test('deriveOptimizations — duplicate labels with undefined run must not crash', () => {
//   const calls = [
//     { id: 1, label: 'dup', tier: 'haiku', costUsd: 0.00001, requestId: 'r1' },
//     { id: 2, label: 'dup', tier: 'haiku', costUsd: 0.00001, requestId: 'r2' },
//   ]
//   assert.doesNotThrow(() => deriveOptimizations({ calls, run: undefined }))
// })
